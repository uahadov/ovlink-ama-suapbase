'use strict';

const { beat } = require('./worker-heartbeat');

/**
 * Analytics access log ("who looked at this report?").
 *
 * Reading statistics is a read, so a naive one-INSERT-per-view would let a
 * dashboard with 30 refreshes multiply writes. This module therefore:
 *   - dedupes the same (actor, action, link) for 5 minutes,
 *   - buffers rows in memory and flushes them as one multi-row INSERT,
 *   - drops instead of growing without bound, and reports the drop count.
 *
 * Nothing here is ever awaited by a request handler, and no raw IP is stored.
 */

const { dbRunAsync, dbAllAsync } = require('../db/helpers');
const { hashIpForStorage, getRequestIp } = require('./geo');
const { addDays } = require('./link-stats');

const AUDIT_ACTIONS = Object.freeze({
  VIEW: 'stats.view',
  EXPORT: 'stats.export',
  SHARE_CREATE: 'stats.share.create',
  SHARE_REVOKE: 'stats.share.revoke',
  SHARED_VIEW: 'stats.shared.view',
  EMBED_VIEW: 'stats.embed.view',
  API_READ: 'stats.api.read',
});

const VALID_ACTIONS = new Set(Object.values(AUDIT_ACTIONS));
const DEDUPE_TTL_MS = 5 * 60 * 1000;
const MAX_DEDUPE_ENTRIES = 5000;
const MAX_QUEUE_SIZE = 500;
const FLUSH_BATCH_SIZE = 50;
const FLUSH_DELAY_MS = 2000;
const DEFAULT_RETENTION_DAYS = 90;
const PURGE_BATCH_SIZE = 2000;
const PURGE_MAX_ROUNDS = 5;

const COLUMNS = ['created_at', 'user_id', 'api_key_id', 'url_id', 'short', 'action', 'ip_hash', 'metadata_json'];

let dedupe = new Map();
let queue = [];
let flushTimer = null;
let flushing = null;
let dropped = 0;
let persisted = 0;

function pruneDedupe(nowMs) {
  if (dedupe.size <= MAX_DEDUPE_ENTRIES) return;
  for (const [key, seenAt] of dedupe) {
    if (nowMs - seenAt > DEDUPE_TTL_MS) dedupe.delete(key);
    if (dedupe.size <= MAX_DEDUPE_ENTRIES) break;
  }
  // Still too big: drop the oldest entries (Map keeps insertion order).
  while (dedupe.size > MAX_DEDUPE_ENTRIES) {
    dedupe.delete(dedupe.keys().next().value);
  }
}

