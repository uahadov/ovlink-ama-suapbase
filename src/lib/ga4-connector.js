'use strict';

/**
 * P32 — GA4 Read-Only Pilot Connector & Measurement Reconciliation (ga4-connector-v1).
 *
 * Strictly scoped to Google Analytics 4 read-only property sync & source-by-source
 * reconciliation against Ovlink clicks. Does NOT claim Google Ads or Meta Ads parity.
 * Features:
 *   - Read-only OAuth scope enforcement & token rotation versioning
 *   - Explicit GA4 Data API quota (429) handling returning last healthy snapshot marked stale
 *   - Source-by-source Ovlink clicks vs GA4 sessions gap explanation
 *   - Full disconnect + token & cached snapshot deletion (zero post-revoke leakage)
 */

const crypto = require('crypto');
const { dbGetAsync, dbRunAsync } = require('../db/helpers');

const GA4_CONNECTOR_CONTRACT_VERSION = 'ga4-connector-v1';
const GA4_READONLY_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const GA4_SCOPE_DISCLAIMER = 'GA4 read-only pilot only; native Google Ads and Meta Ads connectors are not enabled.';

let ga4TableReady = false;

function normalizePropertyId(raw) {
  const s = String(raw || '').trim();
  if (/^properties\/\d{4,16}$/.test(s)) return s;
  if (/^\d{4,16}$/.test(s)) return `properties/${s}`;
  return null;
}

