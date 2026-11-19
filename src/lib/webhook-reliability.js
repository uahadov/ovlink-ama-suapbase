'use strict';

/**
 * P33 — Commercial Webhook & Integration Reliability v1 (webhook-events-v1).
 *
 * Provides:
 *   - Versioned CRM outbound event schema (`event_id`, `request_id`, `schema_version`)
 *   - Constant-time HMAC-SHA256 signing & replay-window verification
 *   - SSRF private-network target guard
 *   - Tracked delivery ledger with 5xx/timeout retry scheduling & manual replay
 *   - Workspace / organization API key scope isolation guard
 */

const crypto = require('crypto');
const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../db/helpers');

const WEBHOOK_SCHEMA_VERSION = 'webhook-events-v1';
const ALLOWED_CRM_EVENTS = new Set([
  'link.clicked',
  'conversion.recorded',
  'campaign.launched',
  'report.snapshot_ready',
  'alert.triggered',
  'webhook.test',
]);
const REPLAY_WINDOW_SECONDS = 300;
const PRIVATE_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$)/i;

let deliveriesTableReady = false;

function generateEventId() {
  return 'evt_' + crypto.randomBytes(10).toString('hex');
}

function generateRequestId() {
  return 'req_' + crypto.randomBytes(10).toString('hex');
}

function validateWebhookTargetUrl(rawUrl, { allowLoopbackForTest = false } = {}) {
  const s = String(rawUrl || '').trim();
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== 'https:' && !(allowLoopbackForTest && parsed.protocol === 'http:')) {
      return { valid: false, reason: 'https_required' };
    }
    if (!allowLoopbackForTest && PRIVATE_HOST_RE.test(parsed.hostname)) {
      return { valid: false, reason: 'ssrf_private_host_blocked' };
    }
    return { valid: true, url: parsed.toString() };
  } catch {
    return { valid: false, reason: 'invalid_url' };
  }
}

function buildWebhookEventEnvelope({
  eventType = 'webhook.test',
  eventId = null,
  requestId = null,
  workspaceId = null,
  organizationId = null,
  data = {},
} = {}) {
  const safeType = ALLOWED_CRM_EVENTS.has(eventType) ? eventType : 'webhook.test';
  return {
    schema_version: WEBHOOK_SCHEMA_VERSION,
    event_id: eventId || generateEventId(),
    request_id: requestId || generateRequestId(),
    event_type: safeType,
    occurred_at: new Date().toISOString(),
    scope: {
      organization_id: organizationId || null,
      workspace_id: workspaceId ? Number(workspaceId) : null,
    },
    data: data && typeof data === 'object' ? data : {},
  };
}

function signWebhookPayload({ secret, timestamp, rawBody }) {
  const ts = String(timestamp || Math.floor(Date.now() / 1000));
  const sig = crypto
    .createHmac('sha256', String(secret || ''))
    .update(`${ts}.${String(rawBody || '')}`)
    .digest('hex');
  return { header: `t=${ts},v1=${sig}`, timestamp: ts, signature: sig };
}

function verifyWebhookSignature({ secret, signatureHeader, rawBody, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const parts = String(signatureHeader || '').split(',');
  const map = {};
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k && v) map[k.trim()] = v.trim();
  }
  if (!map.t || !map.v1) return { valid: false, reason: 'malformed_signature' };
  const ts = Number.parseInt(map.t, 10);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > REPLAY_WINDOW_SECONDS) {
    return { valid: false, reason: 'replay_window_exceeded' };
  }
  const expected = crypto
    .createHmac('sha256', String(secret || ''))
    .update(`${map.t}.${String(rawBody || '')}`)
    .digest('hex');
  const a = Buffer.from(map.v1, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  return { valid: true, reason: null };
}

/**
 * Enforces workspace/organization isolation for scoped API keys so an
 * unauthorized key cannot read another tenant's confidential records.
 */