function hashRequestIp(req) {
  if (!req) return null;
  try {
    const hash = hashIpForStorage(getRequestIp(req));
    return hash ? hash.toString().slice(0, 128) : null;
  } catch {
    return null;
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushAuditQueue().catch(() => {});
  }, FLUSH_DELAY_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * Records one access event. Synchronous and best-effort: it returns false when
 * the event was deduped or dropped, never throws.
 */
function recordAnalyticsAccess({ userId, apiKeyId, urlId, short, action, req, metadata, now = new Date() } = {}) {
  const safeAction = (action || '').toString();
  if (!VALID_ACTIONS.has(safeAction)) return false;

  const ownerId = Number.parseInt(userId, 10);
  const keyId = Number.parseInt(apiKeyId, 10);
  const linkId = Number.parseInt(urlId, 10);
  const key = `${Number.isInteger(ownerId) ? ownerId : 0}|${Number.isInteger(keyId) ? keyId : 0}|${safeAction}|${Number.isInteger(linkId) ? linkId : 0}`;

  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const lastSeen = dedupe.get(key);
  if (lastSeen && nowMs - lastSeen < DEDUPE_TTL_MS) return false;
  dedupe.set(key, nowMs);
  pruneDedupe(nowMs);

  if (queue.length >= MAX_QUEUE_SIZE) {
    dropped += 1;
    return false;
  }

  let metadataJson = null;
  if (metadata && typeof metadata === 'object') {
    try {
      metadataJson = JSON.stringify(metadata).slice(0, 1000);
    } catch {
      metadataJson = null;
    }
  }

  queue.push([
    (now instanceof Date ? now : new Date(now)).toISOString(),
    Number.isInteger(ownerId) && ownerId > 0 ? ownerId : null,
    Number.isInteger(keyId) && keyId > 0 ? keyId : null,
    Number.isInteger(linkId) && linkId > 0 ? linkId : null,
    (short || '').toString().slice(0, 64) || null,
    safeAction,
    hashRequestIp(req),
    metadataJson,
  ]);

  if (queue.length >= FLUSH_BATCH_SIZE) {
    void flushAuditQueue().catch(() => {});
  } else {
    scheduleFlush();
  }
  return true;
}

/** Writes the buffered rows. Safe to call directly (tests, shutdown). */
async function flushAuditQueue() {
  if (flushing) return flushing;
  if (!queue.length) return { written: 0 };

  const rows = queue.splice(0, FLUSH_BATCH_SIZE);
  const placeholders = rows.map(() => `(${COLUMNS.map(() => '?').join(', ')})`).join(', ');
  const params = [];
  for (const row of rows) params.push(...row);

  flushing = dbRunAsync(
    `INSERT INTO analytics_audit_log (${COLUMNS.join(', ')}) VALUES ${placeholders}`,
    params
  )
    .then((result) => {
      persisted += rows.length;
      return { written: rows.length, changes: result && result.changes ? Number(result.changes) : rows.length };
    })
    .catch(() => {
      // A failed flush must not lose the events silently in the counter: they
      // are dropped (analytics is best-effort) and reported via droppedCount.
      dropped += rows.length;
      return { written: 0 };
    })
    .finally(() => {
      flushing = null;
      if (queue.length) scheduleFlush();
    });

  return flushing;
}

async function listAuditEntries({ urlId, limit = 50 } = {}) {
  const id = Number.parseInt(urlId, 10);
  if (!Number.isInteger(id) || id <= 0) return [];
  const safeLimit = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
  const rows = await dbAllAsync(
    'SELECT id, created_at, user_id, api_key_id, action, metadata_json ' +
      'FROM analytics_audit_log WHERE url_id = ? ORDER BY id DESC LIMIT ?',
    [id, safeLimit]
  ).catch(() => []);
  return (rows || []).map((row) => ({
    id: Number(row.id),
    created_at: row.created_at,
    user_id: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    api_key_id: row.api_key_id === null || row.api_key_id === undefined ? null : Number(row.api_key_id),
    action: row.action,
    metadata: (() => {
      if (!row.metadata_json) return null;
      try {
        return JSON.parse(row.metadata_json);
      } catch {
        return null;
      }
    })(),
  }));
}

/** Deletes rows older than the retention window, in bounded batches. */
async function purgeOldAuditEntries({ now = new Date(), retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
  const parsed = Number.parseInt(retentionDays, 10);
  const safeDays = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
  const cutoff = addDays(now, -safeDays).toISOString();
  let deleted = 0;
  for (let round = 0; round < PURGE_MAX_ROUNDS; round += 1) {
    const result = await dbRunAsync(
      'DELETE FROM analytics_audit_log WHERE id IN (' +
        'SELECT id FROM analytics_audit_log WHERE created_at < ? LIMIT ?)',
      [cutoff, PURGE_BATCH_SIZE]
    ).catch(() => null);
    const changes = result && result.changes ? Number(result.changes) : 0;
    deleted += changes;
    if (!changes) break;
  }
  return { deleted, cutoff };
}

let purgeTimer = null;

function scheduleAnalyticsAuditPurge({ intervalMs = 24 * 60 * 60 * 1000, startDelayMs = 10 * 60 * 1000 } = {}) {
  if (purgeTimer) return purgeTimer;
  const run = () => {
    beat('analytics-audit');
    void purgeOldAuditEntries().catch(() => {});
    void flushAuditQueue().catch(() => {});
  };
  purgeTimer = setTimeout(() => {
    run();
    const interval = setInterval(run, intervalMs);
    if (typeof interval.unref === 'function') interval.unref();
  }, startDelayMs);
  if (typeof purgeTimer.unref === 'function') purgeTimer.unref();
  return purgeTimer;
}

function getAuditStats() {
  return { queued: queue.length, dedupe_entries: dedupe.size, dropped, persisted };
}

/** Test hook: clears the in-memory buffer/dedupe without touching the DB. */
function resetAuditStateForTests() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  queue = [];
  dedupe = new Map();
  dropped = 0;
  persisted = 0;
}

module.exports = {
  AUDIT_ACTIONS,
  DEFAULT_RETENTION_DAYS,
  recordAnalyticsAccess,
  flushAuditQueue,
  listAuditEntries,
  purgeOldAuditEntries,
  scheduleAnalyticsAuditPurge,
  getAuditStats,
  resetAuditStateForTests,
};
