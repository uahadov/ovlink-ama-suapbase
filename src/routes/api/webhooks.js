const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { db } = require('../../db/index');
const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../../db/helpers');
const { encryptAES256GCM, decryptAES256GCM } = require('../../../utils/crypto');
const { pickLang, normalizeLang } = require('../../lib/i18n');
const { requireSignedIn, requireProAccess } = require('../../middleware/auth');
const { proWriteLimiter, proReadLimiter } = require('../../middleware/rate-limiter');
const {
  hashWebhookSecretValueV2,
  buildWebhookSignatureV2Key,
  logSecurityEvent
} = require('../../lib/security');
const {
  enqueueWebhookEventForUser,
  normalizeWebhookEvents,
  normalizeWebhookMessageLocale,
  normalizeWebhookMessageTemplate,
  webhookTimerMap,
  webhookInFlightSet
} = require('../../lib/webhook');
const { validateOutboundWebhookUrl } = require('../../lib/url-validator');

const PRO_WEBHOOK_MAX_ACTIVE = 10;

router.post('/api/pro/webhooks/create', requireSignedIn, proWriteLimiter, requireProAccess('webhooks.create'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const events = normalizeWebhookEvents((req.body && req.body.events) || '');
  const messageLocale = normalizeWebhookMessageLocale(req.body && req.body.message_locale, 'auto');
  const messageTemplate = normalizeWebhookMessageTemplate(req.body && req.body.message_template);

  try {
    const validation = await validateOutboundWebhookUrl(req.body && req.body.url);
    if (!validation || !validation.ok) {
      const rawUrl = ((req.body && req.body.url) || '').toString().trim().toLowerCase();
      const isBlockedTarget = validation && (validation.reason === 'blocked_ip' || validation.reason === 'blocked_host');
      const isHttpOnlyUrl = validation && validation.reason === 'invalid_url' && rawUrl.startsWith('http://');
      const reason = isBlockedTarget
        ? pickLang(uiLang, 'Webhook URL daxili/rezerv şəbəkəyə yönəlir və bloklanıb.', 'Webhook URL dahili/rezerve ağa gidiyor ve engellendi.', 'Webhook URL targets an internal/reserved network and is blocked.')
        : (isHttpOnlyUrl
          ? pickLang(uiLang, 'Webhook URL yalnız HTTPS ola bilər.', 'Webhook URL yalnızca HTTPS olabilir.', 'Webhook URL must use HTTPS.')
          : pickLang(uiLang, 'Webhook URL yanlışdır.', 'Webhook URL geçersiz.', 'Webhook URL is invalid.'));
      return res.status(400).json({ error: reason });
    }
    const webhookUrl = validation.normalizedUrl;

    const countRow = await dbGetAsync(
      'SELECT COUNT(*) AS cnt FROM webhooks WHERE user_id = ?',
      [req.session.userId]
    );
    const totalHooks = Number(countRow && countRow.cnt ? countRow.cnt : 0);
    if (totalHooks >= PRO_WEBHOOK_MAX_ACTIVE) {
      return res.status(409).json({
        error: pickLang(
          uiLang,
          `Webhook limiti dolub (${PRO_WEBHOOK_MAX_ACTIVE}).`,
          `Webhook limiti doldu (${PRO_WEBHOOK_MAX_ACTIVE}).`,
          `Webhook limit reached (${PRO_WEBHOOK_MAX_ACTIVE}).`
        ),
      });
    }

    const now = new Date().toISOString();
    const rawSecret = `whsec_${crypto.randomBytes(32).toString('base64url')}`;
    const secretHash = hashWebhookSecretValueV2(`wh|${rawSecret}`);
    const signatureV2Key = buildWebhookSignatureV2Key(rawSecret);
    const inserted = await dbRunAsync(
      'INSERT INTO webhooks (user_id, url, secret_hash, secret_hash_version, signature_v2_key, signature_v2_enabled, events, message_locale, message_template, is_active, created_at, updated_at) VALUES (?, ?, ?, 2, ?, 1, ?, ?, ?, 1, ?, ?)',
      [req.session.userId, webhookUrl, secretHash, signatureV2Key, events.join(','), messageLocale, messageTemplate || null, now, now]
    );
    logSecurityEvent(req, 'webhook.create', 'success', { user_id: req.session.userId, webhook_id: inserted.lastID });
    return res.json({
      message: pickLang(uiLang, 'Webhook əlavə edildi.', 'Webhook eklendi.', 'Webhook created.'),
      webhook_secret: rawSecret,
    });
  } catch {
    logSecurityEvent(req, 'webhook.create', 'failure', { user_id: req.session.userId });
    return res.status(500).json({ error: pickLang(uiLang, 'Webhook yaradıla bilmədi.', 'Webhook oluşturulamadı.', 'Webhook could not be created.') });
  }
});

