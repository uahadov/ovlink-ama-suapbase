const crypto = require('crypto');
const http = require('http');
const https = require('https');
const net = require('net');
const { db } = require('../db/index');
const { dbGetAsync, dbAllAsync, dbRunAsync } = require('../db/helpers');
const { isProAccessActive, getEffectivePlanForUser, PLAN_TIERS } = require('./plans');
const { normalizeLang } = require('./i18n');
const { normalizeHostName } = require('./url-helpers');
const { validateOutboundWebhookUrl } = require('./url-validator');
const { safeJsonStringify } = require('./security');

const webhookTimerMap = new Map();
const webhookInFlightSet = new Set();
const WEBHOOK_MAX_ATTEMPTS = 5;
const WEBHOOK_RETRY_BASE_MS = 30000;

function decodeWebhookSignatureV2Key(rawValue) {
  const value = (rawValue || '').toString().trim();
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = normalized.length % 4 === 0 ? 0 : (4 - (normalized.length % 4));
    const buf = Buffer.from(normalized + '='.repeat(padLen), 'base64');
    return buf && buf.length ? buf : null;
  } catch {
    return null;
  }
}

function requestWebhookWithPinnedIp(targetUrl, pinnedIp, { method = 'POST', headers = {}, body = '', timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(e);
    }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const ipFamily = net.isIP(pinnedIp);
    if (!ipFamily) {
      return reject(new Error('Invalid pinned IP'));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const port = parsed.port ? Number.parseInt(parsed.port, 10) : (isHttps ? 443 : 80);
    const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf-8');

    const req = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: port,
      path: parsed.pathname + parsed.search,
      method: method,
      headers: {
        ...headers,
        'host': parsed.host,
        'content-length': String(bodyBuffer.length),
      },
      servername: isHttps ? parsed.hostname : undefined, // Preserves TLS SNI
      signal: controller.signal,
      lookup: (_hostname, _options, callback) => {
        // Direct socket connection to pre-validated pinned IP (defeats DNS rebinding)
        callback(null, pinnedIp, ipFamily);
      },
    }, (res) => {
      clearTimeout(timer);
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          ok: (res.statusCode >= 200 && res.statusCode < 300),
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    if (bodyBuffer.length > 0) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

function isDiscordIncomingWebhookUrl(rawUrl) {
  const value = (rawUrl || '').toString().trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = normalizeHostName(parsed.hostname || '');
    if (!host) return false;
    const isDiscordHost = host === 'discord.com'
      || host.endsWith('.discord.com')
      || host === 'discordapp.com'
      || host.endsWith('.discordapp.com');
    if (!isDiscordHost) return false;
    return /\/api\/webhooks\//i.test(parsed.pathname || '');
  } catch {
    return false;
  }
}

function shortenWebhookText(rawValue, maxLen = 240) {
  const value = (rawValue || '').toString().replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 1))}…`;
}

function formatWebhookTimestampForMessage(rawIso) {
  const ms = Date.parse((rawIso || '').toString());
  if (!Number.isFinite(ms)) return '';
  const dt = new Date(ms);
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = String(dt.getUTCFullYear());
  const hh = String(dt.getUTCHours()).padStart(2, '0');
  const mi = String(dt.getUTCMinutes()).padStart(2, '0');
  const ss = String(dt.getUTCSeconds()).padStart(2, '0');
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}:${ss} UTC`;
}

function normalizeWebhookMessageLocale(rawLocale, fallback = 'auto') {
  const value = (rawLocale || '').toString().trim().toLowerCase();
  if (value === 'az' || value === 'tr' || value === 'en' || value === 'auto') {
    return value;
  }
  return fallback;
}

function normalizeWebhookMessageTemplate(rawTemplate) {
  const value = (rawTemplate || '').toString().replace(/\u0000/g, '').trim();
  if (!value) return '';
  return value.slice(0, 240);
}

function resolveWebhookMessageLocale(webhookRow) {
  const configured = normalizeWebhookMessageLocale(webhookRow && webhookRow.message_locale, 'auto');
  if (configured !== 'auto') return configured;
  return normalizeLang(webhookRow && webhookRow.user_ui_lang, 'en');
}