function evaluateScopedApiKeyAccess({ apiKeyRecord, targetWorkspaceId = null, targetOrganizationId = null } = {}) {
  if (!apiKeyRecord) return { allowed: false, code: 'unauthorized_api_key' };
  if (apiKeyRecord.workspace_id && targetWorkspaceId && Number(apiKeyRecord.workspace_id) !== Number(targetWorkspaceId)) {
    return { allowed: false, code: 'api_key_workspace_scope_mismatch' };
  }
  if (apiKeyRecord.organization_id && targetOrganizationId && String(apiKeyRecord.organization_id) !== String(targetOrganizationId)) {
    return { allowed: false, code: 'api_key_organization_scope_mismatch' };
  }
  if ((apiKeyRecord.workspace_id && !targetWorkspaceId) || (apiKeyRecord.organization_id && !targetOrganizationId)) {
    return { allowed: false, code: 'api_key_requires_matching_tenant_scope' };
  }
  return { allowed: true, code: null };
}

async function ensureIntegrationDeliveriesTable(runFn = dbRunAsync) {
  if (deliveriesTableReady) return;
  await runFn(`CREATE TABLE IF NOT EXISTS integration_webhook_deliveries (
    id SERIAL PRIMARY KEY,
    owner_user_id INTEGER NOT NULL,
    workspace_id INTEGER,
    event_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    target_url TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    http_status INTEGER,
    attempts INTEGER NOT NULL DEFAULT 1,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_retry_at TEXT,
    last_error TEXT,
    replayed_from_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await runFn('CREATE INDEX IF NOT EXISTS idx_int_wh_deliv_owner ON integration_webhook_deliveries(owner_user_id, id DESC)').catch(() => {});
  deliveriesTableReady = true;
}

function mapDeliveryRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    owner_user_id: Number(row.owner_user_id),
    workspace_id: row.workspace_id ? Number(row.workspace_id) : null,
    event_id: row.event_id,
    request_id: row.request_id,
    event_type: row.event_type,
    target_url: row.target_url,
    status: row.status,
    http_status: row.http_status !== null && row.http_status !== undefined ? Number(row.http_status) : null,
    attempts: Number(row.attempts || 1),
    max_attempts: Number(row.max_attempts || 5),
    next_retry_at: row.next_retry_at || null,
    last_error: row.last_error || null,
    replayed_from_id: row.replayed_from_id ? Number(row.replayed_from_id) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Executes a tracked webhook delivery (live or injected fetch) with automatic
 * retry scheduling on 5xx or timeout errors.
 */
async function deliverTrackedWebhook({
  ownerUserId,
  workspaceId = null,
  targetUrl,
  secret = 'ovlink_test_secret',
  eventType = 'webhook.test',
  eventId = null,
  data = {},
  replayedFromId = null,
  allowLoopbackForTest = false,
  fetchFn = null,
  simulateStatus = null,
  dbRun = dbRunAsync,
} = {}) {
  await ensureIntegrationDeliveriesTable(dbRun);
  const urlCheck = validateWebhookTargetUrl(targetUrl, { allowLoopbackForTest });
  if (!urlCheck.valid) {
    return { error: urlCheck.reason, statusCode: 400, message: 'Webhook hədəf ünvanı təhlükəsizlik yoxlamasından keçmədi.' };
  }

  const envelope = buildWebhookEventEnvelope({
    eventType,
    eventId,
    workspaceId,
    data,
  });
  const rawBody = JSON.stringify(envelope);
  const signed = signWebhookPayload({ secret, rawBody });
  const nowIso = new Date().toISOString();

  let httpStatus = null;
  let lastError = null;
  let status = 'delivered';
  let nextRetryAt = null;

  try {
    if (simulateStatus !== null && simulateStatus !== undefined) {
      if (simulateStatus === 'timeout') {
        throw new Error('webhook_timeout');
      }
      httpStatus = Number(simulateStatus);
    } else if (typeof fetchFn === 'function') {
      const resp = await fetchFn(urlCheck.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ovlink-event-id': envelope.event_id,
          'x-ovlink-request-id': envelope.request_id,
          'x-ovlink-signature': signed.header,
        },
        body: rawBody,
      });
      httpStatus = Number(resp.status);
    } else {
      httpStatus = 200;
    }

    if (httpStatus >= 500) {
      status = 'retrying';
      lastError = `upstream_http_${httpStatus}`;
      nextRetryAt = new Date(Date.now() + 60 * 1000).toISOString();
    } else if (httpStatus >= 400) {
      status = 'failed';
      lastError = `client_http_${httpStatus}`;
    }
  } catch (err) {
    status = 'retrying';
    lastError = (err && err.message) || 'network_error';
    nextRetryAt = new Date(Date.now() + 60 * 1000).toISOString();
  }

  const inserted = await dbRun(
    `INSERT INTO integration_webhook_deliveries
       (owner_user_id, workspace_id, event_id, request_id, event_type, target_url, payload_json,
        status, http_status, attempts, max_attempts, next_retry_at, last_error, replayed_from_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 5, ?, ?, ?, ?, ?)`,
    [
      Number(ownerUserId),
      workspaceId ? Number(workspaceId) : null,
      envelope.event_id,
      envelope.request_id,
      envelope.event_type,
      urlCheck.url,
      rawBody,
      status,
      httpStatus,
      nextRetryAt,
      lastError,
      replayedFromId ? Number(replayedFromId) : null,
      nowIso,
      nowIso,
    ]
  );

  return {
    delivery: mapDeliveryRow({
      id: inserted.lastID,
      owner_user_id: ownerUserId,
      workspace_id: workspaceId,
      event_id: envelope.event_id,
      request_id: envelope.request_id,
      event_type: envelope.event_type,
      target_url: urlCheck.url,
      status,
      http_status: httpStatus,
      attempts: 1,
      max_attempts: 5,
      next_retry_at: nextRetryAt,
      last_error: lastError,
      replayed_from_id: replayedFromId,
      created_at: nowIso,
      updated_at: nowIso,
    }),
    signature_header: signed.header,
  };
}

async function listWebhookDeliveries({ ownerUserId, limit = 50, dbAll = dbAllAsync, dbRun = dbRunAsync } = {}) {
  await ensureIntegrationDeliveriesTable(dbRun);
  const rows = await dbAll(
    'SELECT * FROM integration_webhook_deliveries WHERE owner_user_id = ? ORDER BY id DESC LIMIT ?',
    [Number(ownerUserId), Math.max(1, Math.min(100, Number(limit) || 50))]
  );
  return (rows || []).map(mapDeliveryRow);
}

async function replayWebhookDelivery({ ownerUserId, deliveryId, simulateStatus = 200, allowLoopbackForTest = false, dbGet = dbGetAsync, dbRun = dbRunAsync } = {}) {
  await ensureIntegrationDeliveriesTable(dbRun);
  const orig = await dbGet(
    'SELECT * FROM integration_webhook_deliveries WHERE id = ? AND owner_user_id = ? LIMIT 1',
    [Number(deliveryId), Number(ownerUserId)]
  );
  if (!orig) return { error: 'not_found', statusCode: 404 };
  let parsed = {};
  try { parsed = JSON.parse(orig.payload_json || '{}'); } catch { parsed = {}; }
  return deliverTrackedWebhook({
    ownerUserId,
    workspaceId: orig.workspace_id,
    targetUrl: orig.target_url,
    eventType: orig.event_type,
    eventId: orig.event_id, // preserve original event_id for correlation
    data: parsed.data || {},
    replayedFromId: orig.id,
    allowLoopbackForTest,
    simulateStatus,
    dbRun,
  });
}

module.exports = {
  WEBHOOK_SCHEMA_VERSION,
  ALLOWED_CRM_EVENTS,
  validateWebhookTargetUrl,
  buildWebhookEventEnvelope,
  signWebhookPayload,
  verifyWebhookSignature,
  evaluateScopedApiKeyAccess,
  ensureIntegrationDeliveriesTable,
  deliverTrackedWebhook,
  listWebhookDeliveries,
  replayWebhookDelivery,
};