router.post('/api/pro/webhooks/update', requireSignedIn, proWriteLimiter, requireProAccess('webhooks.update'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const webhookId = Number.parseInt((req.body && req.body.webhook_id) || '', 10);
  if (!Number.isInteger(webhookId) || webhookId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış webhook ID.', 'Geçersiz webhook ID.', 'Invalid webhook id.') });
  }

  const events = normalizeWebhookEvents((req.body && req.body.events) || '');
  const bodyObj = req.body && typeof req.body === 'object' ? req.body : {};
  const hasUrl = Object.prototype.hasOwnProperty.call(bodyObj, 'url');
  const hasEvents = Object.prototype.hasOwnProperty.call(bodyObj, 'events');
  const hasIsActive = Object.prototype.hasOwnProperty.call(bodyObj, 'is_active');
  const hasMessageLocale = Object.prototype.hasOwnProperty.call(bodyObj, 'message_locale');
  const hasMessageTemplate = Object.prototype.hasOwnProperty.call(bodyObj, 'message_template');

  try {
    const row = await dbGetAsync(
      'SELECT id, url, events, message_locale, message_template, is_active FROM webhooks WHERE id = ? AND user_id = ?',
      [webhookId, req.session.userId]
    );
    if (!row) {
      return res.status(404).json({ error: pickLang(uiLang, 'Webhook tapılmadı.', 'Webhook bulunamadı.', 'Webhook not found.') });
    }

    const nextMessageLocale = hasMessageLocale
      ? normalizeWebhookMessageLocale(bodyObj.message_locale, normalizeWebhookMessageLocale(row.message_locale, 'auto'))
      : normalizeWebhookMessageLocale(row.message_locale, 'auto');
    const nextMessageTemplate = hasMessageTemplate
      ? normalizeWebhookMessageTemplate(bodyObj.message_template)
      : (row.message_template || '');
    const nextEvents = hasEvents ? events.join(',') : (row.events || 'link.created');
    const nextIsActive = hasIsActive
      ? (parseBooleanInput(bodyObj.is_active, row.is_active == 1) ? 1 : 0)
      : (row.is_active == 1 ? 1 : 0);
    let nextUrl = row.url || '';
    if (hasUrl) {
      const validation = await validateOutboundWebhookUrl(bodyObj.url);
      if (!validation || !validation.ok) {
        const rawUrl = (bodyObj.url || '').toString().trim().toLowerCase();
        const isBlockedTarget = validation && (validation.reason === 'blocked_ip' || validation.reason === 'blocked_host');
        const isHttpOnlyUrl = validation && validation.reason === 'invalid_url' && rawUrl.startsWith('http://');
        const reason = isBlockedTarget
          ? pickLang(uiLang, 'Webhook URL daxili/rezerv şəbəkəyə yönəlir və bloklanıb.', 'Webhook URL dahili/rezerve ağa gidiyor ve engellendi.', 'Webhook URL targets an internal/reserved network and is blocked.')
          : (isHttpOnlyUrl
            ? pickLang(uiLang, 'Webhook URL yalnız HTTPS ola bilər.', 'Webhook URL yalnızca HTTPS olabilir.', 'Webhook URL must use HTTPS.')
            : pickLang(uiLang, 'Webhook URL yanlışdır.', 'Webhook URL geçersiz.', 'Webhook URL is invalid.'));
        return res.status(400).json({ error: reason });
      }
      nextUrl = validation.normalizedUrl;
    }

    await dbRunAsync(
      'UPDATE webhooks SET url = ?, events = ?, message_locale = ?, message_template = ?, is_active = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      [nextUrl, nextEvents, nextMessageLocale, nextMessageTemplate || null, nextIsActive, new Date().toISOString(), webhookId, req.session.userId]
    );
    logSecurityEvent(req, 'webhook.update', 'success', { user_id: req.session.userId, webhook_id: webhookId });
    return res.json({ message: pickLang(uiLang, 'Webhook yeniləndi.', 'Webhook güncellendi.', 'Webhook updated.') });
  } catch {
    logSecurityEvent(req, 'webhook.update', 'failure', { user_id: req.session.userId, webhook_id: webhookId });
    return res.status(500).json({ error: pickLang(uiLang, 'Webhook yenilənmədi.', 'Webhook güncellenemedi.', 'Webhook could not be updated.') });
  }
});

