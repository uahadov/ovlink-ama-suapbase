'use strict';

/**
 * Conversion Event Ingestion v1 (P21).
 *
 * Accepts authorized server-to-server (and proxied JS SDK) conversion events
 * such as `lead` and `purchase` with strict schema validation, timestamp-window
 * checks, optional HMAC-SHA256 request signatures, consent enforcement,
 * deterministic replay/idempotency (`event_id`), and audit logging.
 */

const crypto = require('crypto');
const { dbGetAsync, dbAllAsync, dbRunAsync, withTransaction } = require('../db/helpers');
const { GOAL_PATTERN } = require('./analytics');
const { WEBHOOK_HASH_KEY_MATERIAL } = require('../config/index');

const EVENT_ID_PATTERN = /^[A-Za-z0-9._:-]{4,120}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ALLOWED_SOURCES = Object.freeze(['server_api', 'js_sdk', 'webhook', 'checkout', 'crm']);
const ALLOWED_CONSENT_MODES = Object.freeze(['analytics', 'essential', 'declined']);
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PAST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SIGNATURE_MAX_SKEW_SEC = 300; // 5 minutes
const MAX_VALUE_AMOUNT = 1000000000;
const CONVERSION_DDL_LOCK_KEY = 21212026;

let conversionTableEnsured = false;

async function ensureConversionEventsTable() {
  if (conversionTableEnsured) return;
  await withTransaction(async (tx) => {
    await tx.run('SELECT pg_advisory_xact_lock(?)', [CONVERSION_DDL_LOCK_KEY]);
    await tx.run(`CREATE TABLE IF NOT EXISTS conversion_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      url_id INTEGER NOT NULL,
      campaign_id INTEGER,
      goal TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'server_api',
      consent_mode TEXT NOT NULL DEFAULT 'analytics',
      value_amount REAL,
      value_currency TEXT,
      actor_hash TEXT,
      signature_verified INTEGER NOT NULL DEFAULT 0,
      payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, event_id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(url_id) REFERENCES urls(id)
    )`);
    await tx.run('CREATE INDEX IF NOT EXISTS idx_conversion_events_user_created ON conversion_events(user_id, created_at DESC)');
    await tx.run('CREATE INDEX IF NOT EXISTS idx_conversion_events_url_occurred ON conversion_events(url_id, occurred_at DESC)');
    await tx.run('CREATE INDEX IF NOT EXISTS idx_conversion_events_campaign_occurred ON conversion_events(campaign_id, occurred_at DESC)');
  });
  conversionTableEnsured = true;
}

function hashActorIdentifier(rawActor) {
  const value = (rawActor === null || rawActor === undefined ? '' : rawActor).toString().trim();
  if (!value) return null;
  const material = (WEBHOOK_HASH_KEY_MATERIAL || 'ovlink-conversion-actor-fallback').toString();
  return crypto.createHmac('sha256', material).update(`actor:${value.slice(0, 256)}`).digest('hex');
}

function computeConversionSignature({ secret, timestampSec, rawBody }) {
  const ts = String(timestampSec || '').trim();
  const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {});
  const digest = crypto.createHmac('sha256', String(secret || '')).update(`${ts}.${bodyStr}`).digest('hex');
  return `sha256=${digest}`;
}

function verifyConversionSignature({ secret, timestampHeader, signatureHeader, rawBody, nowMs = Date.now() }) {
  const sig = (signatureHeader || '').toString().trim();
  const tsRaw = (timestampHeader || '').toString().trim();
  if (!sig && !tsRaw) return { present: false, valid: true, reason: null };
  if (!sig || !tsRaw) return { present: true, valid: false, reason: 'missing_signature_or_timestamp' };
  if (!secret) return { present: true, valid: false, reason: 'signing_secret_unavailable' };

  const tsSec = Number.parseInt(tsRaw, 10);
  if (!Number.isFinite(tsSec) || tsSec <= 0) {
    return { present: true, valid: false, reason: 'invalid_signature_timestamp' };
  }
  const skewSec = Math.abs(Math.floor(nowMs / 1000) - tsSec);
  if (skewSec > SIGNATURE_MAX_SKEW_SEC) {
    return { present: true, valid: false, reason: 'signature_timestamp_out_of_window' };
  }

  const expected = computeConversionSignature({ secret, timestampSec: tsSec, rawBody });
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { present: true, valid: false, reason: 'signature_mismatch' };
  }
  return { present: true, valid: true, reason: null };
}