function getWebhookMessageLabels(locale) {
  if (locale === 'tr') {
    return {
      event: 'Ovlink etkinliği',
      deliveryId: 'Teslimat ID',
      attempt: 'Deneme',
      shortUrl: 'Kısa URL',
      originalUrl: 'Orijinal URL',
      domain: 'Alan adı',
      sentAt: 'Gönderim zamanı',
    };
  }
  if (locale === 'az') {
    return {
      event: 'Ovlink hadisəsi',
      deliveryId: 'Çatdırılma ID',
      attempt: 'Cəhd',
      shortUrl: 'Qısa URL',
      originalUrl: 'Orijinal URL',
      domain: 'Domen',
      sentAt: 'Göndərilmə vaxtı',
    };
  }
  return {
    event: 'Ovlink event',
    deliveryId: 'Delivery ID',
    attempt: 'Attempt',
    shortUrl: 'Short URL',
    originalUrl: 'Original URL',
    domain: 'Domain',
    sentAt: 'Sent at',
  };
}

function applyWebhookMessageTemplate(template, tokens) {
  const source = normalizeWebhookMessageTemplate(template);
  if (!source) return '';
  const map = tokens && typeof tokens === 'object' ? tokens : {};
  return source.replace(/\{([a-z0-9_]+)\}/gi, (full, keyRaw) => {
    const key = (keyRaw || '').toString().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(map, key)) return full;
    const value = map[key];
    return value === null || value === undefined ? '' : `${value}`;
  });
}

function buildDiscordWebhookPayload(eventPayload, webhookRow = null) {
  const payload = eventPayload && typeof eventPayload === 'object' ? eventPayload : {};
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const locale = resolveWebhookMessageLocale(webhookRow);
  const labels = getWebhookMessageLabels(locale);
  const eventName = shortenWebhookText(payload.event || 'event', 64);
  const deliveryId = Number.parseInt(payload.delivery_id || '0', 10);
  const attempt = Number.parseInt(payload.attempt || '1', 10) || 1;
  const sentAt = formatWebhookTimestampForMessage(payload.sent_at) || shortenWebhookText(payload.sent_at || '', 40);
  const shortUrl = shortenWebhookText(data.short_url || data.short || '', 280);
  const originalUrl = shortenWebhookText(data.original_url || '', 280);
  const domain = shortenWebhookText(data.domain || '', 120);

  const templateText = applyWebhookMessageTemplate(webhookRow && webhookRow.message_template, {
    event: eventName,
    delivery_id: deliveryId > 0 ? String(deliveryId) : '',
    attempt: String(attempt),
    sent_at: sentAt,
    short_url: shortUrl,
    original_url: originalUrl,
    domain: domain,
  });

  const lines = [];
  lines.push(templateText || `${labels.event}: ${eventName || 'event'}`);
  if (deliveryId > 0) lines.push(`${labels.deliveryId}: #${deliveryId}`);
  lines.push(`${labels.attempt}: ${attempt}`);
  if (shortUrl) lines.push(`${labels.shortUrl}: ${shortUrl}`);
  if (originalUrl) lines.push(`${labels.originalUrl}: ${originalUrl}`);
  if (domain) lines.push(`${labels.domain}: ${domain}`);
  if (sentAt) lines.push(`${labels.sentAt}: ${sentAt}`);

  const content = shortenWebhookText(lines.join('\n'), 1800) || 'Ovlink webhook event';
  return {
    content,
    allowed_mentions: { parse: [] },
  };
}

function normalizeWebhookEvents(raw) {
  const items = Array.isArray(raw) ? raw : (raw || '').toString().split(',');
  const unique = new Set();
  for (const item of items) {
    const value = (item || '').toString().trim().toLowerCase();
    if (!value) continue;
    if (!/^[a-z0-9._:-]{2,64}$/.test(value)) continue;
    unique.add(value);
  }
  if (!unique.size) {
    unique.add('link.created');
    unique.add('link.updated');
    unique.add('link.deleted');
    unique.add('webhook.test');
  }
  return Array.from(unique);
}