router.post('/api/pro/webhooks/rotate-secret', requireSignedIn, proWriteLimiter, requireProAccess('webhooks.rotate_secret'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const webhookId = Number.parseInt((req.body && req.body.webhook_id) || '', 10);
  if (!Number.isInteger(webhookId) || webhookId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış webhook ID.', 'Geçersiz webhook ID.', 'Invalid webhook id.') });
  }

  try {
    const hook = await dbGetAsync(
      'SELECT id FROM webhooks WHERE id = ? AND user_id = ?',
      [webhookId, req.session.userId]
    );
    if (!hook) {
      return res.status(404).json({ error: pickLang(uiLang, 'Webhook tapılmadı.', 'Webhook bulunamadı.', 'Webhook not found.') });
    }

    const now = new Date().toISOString();
    const rawSecret = `whsec_${crypto.randomBytes(32).toString('base64url')}`;
    const secretHash = hashWebhookSecretValueV2(`wh|${rawSecret}`);
    const signatureV2Key = buildWebhookSignatureV2Key(rawSecret);

    await dbRunAsync(
      'UPDATE webhooks SET secret_hash = ?, secret_hash_version = 2, signature_v2_key = ?, signature_v2_enabled = 1, updated_at = ? WHERE id = ? AND user_id = ?',
      [secretHash, signatureV2Key, now, webhookId, req.session.userId]
    );

    logSecurityEvent(req, 'webhook.secret.rotate', 'success', { user_id: req.session.userId, webhook_id: webhookId });
    return res.json({
      message: pickLang(uiLang, 'Webhook secret yeniləndi.', 'Webhook secret yenilendi.', 'Webhook secret rotated.'),
      webhook_secret: rawSecret,
    });
  } catch {
    logSecurityEvent(req, 'webhook.secret.rotate', 'failure', { user_id: req.session.userId, webhook_id: webhookId });
    return res.status(500).json({ error: pickLang(uiLang, 'Webhook secret yenilənmədi.', 'Webhook secret yenilenemedi.', 'Webhook secret could not be rotated.') });
  }
});

router.post('/api/pro/webhooks/delete', requireSignedIn, proWriteLimiter, requireProAccess('webhooks.delete'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const webhookId = Number.parseInt((req.body && req.body.webhook_id) || '', 10);
  if (!Number.isInteger(webhookId) || webhookId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış webhook ID.', 'Geçersiz webhook ID.', 'Invalid webhook id.') });
  }

  try {
    const result = await dbRunAsync('DELETE FROM webhooks WHERE id = ? AND user_id = ?', [webhookId, req.session.userId]);
    if (!result || !result.changes) {
      return res.status(404).json({ error: pickLang(uiLang, 'Webhook tapılmadı.', 'Webhook bulunamadı.', 'Webhook not found.') });
    }
    await dbRunAsync('UPDATE webhook_deliveries SET status = ?, updated_at = ? WHERE webhook_id = ? AND status IN (?, ?)', ['cancelled', new Date().toISOString(), webhookId, 'queued', 'retry_scheduled']).catch(() => {});
    logSecurityEvent(req, 'webhook.delete', 'success', { user_id: req.session.userId, webhook_id: webhookId });
    return res.json({ message: pickLang(uiLang, 'Webhook silindi.', 'Webhook silindi.', 'Webhook deleted.') });
  } catch {
    logSecurityEvent(req, 'webhook.delete', 'failure', { user_id: req.session.userId, webhook_id: webhookId });
    return res.status(500).json({ error: pickLang(uiLang, 'Webhook silinmədi.', 'Webhook silinemedi.', 'Webhook could not be deleted.') });
  }
});