function buildCanonicalPayloadHash(normalized, clientTimestamp = null) {
  const canonical = JSON.stringify({
    event_id: normalized.event_id,
    short: normalized.short || null,
    link_id: normalized.link_id || null,
    campaign_id: normalized.campaign_id || null,
    goal: normalized.goal,
    client_timestamp: clientTimestamp,
    source: normalized.source,
    consent_mode: normalized.consent_mode,
    value_amount: normalized.value_amount,
    value_currency: normalized.value_currency,
    actor_hash: normalized.actor_hash,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function validateConversionEventPayload(body, { now = new Date() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object.', field: 'body' };
  }

  const eventId = (body.event_id || '').toString().trim();
  if (!EVENT_ID_PATTERN.test(eventId)) {
    return {
      ok: false,
      error: 'event_id is required (4-120 chars: letters, digits, ., _, :, -).',
      field: 'event_id',
    };
  }

  const short = (body.short || body.link_short || '').toString().trim();
  const linkIdRaw = body.link_id !== undefined && body.link_id !== null ? Number.parseInt(body.link_id, 10) : null;
  const linkId = Number.isInteger(linkIdRaw) && linkIdRaw > 0 ? linkIdRaw : null;
  if (!short && !linkId) {
    return { ok: false, error: 'Either short or link_id is required.', field: 'short' };
  }

  let campaignId = null;
  if (body.campaign_id !== undefined && body.campaign_id !== null && body.campaign_id !== '') {
    const parsedCampaign = Number.parseInt(body.campaign_id, 10);
    if (!Number.isInteger(parsedCampaign) || parsedCampaign <= 0) {
      return { ok: false, error: 'campaign_id must be a positive integer.', field: 'campaign_id' };
    }
    campaignId = parsedCampaign;
  }

  const goal = (body.goal || '').toString().trim().toLowerCase();
  if (!GOAL_PATTERN.test(goal)) {
    return {
      ok: false,
      error: 'goal is required (1-40 lowercase alphanumeric, underscore or hyphen chars, e.g. lead, purchase).',
      field: 'goal',
    };
  }

  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const rawTs = body.timestamp !== undefined && body.timestamp !== null && body.timestamp !== ''
    ? body.timestamp
    : body.occurred_at;
  let occurredAtDate = new Date(nowMs);
  if (rawTs !== undefined && rawTs !== null && rawTs !== '') {
    occurredAtDate = new Date(rawTs);
    if (!Number.isFinite(occurredAtDate.getTime())) {
      return { ok: false, error: 'timestamp must be a valid ISO-8601 UTC date.', field: 'timestamp' };
    }
    if (occurredAtDate.getTime() > nowMs + MAX_FUTURE_SKEW_MS) {
      return { ok: false, error: 'timestamp cannot be more than 5 minutes in the future.', field: 'timestamp' };
    }
    if (occurredAtDate.getTime() < nowMs - MAX_PAST_WINDOW_MS) {
      return { ok: false, error: 'timestamp cannot be older than 30 days.', field: 'timestamp' };
    }
  }
  const occurredAt = occurredAtDate.toISOString();

  const source = ((body.source || 'server_api') + '').trim().toLowerCase();
  if (!ALLOWED_SOURCES.includes(source)) {
    return {
      ok: false,
      error: `source must be one of: ${ALLOWED_SOURCES.join(', ')}.`,
      field: 'source',
    };
  }

  const consentMode = ((body.consent || body.consent_mode || 'analytics') + '').trim().toLowerCase();
  if (!ALLOWED_CONSENT_MODES.includes(consentMode)) {
    return {
      ok: false,
      error: `consent must be one of: ${ALLOWED_CONSENT_MODES.join(', ')}.`,
      field: 'consent',
    };
  }

  let valueAmount = null;
  let valueCurrency = null;
  if (body.value !== undefined && body.value !== null && body.value !== '') {
    const num = Number(body.value);
    if (!Number.isFinite(num) || num < 0 || num > MAX_VALUE_AMOUNT) {
      return { ok: false, error: 'value must be a non-negative finite number.', field: 'value' };
    }
    valueAmount = Math.round(num * 100) / 100;
    const rawCur = (body.currency || '').toString().trim().toUpperCase();
    if (!CURRENCY_PATTERN.test(rawCur)) {
      return { ok: false, error: 'currency (3-letter ISO-4217, e.g. AZN, USD) is required when value is provided.', field: 'currency' };
    }
    valueCurrency = rawCur;
  } else if (body.currency !== undefined && body.currency !== null && body.currency !== '') {
    const rawCur = (body.currency || '').toString().trim().toUpperCase();
    if (!CURRENCY_PATTERN.test(rawCur)) {
      return { ok: false, error: 'currency must be a 3-letter ISO-4217 code.', field: 'currency' };
    }
    valueCurrency = rawCur;
  }

  // Actor identifier is hashed immediately; essential/declined consent never stores an actor hash.
  let actorRaw = null;
  if (body.actor && typeof body.actor === 'object') {
    actorRaw = body.actor.external_id || body.actor.visitor_id || body.actor.id || null;
  } else if (typeof body.actor === 'string' && body.actor.trim()) {
    actorRaw = body.actor.trim();
  } else if (typeof body.actor_id === 'string' && body.actor_id.trim()) {
    actorRaw = body.actor_id.trim();
  }
  const actorHash = consentMode === 'analytics' ? hashActorIdentifier(actorRaw) : null;

  const normalized = {
    event_id: eventId,
    short: short || null,
    link_id: linkId,
    campaign_id: campaignId,
    goal,
    occurred_at: occurredAt,
    source,
    consent_mode: consentMode,
    value_amount: valueAmount,
    value_currency: valueCurrency,
    actor_hash: actorHash,
  };
  const hasClientTs = rawTs !== undefined && rawTs !== null && rawTs !== '';
  normalized.payload_hash = buildCanonicalPayloadHash(normalized, hasClientTs ? occurredAt : null);

  return { ok: true, event: normalized };
}

function mapConversionEventRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    event_id: row.event_id,
    url_id: Number(row.url_id),
    short: row.short || null,
    campaign_id: row.campaign_id ? Number(row.campaign_id) : null,
    goal: row.goal,
    occurred_at: row.occurred_at,
    source: row.source,
    consent_mode: row.consent_mode,
    value: row.value_amount === null || row.value_amount === undefined ? null : Number(row.value_amount),
    currency: row.value_currency || null,
    has_actor_hash: !!row.actor_hash,
    signature_verified: Number(row.signature_verified || 0) === 1,
    created_at: row.created_at,
  };
}

/**
 * Ingests one authorized conversion event with strict ownership, consent,
 * replay/idempotency, link_conversions bridge, and audit trail.
 */
async function ingestConversionEvent({
  userId,
  body,
  signatureVerified = false,
  now = new Date(),
  auditMeta = {},
} = {}) {
  const safeUserId = Number.parseInt(userId, 10);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) {
    return { status: 401, body: { error: 'Unauthorized.' } };
  }

  const validation = validateConversionEventPayload(body, { now });
  if (!validation.ok) {
    return { status: 400, body: { error: validation.error, field: validation.field } };
  }
  const evt = validation.event;

  // Resolve target link strictly owned by the authenticated user (or their workspace).
  const linkRow = evt.link_id
    ? await dbGetAsync(
        'SELECT u.id, u.short, u.campaign_id, u.user_id FROM urls u WHERE u.id = ? AND u.user_id = ? LIMIT 1',
        [evt.link_id, safeUserId]
      )
    : await dbGetAsync(
        'SELECT u.id, u.short, u.campaign_id, u.user_id FROM urls u WHERE u.short = ? AND u.user_id = ? LIMIT 1',
        [evt.short, safeUserId]
      );

  if (!linkRow || !linkRow.id) {
    return { status: 404, body: { error: 'Target link not found for this account.' } };
  }

  const resolvedCampaignId = evt.campaign_id || (linkRow.campaign_id ? Number(linkRow.campaign_id) : null);
  if (evt.campaign_id && linkRow.campaign_id && Number(evt.campaign_id) !== Number(linkRow.campaign_id)) {
    return { status: 400, body: { error: 'campaign_id does not match the target link campaign.', field: 'campaign_id' } };
  }

  // Consent declined -> record 0 events (aligned with P19 Analytics Data Contract v1).
  if (evt.consent_mode === 'declined') {
    return {
      status: 202,
      body: {
        accepted: false,
        recorded: false,
        replayed: false,
        reason: 'consent_declined',
        event_id: evt.event_id,
      },
    };
  }

  await ensureConversionEventsTable();
  const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const day = evt.occurred_at.slice(0, 10);

  // Check for existing event_id (idempotent replay vs 409 conflict).
  const existing = await dbGetAsync(
    'SELECT e.*, u.short FROM conversion_events e JOIN urls u ON u.id = e.url_id WHERE e.user_id = ? AND e.event_id = ? LIMIT 1',
    [safeUserId, evt.event_id]
  );
  if (existing) {
    if (existing.payload_hash !== evt.payload_hash) {
      return {
        status: 409,
        body: {
          error: 'event_id was already used with a different payload.',
          code: 'conversion_event_conflict',
          event_id: evt.event_id,
        },
      };
    }
    return {
      status: 200,
      body: {
        accepted: true,
        recorded: false,
        replayed: true,
        event: mapConversionEventRow(existing),
      },
    };
  }

  // Insert conversion event atomically (handles concurrent duplicate event_id races).
  const insertRes = await dbRunAsync(
    'INSERT INTO conversion_events ' +
      '(user_id, event_id, url_id, campaign_id, goal, occurred_at, source, consent_mode, value_amount, value_currency, actor_hash, signature_verified, payload_hash, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (user_id, event_id) DO NOTHING',
    [
      safeUserId,
      evt.event_id,
      linkRow.id,
      resolvedCampaignId,
      evt.goal,
      evt.occurred_at,
      evt.source,
      evt.consent_mode,
      evt.value_amount,
      evt.value_currency,
      evt.actor_hash,
      signatureVerified ? 1 : 0,
      evt.payload_hash,
      createdAt,
    ]
  );

  if (!insertRes || !insertRes.changes) {
    const raced = await dbGetAsync(
      'SELECT e.*, u.short FROM conversion_events e JOIN urls u ON u.id = e.url_id WHERE e.user_id = ? AND e.event_id = ? LIMIT 1',
      [safeUserId, evt.event_id]
    );
    if (raced && raced.payload_hash !== evt.payload_hash) {
      return {
        status: 409,
        body: { error: 'event_id was already used with a different payload.', code: 'conversion_event_conflict', event_id: evt.event_id },
      };
    }
    return {
      status: 200,
      body: { accepted: true, recorded: false, replayed: true, event: mapConversionEventRow(raced) },
    };
  }

  // Bridge into existing link_conversions + link_stats_daily so campaign/link KPIs reflect server conversions immediately.
  const bridgeKey = evt.actor_hash || `evt:${evt.event_id}`;
  const bridgeInsert = await dbRunAsync(
    'INSERT INTO link_conversions (url_id, goal, day, ip_hash, created_at, variant) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (url_id, goal, day, ip_hash) DO NOTHING',
    [linkRow.id, evt.goal, day, bridgeKey, evt.occurred_at, null]
  ).catch(() => null);

  if (bridgeInsert && bridgeInsert.changes) {
    await dbRunAsync(
      'INSERT INTO link_stats_daily (url_id, day, clicks, conversions, first_click_at, last_click_at) VALUES (?, ?, 0, 1, ?, ?) ' +
        'ON CONFLICT (url_id, day) DO UPDATE SET conversions = link_stats_daily.conversions + EXCLUDED.conversions',
      [linkRow.id, day, evt.occurred_at, evt.occurred_at]
    ).catch(() => {});
  }

  // Record in analytics_audit_log so demo lead & purchase events are auditable.
  const auditDetail = JSON.stringify({
    event_id: evt.event_id,
    campaign_id: resolvedCampaignId,
    goal: evt.goal,
    source: evt.source,
    consent_mode: evt.consent_mode,
    value: evt.value_amount,
    currency: evt.value_currency,
    signature_verified: !!signatureVerified,
  });
  await dbRunAsync(
    'INSERT INTO analytics_audit_log (created_at, user_id, api_key_id, url_id, short, action, ip_hash, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      createdAt,
      safeUserId,
      auditMeta.apiKeyId || null,
      linkRow.id,
      linkRow.short,
      'conversion.event.ingested',
      null,
      auditDetail,
    ]
  ).catch(() => {});

  const stored = await dbGetAsync(
    'SELECT e.*, u.short FROM conversion_events e JOIN urls u ON u.id = e.url_id WHERE e.user_id = ? AND e.event_id = ? LIMIT 1',
    [safeUserId, evt.event_id]
  );

  return {
    status: 201,
    body: {
      accepted: true,
      recorded: true,
      replayed: false,
      event: mapConversionEventRow(stored),
    },
  };
}

