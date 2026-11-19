'use strict';

/**
 * P24 — Report Provenance & Integrity Protocol (report-provenance-v1).
 *
 * Guarantees that every campaign report and export (JSON, CSV, PDF-descriptor,
 * Portal) carries standardized, tamper-evident provenance metadata:
 *   - Unique snapshot_id + monotonic revision per (campaign, report_type, scope)
 *   - Strict separation between `generated_at` and `last_data_at`
 *   - Deterministic SHA-256 `content_hash` over canonical metric data
 *   - Explicit `data_changed_since_previous` detection on retry/regeneration
 *   - Bidirectional linkage to `analytics_audit_log` (`audit_entry_id`)
 *   - Explicit staleness evaluation (`fresh` | `stale` | `no_data`)
 *   - Role-gated authorization for raw personal data (PII) exports
 */

const crypto = require('crypto');
const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../db/helpers');
const { getBotClassifierSpec } = require('./bot-classifier');

const PROVENANCE_CONTRACT_VERSION = 'report-provenance-v1';
const ALLOWED_SURFACES = new Set(['json', 'csv', 'pdf', 'portal']);
const DEFAULT_STALE_THRESHOLD_SECONDS = 24 * 60 * 60; // 24 hours
const MIN_STALE_THRESHOLD_SECONDS = 60;
const MAX_STALE_THRESHOLD_SECONDS = 90 * 24 * 60 * 60;

let snapshotsTableReady = false;

/** Canonical JSON serializer with sorted object keys for stable SHA-256 hashing. */
function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function generateSnapshotId() {
  return 'rpt_' + crypto.randomBytes(8).toString('hex');
}

function normalizeSurface(raw, fallback = 'json') {
  const val = String(raw || '').trim().toLowerCase();
  return ALLOWED_SURFACES.has(val) ? val : fallback;
}

function parseStaleThresholdSeconds(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_STALE_THRESHOLD_SECONDS;
  const mins = Number(raw);
  if (!Number.isFinite(mins) || mins <= 0) return DEFAULT_STALE_THRESHOLD_SECONDS;
  const secs = Math.round(mins * 60);
  return Math.max(MIN_STALE_THRESHOLD_SECONDS, Math.min(MAX_STALE_THRESHOLD_SECONDS, secs));
}