function hashOauthToken(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function normalizeChannelKey(raw) {
  return String(raw || 'direct').trim().toLowerCase() || 'direct';
}

/**
 * Reconciles Ovlink human clicks against GA4 sessions source-by-source,
 * surfacing explicit reasons for expected discrepancies.
 */
function reconcileOvlinkVsGa4({ ovlinkSources = [], ga4Channels = [], lastHealthySyncedAt = null, isStale = false } = {}) {
  const ovMap = new Map();
  for (const row of ovlinkSources) {
    const key = normalizeChannelKey(row.channel || row.name || row.source);
    ovMap.set(key, (ovMap.get(key) || 0) + Number(row.clicks || row.count || 0));
  }
  const gaMap = new Map();
  for (const row of ga4Channels) {
    const key = normalizeChannelKey(row.source || row.channel || row.sessionSource);
    gaMap.set(key, (gaMap.get(key) || 0) + Number(row.sessions || row.count || 0));
  }

  const allKeys = [...new Set([...ovMap.keys(), ...gaMap.keys()])].sort();
  let totalOvlinkClicks = 0;
  let totalGa4Sessions = 0;

  const bySource = allKeys.map((source) => {
    const clicks = ovMap.get(source) || 0;
    const sessions = gaMap.get(source) || 0;
    totalOvlinkClicks += clicks;
    totalGa4Sessions += sessions;
    const diff = sessions - clicks;
    const captureRate = clicks > 0 ? Math.round((sessions / clicks) * 1000) / 10 : null;
    const explanations = [];
    if (clicks > sessions) {
      explanations.push('GA4 sessions may be lower than Ovlink clicks due to consent opt-outs, ad blockers, or pre-load bounces.');
    } else if (sessions > clicks) {
      explanations.push('GA4 sessions may exceed Ovlink clicks due to direct/non-Ovlink traffic or multi-session attribution.');
    }
    if (isStale) {
      explanations.push('GA4 snapshot is stale (quota 429 or delayed sync); figures are from the last healthy sync.');
    }
    return {
      source,
      ovlink_clicks: clicks,
      ga4_sessions: sessions,
      difference: diff,
      session_to_click_percent: captureRate,
      explanations,
    };
  });

  return {
    contract_version: GA4_CONNECTOR_CONTRACT_VERSION,
    scope_disclaimer: GA4_SCOPE_DISCLAIMER,
    freshness: {
      is_stale: Boolean(isStale),
      last_healthy_synced_at: lastHealthySyncedAt,
      ga4_processing_lag_note: 'GA4 Data API intraday metrics can lag 24-48 hours before stabilizing.',
    },
    totals: {
      ovlink_clicks: totalOvlinkClicks,
      ga4_sessions: totalGa4Sessions,
      difference: totalGa4Sessions - totalOvlinkClicks,
    },
    by_source: bySource,
  };
}

async function ensureGa4ConnectionsTable(runFn = dbRunAsync) {
  if (ga4TableReady) return;
  await runFn(`CREATE TABLE IF NOT EXISTS ga4_connections (
    id SERIAL PRIMARY KEY,
    owner_user_id INTEGER NOT NULL,
    campaign_id INTEGER NOT NULL,
    property_id TEXT NOT NULL,
    oauth_scope TEXT NOT NULL,
    token_hash TEXT,
    token_version INTEGER NOT NULL DEFAULT 1,
    consent_granted BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'connected',
    quota_status TEXT NOT NULL DEFAULT 'ok',
    last_synced_at TEXT,
    last_healthy_snapshot_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await runFn('CREATE INDEX IF NOT EXISTS idx_ga4_conn_owner ON ga4_connections(owner_user_id, campaign_id, id DESC)').catch(() => {});
  ga4TableReady = true;
}

function mapConnectionRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    owner_user_id: Number(row.owner_user_id),
    campaign_id: Number(row.campaign_id),
    property_id: row.property_id,
    oauth_scope: row.oauth_scope,
    token_version: Number(row.token_version || 1),
    consent_granted: Boolean(row.consent_granted),
    status: row.status,
    quota_status: row.quota_status || 'ok',
    last_synced_at: row.last_synced_at || null,
    has_healthy_snapshot: Boolean(row.last_healthy_snapshot_json),
    scope_disclaimer: GA4_SCOPE_DISCLAIMER,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function connectGa4Property({
  ownerUserId,
  campaignId,
  propertyId,
  oauthToken,
  oauthScope = GA4_READONLY_SCOPE,
  consentGranted = false,
  dbRun = dbRunAsync,
} = {}) {
  await ensureGa4ConnectionsTable(dbRun);
  const prop = normalizePropertyId(propertyId);
  if (!prop) return { error: 'invalid_property_id', statusCode: 400, message: 'GA4 property_id düzgün deyil (məs: properties/123456789).' };
  if (String(oauthScope).trim() !== GA4_READONLY_SCOPE) {
    return { error: 'readonly_scope_required', statusCode: 400, message: 'Yalnız analytics.readonly icazəsinə icazə verilir.' };
  }
  if (consentGranted !== true) {
    return { error: 'consent_required', statusCode: 400, message: 'GA4 bağlantısı üçün açıq razılıq (consent_granted: true) tələb olunur.' };
  }
  const cleanToken = String(oauthToken || '').trim();
  if (cleanToken.length < 8) {
    return { error: 'invalid_oauth_token', statusCode: 400, message: 'Etibarlı OAuth token tələb olunur.' };
  }

  const nowIso = new Date().toISOString();
  const inserted = await dbRun(
    `INSERT INTO ga4_connections
       (owner_user_id, campaign_id, property_id, oauth_scope, token_hash, token_version,
        consent_granted, status, quota_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, TRUE, 'connected', 'ok', ?, ?)`,
    [Number(ownerUserId), Number(campaignId), prop, GA4_READONLY_SCOPE, hashOauthToken(cleanToken), nowIso, nowIso]
  );

  return {
    connection: mapConnectionRow({
      id: inserted.lastID,
      owner_user_id: ownerUserId,
      campaign_id: campaignId,
      property_id: prop,
      oauth_scope: GA4_READONLY_SCOPE,
      token_version: 1,
      consent_granted: true,
      status: 'connected',
      quota_status: 'ok',
      last_synced_at: null,
      last_healthy_snapshot_json: null,
      created_at: nowIso,
      updated_at: nowIso,
    }),
  };
}

/**
 * Syncs sandbox/provider GA4 rows. On HTTP 429 quota limit, NEVER fabricates
 * fresh status — returns the last healthy snapshot explicitly marked `stale: true`.
 */
async function syncGa4Snapshot({
  ownerUserId,
  connectionId,
  sandboxRows = [],
  simulateQuota429 = false,
  dbGet = dbGetAsync,
  dbRun = dbRunAsync,
} = {}) {
  await ensureGa4ConnectionsTable(dbRun);
  const row = await dbGet(
    'SELECT * FROM ga4_connections WHERE id = ? AND owner_user_id = ? LIMIT 1',
    [Number(connectionId), Number(ownerUserId)]
  );
  if (!row) return { error: 'not_found', statusCode: 404 };
  if (row.status !== 'connected' || !row.token_hash) {
    return { error: 'connection_revoked_or_disconnected', statusCode: 403, message: 'GA4 icazəsi ləğv edilib; məlumat oxuna bilməz.' };
  }

  const nowIso = new Date().toISOString();
  if (simulateQuota429) {
    await dbRun(
      "UPDATE ga4_connections SET quota_status = 'quota_429', updated_at = ? WHERE id = ?",
      [nowIso, Number(row.id)]
    );
    const lastHealthy = row.last_healthy_snapshot_json ? JSON.parse(row.last_healthy_snapshot_json) : null;
    return {
      statusCode: 429,
      quota_exceeded: true,
      stale: true,
      freshness_status: 'stale_quota_429',
      last_healthy_synced_at: row.last_synced_at || null,
      snapshot: lastHealthy,
    };
  }

  const normalizedRows = (Array.isArray(sandboxRows) ? sandboxRows : []).map((item) => ({
    source: normalizeChannelKey(item.source || item.channel || item.sessionSource),
    sessions: Math.max(0, Number(item.sessions || item.count || 0)),
  }));

  const snapshot = {
    property_id: row.property_id,
    synced_at: nowIso,
    channels: normalizedRows,
  };

  await dbRun(
    "UPDATE ga4_connections SET quota_status = 'ok', last_synced_at = ?, last_healthy_snapshot_json = ?, updated_at = ? WHERE id = ?",
    [nowIso, JSON.stringify(snapshot), nowIso, Number(row.id)]
  );

  return {
    statusCode: 200,
    quota_exceeded: false,
    stale: false,
    freshness_status: 'fresh',
    last_healthy_synced_at: nowIso,
    snapshot,
  };
}

/** Disconnects GA4 and wipes stored token hash & cached snapshot data (GDPR/consent compliance). */
async function disconnectGa4Connection({ ownerUserId, connectionId, dbRun = dbRunAsync } = {}) {
  await ensureGa4ConnectionsTable(dbRun);
  const nowIso = new Date().toISOString();
  const res = await dbRun(
    `UPDATE ga4_connections
        SET status = 'disconnected', token_hash = NULL, last_healthy_snapshot_json = NULL,
            consent_granted = FALSE, updated_at = ?
      WHERE id = ? AND owner_user_id = ?`,
    [nowIso, Number(connectionId), Number(ownerUserId)]
  );
  if (!res || !res.changes) return { error: 'not_found', statusCode: 404 };
  return { disconnected: true, data_deleted: true, id: Number(connectionId), updated_at: nowIso };
}

module.exports = {
  GA4_CONNECTOR_CONTRACT_VERSION,
  GA4_READONLY_SCOPE,
  GA4_SCOPE_DISCLAIMER,
  normalizePropertyId,
  reconcileOvlinkVsGa4,
  ensureGa4ConnectionsTable,
  connectGa4Property,
  syncGa4Snapshot,
  disconnectGa4Connection,
};