async function listConversionEvents({ userId, short, campaignId, goal, limit = 50 } = {}) {
  const safeUserId = Number.parseInt(userId, 10);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) return [];
  await ensureConversionEventsTable();

  const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 50));
  const clauses = ['e.user_id = ?'];
  const params = [safeUserId];

  if (short && typeof short === 'string' && short.trim()) {
    clauses.push('u.short = ?');
    params.push(short.trim());
  }
  if (campaignId !== undefined && campaignId !== null && campaignId !== '') {
    const cid = Number.parseInt(campaignId, 10);
    if (Number.isInteger(cid) && cid > 0) {
      clauses.push('e.campaign_id = ?');
      params.push(cid);
    }
  }
  if (goal && typeof goal === 'string' && GOAL_PATTERN.test(goal.trim().toLowerCase())) {
    clauses.push('e.goal = ?');
    params.push(goal.trim().toLowerCase());
  }

  const rows = await dbAllAsync(
    'SELECT e.*, u.short FROM conversion_events e JOIN urls u ON u.id = e.url_id ' +
      `WHERE ${clauses.join(' AND ')} ORDER BY e.occurred_at DESC, e.id DESC LIMIT ?`,
    [...params, safeLimit]
  );
  return (rows || []).map(mapConversionEventRow);
}

module.exports = {
  EVENT_ID_PATTERN,
  CURRENCY_PATTERN,
  ALLOWED_SOURCES,
  ALLOWED_CONSENT_MODES,
  MAX_FUTURE_SKEW_MS,
  MAX_PAST_WINDOW_MS,
  SIGNATURE_MAX_SKEW_SEC,
  ensureConversionEventsTable,
  hashActorIdentifier,
  computeConversionSignature,
  verifyConversionSignature,
  validateConversionEventPayload,
  ingestConversionEvent,
  listConversionEvents,
};