function parseBooleanFlag(raw) {
  if (raw === true || raw === 1) return true;
  const s = String(raw || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

function toIsoOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Evaluates data freshness strictly comparing `generated_at` against `last_data_at`.
 * Never conflates `generated_at` with `last_data_at`.
 */
function evaluateFreshness({ generatedAt, lastDataAt, staleThresholdSeconds = DEFAULT_STALE_THRESHOLD_SECONDS }) {
  const genIso = toIsoOrNull(generatedAt) || new Date().toISOString();
  const lastIso = toIsoOrNull(lastDataAt);
  const threshold = Number.isFinite(Number(staleThresholdSeconds)) && Number(staleThresholdSeconds) > 0
    ? Math.round(Number(staleThresholdSeconds))
    : DEFAULT_STALE_THRESHOLD_SECONDS;

  if (!lastIso) {
    return {
      status: 'no_data',
      is_stale: false,
      lag_seconds: null,
      stale_threshold_seconds: threshold,
    };
  }

  const lagMs = Math.max(0, new Date(genIso).getTime() - new Date(lastIso).getTime());
  const lagSeconds = Math.round(lagMs / 1000);
  const isStale = lagSeconds > threshold;
  return {
    status: isStale ? 'stale' : 'fresh',
    is_stale: isStale,
    lag_seconds: lagSeconds,
    stale_threshold_seconds: threshold,
  };
}

/**
 * Computes a stable scope hash representing the exact filter/query parameters
 * for a report so retries/regenerations of the same report share revision history.
 */
function computeScopeHash({ campaignId, reportType, dateRange, filters }) {
  return sha256Hex(canonicalJson({
    campaign_id: Number(campaignId),
    report_type: String(reportType || 'campaign_stats'),
    days: dateRange && dateRange.days !== undefined ? String(dateRange.days) : '30',
    bots: filters && filters.bots ? String(filters.bots) : 'exclude',
    window_days: filters && filters.window_days ? Number(filters.window_days) : null,
    model: filters && filters.model ? String(filters.model) : null,
  })).slice(0, 32);
}

/**
 * Builds the standardized P24 provenance block for any report surface.
 */
function buildReportProvenance({
  campaign,
  actorUserId,
  surface = 'json',
  reportType = 'campaign_stats',
  dateRange = {},
  filters = {},
  metricMethod = null,
  uniqueMethod = null,
  conversionMethod = null,
  dataSources = [],
  lastDataAt = null,
  generatedAt = new Date().toISOString(),
  payloadForHash = {},
  previousSnapshot = null,
  staleThresholdSeconds = DEFAULT_STALE_THRESHOLD_SECONDS,
  snapshotId = null,
  auditEntryId = null,
  auditAction = null,
} = {}) {
  const genIso = toIsoOrNull(generatedAt) || new Date().toISOString();
  const lastIso = toIsoOrNull(lastDataAt);
  const safeSurface = normalizeSurface(surface, 'json');
  const botMeta = getBotClassifierSpec();
  const botsFilter = filters && filters.bots === 'include' ? 'include' : 'exclude';

  const normalizedRange = {
    days: dateRange && dateRange.days !== undefined ? dateRange.days : '30',
    from_utc: toIsoOrNull(dateRange && (dateRange.from_utc || dateRange.from || dateRange.current_from_utc)),
    to_utc: toIsoOrNull(dateRange && (dateRange.to_utc || dateRange.to || dateRange.current_to_utc)) || genIso,
    timezone: 'UTC',
  };

  const normalizedFilters = {
    bots: botsFilter,
    ...(filters && filters.window_days !== undefined ? { window_days: Number(filters.window_days) } : {}),
    ...(filters && filters.model ? { model: String(filters.model) } : {}),
  };

  const scopeHash = computeScopeHash({
    campaignId: campaign && campaign.id,
    reportType,
    dateRange: normalizedRange,
    filters: normalizedFilters,
  });

  const contentHash = sha256Hex(canonicalJson(payloadForHash));
  const prevRevision = previousSnapshot ? Number(previousSnapshot.revision || 0) : 0;
  const revision = prevRevision + 1;
  const previousSnapshotId = previousSnapshot ? previousSnapshot.snapshot_id : null;
  const previousContentHash = previousSnapshot ? previousSnapshot.content_hash : null;
  const dataChanged = previousSnapshot ? (previousContentHash !== contentHash) : false;

  const freshness = evaluateFreshness({
    generatedAt: genIso,
    lastDataAt: lastIso,
    staleThresholdSeconds,
  });

  return {
    contract_version: PROVENANCE_CONTRACT_VERSION,
    snapshot_id: snapshotId || generateSnapshotId(),
    snapshot_version: revision,
    revision,
    scope_hash: scopeHash,
    content_hash: contentHash,
    previous_snapshot_id: previousSnapshotId,
    previous_content_hash: previousContentHash,
    data_changed_since_previous: previousSnapshot ? dataChanged : null,
    surface: safeSurface,
    report_type: String(reportType || 'campaign_stats'),
    owner: {
      user_id: campaign && campaign.user_id ? Number(campaign.user_id) : Number(actorUserId || 0),
      workspace_id: campaign && campaign.workspace_id ? Number(campaign.workspace_id) : null,
      actor_user_id: Number(actorUserId || 0) || null,
    },
    date_range: normalizedRange,
    filters: normalizedFilters,
    bot_method: {
      filter: botsFilter,
      classifier_version: botMeta.version,
      excluded_categories: botsFilter === 'exclude' ? botMeta.categories : [],
    },
    source_metadata: {
      tables: Array.isArray(dataSources) && dataSources.length > 0
        ? dataSources
        : (botsFilter === 'include'
          ? ['link_stats_daily', 'clicks', 'link_conversions']
          : ['clicks', 'link_conversions']),
      metric_method: metricMethod || (botsFilter === 'include' ? 'daily_rollup' : 'raw_nonbot_events'),
      unique_method: uniqueMethod || (botsFilter === 'include' ? 'daily_unique_rollup' : 'per_link_per_day_hashed_visitor'),
      conversion_method: conversionMethod || (botsFilter === 'include' ? 'all_recorded_conversions' : 'conversions_with_prior_nonbot_click_match'),
    },
    timestamps: {
      generated_at: genIso,
      last_data_at: lastIso,
      generated_at_is_distinct_from_last_data: true,
    },
    freshness,
    audit: {
      audit_entry_id: auditEntryId ? Number(auditEntryId) : null,
      audit_action: auditAction || null,
      content_hash_sha256: contentHash,
    },
  };
}

/**
 * Role- and surface-based authorization gate for raw personal data (PII) exports.
 * Never permits raw PII export on portal/shared surfaces or for non-privileged roles.
 */
function canExportRawPersonalData({
  actorUserId,
  ownerUserId,
  workspaceId = null,
  workspaceRole = null,
  isAdmin = false,
  surface = 'csv',
} = {}) {
  const safeSurface = normalizeSurface(surface, 'csv');
  if (safeSurface === 'portal') {
    return {
      allowed: false,
      code: 'raw_pii_export_forbidden',
      reason: 'portal_surface_pii_forbidden',
    };
  }
  if (isAdmin) {
    return { allowed: true, code: null, reason: 'platform_admin' };
  }
  const actor = Number(actorUserId || 0);
  const owner = Number(ownerUserId || 0);
  if (!actor) {
    return {
      allowed: false,
      code: 'raw_pii_export_forbidden',
      reason: 'unauthenticated',
    };
  }
  if (workspaceId) {
    const role = String(workspaceRole || '').trim().toLowerCase();
    if (role === 'owner' || role === 'admin') {
      return { allowed: true, code: null, reason: `workspace_${role}` };
    }
    return {
      allowed: false,
      code: 'raw_pii_export_forbidden',
      reason: 'insufficient_role_for_raw_pii',
    };
  }
  if (owner && actor === owner) {
    return { allowed: true, code: null, reason: 'campaign_owner' };
  }
  return {
    allowed: false,
    code: 'raw_pii_export_forbidden',
    reason: 'owner_only_raw_pii',
  };
}

/** Ensures the additive `report_snapshots` table exists (idempotent). */
async function ensureReportSnapshotsTable(runFn = dbRunAsync) {
  if (snapshotsTableReady) return;
  await runFn(`CREATE TABLE IF NOT EXISTS report_snapshots (
    id SERIAL PRIMARY KEY,
    snapshot_id TEXT NOT NULL UNIQUE,
    campaign_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    actor_user_id INTEGER NOT NULL,
    workspace_id INTEGER,
    report_type TEXT NOT NULL,
    surface TEXT NOT NULL,
    scope_hash TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    previous_snapshot_id TEXT,
    data_changed BOOLEAN NOT NULL DEFAULT FALSE,
    generated_at TEXT NOT NULL,
    last_data_at TEXT,
    freshness_status TEXT NOT NULL DEFAULT 'fresh',
    audit_entry_id INTEGER,
    provenance_json TEXT NOT NULL,
    summary_json TEXT NOT NULL
  )`);
  await runFn(
    'CREATE INDEX IF NOT EXISTS idx_report_snapshots_campaign_scope ON report_snapshots(campaign_id, report_type, scope_hash, id DESC)'
  ).catch(() => {});
  snapshotsTableReady = true;
}

/**
 * Persists a report snapshot and creates a fail-closed linked entry in `analytics_audit_log`.
 * If audit persistence or snapshot persistence fails, throws so the caller returns 503.
 */
async function createAndPersistReportSnapshot({
  campaign,
  actorUserId,
  surface = 'json',
  reportType = 'campaign_stats',
  dateRange = {},
  filters = {},
  metricMethod = null,
  uniqueMethod = null,
  conversionMethod = null,
  dataSources = [],
  lastDataAt = null,
  generatedAt = new Date().toISOString(),
  payloadForHash = {},
  summaryData = {},
  auditAction = 'campaign.report.snapshot',
  staleThresholdSeconds = DEFAULT_STALE_THRESHOLD_SECONDS,
  rawPiiRequested = false,
  dbRun = dbRunAsync,
  dbGet = dbGetAsync,
} = {}) {
  await ensureReportSnapshotsTable(dbRun);

  const campaignId = Number(campaign.id);
  const scopeHash = computeScopeHash({
    campaignId,
    reportType,
    dateRange: {
      days: dateRange && dateRange.days !== undefined ? dateRange.days : '30',
    },
    filters,
  });

  const previousSnapshot = await dbGet(
    'SELECT snapshot_id, content_hash, revision, generated_at, last_data_at FROM report_snapshots ' +
      'WHERE campaign_id = ? AND report_type = ? AND scope_hash = ? ORDER BY id DESC LIMIT 1',
    [campaignId, String(reportType), scopeHash]
  );

  const provenance = buildReportProvenance({
    campaign,
    actorUserId,
    surface,
    reportType,
    dateRange,
    filters,
    metricMethod,
    uniqueMethod,
    conversionMethod,
    dataSources,
    lastDataAt,
    generatedAt,
    payloadForHash,
    previousSnapshot: previousSnapshot || null,
    staleThresholdSeconds,
    auditAction,
  });

  // Fail-closed audit log entry with snapshot_id + content_hash reference.
  const auditMetadata = {
    campaign_id: campaignId,
    snapshot_id: provenance.snapshot_id,
    revision: provenance.revision,
    previous_snapshot_id: provenance.previous_snapshot_id,
    content_hash: provenance.content_hash,
    data_changed: provenance.data_changed_since_previous,
    surface: provenance.surface,
    report_type: provenance.report_type,
    days: provenance.date_range.days,
    bots: provenance.filters.bots,
    generated_at: provenance.timestamps.generated_at,
    last_data_at: provenance.timestamps.last_data_at,
    freshness_status: provenance.freshness.status,
    raw_pii_requested: Boolean(rawPiiRequested),
  };

  const auditRes = await dbRun(
    'INSERT INTO analytics_audit_log (created_at, user_id, url_id, short, action, metadata_json) VALUES (?, ?, NULL, NULL, ?, ?)',
    [provenance.timestamps.generated_at, Number(actorUserId), auditAction, JSON.stringify(auditMetadata)]
  );
  const auditEntryId = auditRes && auditRes.lastID ? Number(auditRes.lastID) : null;
  provenance.audit.audit_entry_id = auditEntryId;

  await dbRun(
    `INSERT INTO report_snapshots
       (snapshot_id, campaign_id, owner_user_id, actor_user_id, workspace_id, report_type, surface,
        scope_hash, content_hash, revision, previous_snapshot_id, data_changed, generated_at,
        last_data_at, freshness_status, audit_entry_id, provenance_json, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      provenance.snapshot_id,
      campaignId,
      provenance.owner.user_id,
      Number(actorUserId),
      provenance.owner.workspace_id,
      provenance.report_type,
      provenance.surface,
      provenance.scope_hash,
      provenance.content_hash,
      provenance.revision,
      provenance.previous_snapshot_id,
      Boolean(provenance.data_changed_since_previous),
      provenance.timestamps.generated_at,
      provenance.timestamps.last_data_at,
      provenance.freshness.status,
      auditEntryId,
      JSON.stringify(provenance),
      JSON.stringify(summaryData || {}),
    ]
  );

  return provenance;
}

/** Lists historical report snapshots for a campaign (most recent first). */
async function listCampaignReportSnapshots({ campaignId, limit = 25, dbAll = dbAllAsync, dbRun = dbRunAsync } = {}) {
  await ensureReportSnapshotsTable(dbRun);
  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 25));
  const rows = await dbAll(
    `SELECT snapshot_id, campaign_id, owner_user_id, actor_user_id, workspace_id,
            report_type, surface, scope_hash, content_hash, revision, previous_snapshot_id,
            data_changed, generated_at, last_data_at, freshness_status, audit_entry_id
       FROM report_snapshots
      WHERE campaign_id = ?
      ORDER BY id DESC
      LIMIT ?`,
    [Number(campaignId), safeLimit]
  );
  return (rows || []).map((r) => ({
    snapshot_id: r.snapshot_id,
    campaign_id: Number(r.campaign_id),
    owner_user_id: Number(r.owner_user_id),
    actor_user_id: Number(r.actor_user_id),
    workspace_id: r.workspace_id ? Number(r.workspace_id) : null,
    report_type: r.report_type,
    surface: r.surface,
    scope_hash: r.scope_hash,
    content_hash: r.content_hash,
    revision: Number(r.revision || 1),
    previous_snapshot_id: r.previous_snapshot_id || null,
    data_changed_since_previous: r.previous_snapshot_id ? Boolean(r.data_changed) : null,
    generated_at: r.generated_at,
    last_data_at: r.last_data_at || null,
    freshness_status: r.freshness_status,
    audit_entry_id: r.audit_entry_id ? Number(r.audit_entry_id) : null,
  }));
}

/** Retrieves a specific historical snapshot document by snapshot_id for a campaign. */
async function getCampaignReportSnapshot({ campaignId, snapshotId, targetSurface = null, dbGet = dbGetAsync, dbRun = dbRunAsync } = {}) {
  await ensureReportSnapshotsTable(dbRun);
  const cleanId = String(snapshotId || '').trim();
  if (!/^rpt_[a-f0-9]{16}$/i.test(cleanId)) return null;
  const row = await dbGet(
    'SELECT * FROM report_snapshots WHERE campaign_id = ? AND snapshot_id = ? LIMIT 1',
    [Number(campaignId), cleanId]
  );
  if (!row) return null;

  let provenance = {};
  let summary = {};
  try { provenance = JSON.parse(row.provenance_json || '{}'); } catch { provenance = {}; }
  try { summary = JSON.parse(row.summary_json || '{}'); } catch { summary = {}; }

  const requestedSurface = targetSurface ? normalizeSurface(targetSurface, row.surface) : row.surface;
  return {
    snapshot_id: row.snapshot_id,
    campaign_id: Number(row.campaign_id),
    requested_surface: requestedSurface,
    origin_surface: row.surface,
    same_snapshot_contract: true,
    provenance,
    summary,
  };
}

/** Standard HTTP response headers carrying provenance identifiers for CSV/JSON/PDF/Portal exports. */
function buildProvenanceHeaders(provenance) {
  if (!provenance) return {};
  return {
    'X-Ovlink-Provenance-Version': provenance.contract_version || PROVENANCE_CONTRACT_VERSION,
    'X-Ovlink-Snapshot-Id': provenance.snapshot_id || '',
    'X-Ovlink-Snapshot-Revision': String(provenance.revision || 1),
    'X-Ovlink-Content-Hash': provenance.content_hash || '',
    'X-Ovlink-Audit-Id': provenance.audit && provenance.audit.audit_entry_id ? String(provenance.audit.audit_entry_id) : '',
    'X-Ovlink-Data-Freshness': (provenance.freshness && provenance.freshness.status) || 'unknown',
    'X-Ovlink-Last-Data-At': (provenance.timestamps && provenance.timestamps.last_data_at) || '',
    'X-Ovlink-Generated-At': (provenance.timestamps && provenance.timestamps.generated_at) || '',
  };
}

module.exports = {
  PROVENANCE_CONTRACT_VERSION,
  ALLOWED_SURFACES,
  DEFAULT_STALE_THRESHOLD_SECONDS,
  canonicalJson,
  sha256Hex,
  generateSnapshotId,
  normalizeSurface,
  parseStaleThresholdSeconds,
  parseBooleanFlag,
  evaluateFreshness,
  computeScopeHash,
  buildReportProvenance,
  canExportRawPersonalData,
  ensureReportSnapshotsTable,
  createAndPersistReportSnapshot,
  listCampaignReportSnapshots,
  getCampaignReportSnapshot,
  buildProvenanceHeaders,
};