function webhookHasEvent(webhookRow, eventName) {
  const event = (eventName || '').toString().trim().toLowerCase();
  if (!event) return false;
  const events = normalizeWebhookEvents((webhookRow && webhookRow.events) || '');
  return events.includes('*') || events.includes(event);
}

function computeWebhookRetryDelayMs(nextAttemptNumber) {
  const safeAttempt = Math.max(1, Number.parseInt(nextAttemptNumber, 10) || 1);
  const delay = WEBHOOK_RETRY_BASE_MS * (2 ** Math.max(0, safeAttempt - 1));
  return Math.min(delay, 30 * 60 * 1000);
}

function scheduleWebhookProcessing(deliveryId, delayMs = 0, preloadedRow = null) {
  const safeId = Number.parseInt(deliveryId, 10);
  if (!Number.isInteger(safeId) || safeId <= 0) return;
  if (webhookTimerMap.has(safeId) || webhookInFlightSet.has(safeId)) return;
  const safeDelay = Math.max(0, Number.parseInt(delayMs, 10) || 0);
  const timer = setTimeout(() => {
    webhookTimerMap.delete(safeId);
    void deliverWebhook(safeId, preloadedRow);
  }, safeDelay);
  webhookTimerMap.set(safeId, timer);
  if (typeof timer.unref === 'function') timer.unref();
}

async function updateWebhookFailureState(webhookId, failedAtIso) {
  const now = failedAtIso || new Date().toISOString();
  await dbRunAsync(
    'UPDATE webhooks SET consecutive_failures = COALESCE(consecutive_failures, 0) + 1, last_failure_at = ?, updated_at = ? WHERE id = ?',
    [now, now, webhookId]
  );
}

async function resetWebhookFailureState(webhookId, updatedAtIso) {
  const now = updatedAtIso || new Date().toISOString();
  await dbRunAsync(
    'UPDATE webhooks SET consecutive_failures = 0, last_failure_at = NULL, updated_at = ? WHERE id = ?',
    [now, webhookId]
  );
}