router.post('/api/pro/webhooks/test', requireSignedIn, proWriteLimiter, requireProAccess('webhooks.test'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const webhookId = Number.parseInt((req.body && req.body.webhook_id) || '', 10);
  if (!Number.isInteger(webhookId) || webhookId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış webhook ID.', 'Geçersiz webhook ID.', 'Invalid webhook id.') });
  }

  try {
    const hook = await dbGetAsync(
      'SELECT id, user_id, events, is_active FROM webhooks WHERE id = ? AND user_id = ?',
      [webhookId, req.session.userId]
    );
    if (!hook) {
      return res.status(404).json({ error: pickLang(uiLang, 'Webhook tapılmadı.', 'Webhook bulunamadı.', 'Webhook not found.') });
    }
    if (hook.is_active != 1) {
      return res.status(400).json({ error: pickLang(uiLang, 'Webhook passivdir.', 'Webhook pasif.', 'Webhook is inactive.') });
    }
    if (!webhookHasEvent(hook, 'webhook.test')) {
      return res.status(400).json({
        error: pickLang(
          uiLang,
          "Bu webhook üçün 'webhook.test' eventi aktiv deyil.",
          "Bu webhook için 'webhook.test' etkinliği aktif değil.",
          "This webhook does not have 'webhook.test' enabled."
        ),
      });
    }

    const now = new Date().toISOString();
    const payloadJson = safeJsonStringify({
      source: 'manual_test',
      by_user_id: req.session.userId,
      generated_at: now,
    });

    const inserted = await dbRunAsync(
      'INSERT INTO webhook_deliveries (webhook_id, user_id, event_type, payload_json, attempt, status, created_at, updated_at, next_retry_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
      [webhookId, req.session.userId, 'webhook.test', payloadJson, 'queued', now, now, now]
    );
    scheduleWebhookProcessing(inserted.lastID, 0);
    logSecurityEvent(req, 'webhook.test', 'success', { user_id: req.session.userId, webhook_id: webhookId });
    return res.json({ message: pickLang(uiLang, 'Test göndərildi.', 'Test gönderildi.', 'Test delivery queued.') });
  } catch {
    logSecurityEvent(req, 'webhook.test', 'failure', { user_id: req.session.userId, webhook_id: webhookId });
    return res.status(500).json({ error: pickLang(uiLang, 'Test göndərilə bilmədi.', 'Test gönderilemedi.', 'Test could not be queued.') });
  }
});

router.post('/api/pro/webhooks/replay', requireSignedIn, proWriteLimiter, requireProAccess('webhooks.replay'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const deliveryId = Number.parseInt((req.body && req.body.delivery_id) || '', 10);
  if (!Number.isInteger(deliveryId) || deliveryId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış çatdırılma ID.', 'Geçersiz teslimat ID.', 'Invalid delivery id.') });
  }

  try {
    const delivery = await dbGetAsync(
      'SELECT id, webhook_id, user_id, status FROM webhook_deliveries WHERE id = ? AND user_id = ? LIMIT 1',
      [deliveryId, req.session.userId]
    );
    if (!delivery) {
      return res.status(404).json({ error: pickLang(uiLang, 'Çatdırılma tapılmadı.', 'Teslimat bulunamadı.', 'Delivery not found.') });
    }

    const hook = await dbGetAsync(
      'SELECT id, is_active FROM webhooks WHERE id = ? AND user_id = ? LIMIT 1',
      [delivery.webhook_id, req.session.userId]
    );
    if (!hook) {
      return res.status(404).json({ error: pickLang(uiLang, 'Webhook tapılmadı.', 'Webhook bulunamadı.', 'Webhook not found.') });
    }
    if (hook.is_active != 1) {
      return res.status(400).json({ error: pickLang(uiLang, 'Webhook passivdir.', 'Webhook pasif.', 'Webhook is inactive.') });
    }

    const now = new Date().toISOString();
    await dbRunAsync(
      'UPDATE webhook_deliveries SET attempt = 0, status = ?, http_status = NULL, response_excerpt = NULL, next_retry_at = ?, last_attempt_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?',
      ['queued', now, now, deliveryId, req.session.userId]
    );
    scheduleWebhookProcessing(deliveryId, 0);
    logSecurityEvent(req, 'webhook.delivery.replay', 'success', { user_id: req.session.userId, webhook_id: delivery.webhook_id, delivery_id: deliveryId });
    return res.json({ message: pickLang(uiLang, 'Çatdırılma yenidən növbəyə alındı.', 'Teslimat yeniden kuyruğa alındı.', 'Delivery replay queued.') });
  } catch {
    logSecurityEvent(req, 'webhook.delivery.replay', 'failure', { user_id: req.session.userId, delivery_id: deliveryId });
    return res.status(500).json({ error: pickLang(uiLang, 'Çatdırılma təkrar oluna bilmədi.', 'Teslimat tekrar başlatılamadı.', 'Delivery replay failed.') });
  }
});
module.exports = router;