async function deliverWebhook(deliveryId, preloadedRow = null) {
  const safeId = Number.parseInt(deliveryId, 10);
  if (!Number.isInteger(safeId) || safeId <= 0) return;
  if (webhookInFlightSet.has(safeId)) return;
  webhookInFlightSet.add(safeId);

  try {
    let row = preloadedRow;
    if (!row || !row.webhook_id || row.id !== safeId) {
      row = await dbGetAsync(
        'SELECT d.id, d.webhook_id, d.user_id, d.event_type, d.payload_json, d.attempt, d.status, w.url, w.secret_hash, w.signature_v2_key, w.signature_v2_enabled, w.is_active, w.message_locale, w.message_template, u.ui_lang AS user_ui_lang, u.plan_tier, u.plan_status, u.pro_expires_at ' +
        'FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id JOIN users u ON u.id = d.user_id WHERE d.id = ?',
        [safeId]
      ).catch(() => null);
    }

    if (!row) return;
    if (row.status === 'delivered' || row.status === 'failed' || row.status === 'cancelled') return;

    const plan = (row.plan_tier !== undefined && row.plan_status !== undefined)
      ? { tier: row.plan_tier || 'free', is_active: row.plan_status === 'active' && isProAccessActive(row) }
      : await getEffectivePlanForUser(row.user_id).catch(() => null);

    if (!plan || !plan.is_active || plan.tier !== PLAN_TIERS.PRO) {
      await dbRunAsync(
        'UPDATE webhook_deliveries SET status = ?, updated_at = ? WHERE id = ?',
        ['cancelled', new Date().toISOString(), safeId]
      ).catch(() => {});
      return;
    }

    if (row.is_active != 1) {
      await dbRunAsync(
        'UPDATE webhook_deliveries SET status = ?, updated_at = ? WHERE id = ?',
        ['cancelled', new Date().toISOString(), safeId]
      ).catch(() => {});
      return;
    }

    const now = new Date().toISOString();
    const attemptNumber = (Number.parseInt(row.attempt || '0', 10) || 0) + 1;
    const payload = {
      delivery_id: row.id,
      event: row.event_type,
      attempt: attemptNumber,
      sent_at: now,
      data: (() => {
        try {
          return JSON.parse((row.payload_json || '{}').toString());
        } catch {
          return {};
        }
      })(),
    };
    const isDiscordTarget = isDiscordIncomingWebhookUrl(row.url);
    const outboundPayload = isDiscordTarget ? buildDiscordWebhookPayload(payload, row) : payload;
    const body = JSON.stringify(outboundPayload);

    let httpStatus = 0;
    let responseCode = '';
    let success = false;
    let timeoutHandle = null;

    const targetValidation = await validateOutboundWebhookUrl(row.url).catch(() => ({ ok: false, reason: 'validation_error' }));
    if (!targetValidation || !targetValidation.ok) {
      const blockedNow = new Date().toISOString();
      await updateWebhookFailureState(row.webhook_id, blockedNow).catch(() => {});
      await dbRunAsync(
        'UPDATE webhook_deliveries SET attempt = ?, status = ?, http_status = ?, response_excerpt = ?, next_retry_at = NULL, last_attempt_at = ?, updated_at = ? WHERE id = ?',
        [attemptNumber, 'failed', null, 'blocked_ssrf', blockedNow, blockedNow, safeId]
      ).catch(() => {});
      return;
    }

    const targetUrl = targetValidation.normalizedUrl || row.url;
    try {
      const controller = new AbortController();
      timeoutHandle = setTimeout(() => controller.abort(), 10_000);
      const legacySig = row.secret_hash
        ? crypto.createHmac('sha256', row.secret_hash).update(body).digest('hex')
        : '';
      const signatureV2Enabled = row.signature_v2_enabled == 1;
      const signatureV2Key = signatureV2Enabled ? decodeWebhookSignatureV2Key(row.signature_v2_key) : null;
      const signatureTs = String(Math.floor(Date.now() / 1000));
      const headers = {
        'content-type': 'application/json',
        'x-ovlink-event': row.event_type,
        'x-ovlink-delivery-id': String(row.id),
        'x-ovlink-signature-ts': signatureTs,
      };
      if (legacySig) {
        headers['x-ovlink-signature'] = `sha256=${legacySig}`;
      }
      if (signatureV2Key && signatureV2Key.length) {
        const v2Body = `${signatureTs}.${body}`;
        const v2Sig = crypto.createHmac('sha256', signatureV2Key).update(v2Body).digest('hex');
        headers['x-ovlink-signature-v2'] = `sha256=${v2Sig}`;
      }
      if (isDiscordTarget) {
        headers['x-ovlink-destination'] = 'discord';
      }
      const resp = await requestWebhookWithPinnedIp(targetUrl, targetValidation.pinnedIp, {
        method: 'POST',
        headers,
        body,
        timeoutMs: 10000,
      });
      httpStatus = Number(resp.status) || 0;
      success = resp.ok;
      if (!success) {
        if (httpStatus >= 500) responseCode = 'http_5xx';
        else if (httpStatus >= 400) responseCode = 'http_4xx';
        else responseCode = 'http_error';
      }
    } catch (err) {
      responseCode = (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) ? 'timeout' : 'network_error';
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    if (success) {
      await dbRunAsync(
        'UPDATE webhook_deliveries SET attempt = ?, status = ?, http_status = ?, response_excerpt = ?, next_retry_at = NULL, last_attempt_at = ?, updated_at = ? WHERE id = ?',
        [attemptNumber, 'delivered', httpStatus || null, null, now, now, safeId]
      ).catch(() => {});
      await resetWebhookFailureState(row.webhook_id, now).catch(() => {});
      return;
    }

    await updateWebhookFailureState(row.webhook_id, now).catch(() => {});

    if (attemptNumber >= WEBHOOK_MAX_ATTEMPTS) {
      await dbRunAsync(
        'UPDATE webhook_deliveries SET attempt = ?, status = ?, http_status = ?, response_excerpt = ?, next_retry_at = NULL, last_attempt_at = ?, updated_at = ? WHERE id = ?',
        [attemptNumber, 'failed', httpStatus || null, responseCode || 'delivery_failed', now, now, safeId]
      ).catch(() => {});
      return;
    }

    const delayMs = computeWebhookRetryDelayMs(attemptNumber + 1);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    await dbRunAsync(
      'UPDATE webhook_deliveries SET attempt = ?, status = ?, http_status = ?, response_excerpt = ?, next_retry_at = ?, last_attempt_at = ?, updated_at = ? WHERE id = ?',
      [attemptNumber, 'retry_scheduled', httpStatus || null, responseCode || 'delivery_failed', nextRetryAt, now, now, safeId]
    ).catch(() => {});
    scheduleWebhookProcessing(safeId, delayMs);
  } finally {
    webhookInFlightSet.delete(safeId);
  }
}

async function queueWebhookDelivery(userId, eventType, payload = {}) {
  const safeUserId = Number.parseInt(userId, 10);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) return;
  const event = (eventType || '').toString().trim().toLowerCase();
  if (!event) return;

  const plan = await getEffectivePlanForUser(safeUserId).catch(() => null);
  if (!plan || !plan.is_active || plan.tier !== PLAN_TIERS.PRO) return;

  const hooks = await dbAllAsync(
    'SELECT id, user_id, url, events, is_active FROM webhooks WHERE user_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 100',
    [safeUserId]
  ).catch(() => []);

  if (!hooks || !hooks.length) return;
  const now = new Date().toISOString();
  const payloadJson = safeJsonStringify(payload, 6000);

  for (const hook of hooks) {
    if (!webhookHasEvent(hook, event)) continue;
    try {
      const inserted = await dbRunAsync(
        'INSERT INTO webhook_deliveries (webhook_id, user_id, event_type, payload_json, attempt, status, created_at, updated_at, next_retry_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
        [hook.id, safeUserId, event, payloadJson, 'queued', now, now, now]
      );
      if (inserted && inserted.lastID) {
        scheduleWebhookProcessing(inserted.lastID, 0);
      }
    } catch {
      // best effort
    }
  }
}

async function retryFailedWebhooks() {
  const now = new Date().toISOString();
  const pending = await dbAllAsync(
    'SELECT d.id, d.webhook_id, d.user_id, d.event_type, d.payload_json, d.attempt, d.status, d.next_retry_at, ' +
    'w.url, w.secret_hash, w.signature_v2_key, w.signature_v2_enabled, w.is_active, w.message_locale, w.message_template, ' +
    'u.ui_lang AS user_ui_lang, u.plan_tier, u.plan_status, u.pro_expires_at ' +
    'FROM webhook_deliveries d ' +
    'JOIN webhooks w ON w.id = d.webhook_id ' +
    'JOIN users u ON u.id = d.user_id ' +
    "WHERE d.status IN ('queued', 'retry_scheduled') " +
    'ORDER BY d.id ASC ' +
    'LIMIT 100',
    []
  ).catch(() => []);

  for (const row of (pending || [])) {
    const id = Number.parseInt(row.id || '0', 10);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (webhookTimerMap.has(id) || webhookInFlightSet.has(id)) continue;
    const retryMs = Date.parse(row.next_retry_at || now);
    const delay = Number.isFinite(retryMs) ? Math.max(0, retryMs - Date.now()) : 0;
    scheduleWebhookProcessing(id, delay, row);
  }
}

function scheduleWebhookRetries() {
  const timer = setInterval(() => {
    void retryFailedWebhooks();
  }, 30_000);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = {
  enqueueWebhookEventForUser: queueWebhookDelivery,
  queueWebhookDelivery,
  deliverWebhook,
  retryFailedWebhooks,
  scheduleWebhookRetries,
  scheduleWebhookRecoveryWorker: scheduleWebhookRetries,
  normalizeWebhookEvents,
  normalizeWebhookMessageLocale,
  normalizeWebhookMessageTemplate,
  webhookHasEvent,
  webhookTimerMap,
  webhookInFlightSet,
  buildDiscordWebhookPayload
};
