'use strict';

/**
 * P29 — Reliable Business Alert Engine & Notification Preferences (business-alerts-v1).
 *
 * Detects 4 operational/marketing signals before clients notice:
 *   1. traffic_anomaly (campaign drop/spike with noise floor & low-data 'suspicious' guard)
 *   2. broken_destination (HTTP 4xx/5xx or unreachable target URL)
 *   3. report_failure (scheduled or exported report generation failure)
 *   4. integration_disconnected (webhook / conversion API / bot disconnect)
 *
 * Features dedupe windows (anti-spam), action links, source + confidence rating,
 * user channel/frequency/threshold preferences, ops escalation & retry policy,
 * and open -> acknowledged -> resolved lifecycle tracking.
 */

const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../db/helpers');

const BUSINESS_ALERTS_CONTRACT_VERSION = 'business-alerts-v1';
const ALLOWED_SIGNALS = new Set([
  'traffic_anomaly',
  'broken_destination',
  'report_failure',
  'integration_disconnected',
]);
const ALLOWED_CHANNELS = new Set(['in_app', 'email', 'webhook']);
const ALLOWED_FREQUENCIES = new Set(['instant', 'hourly_digest', 'daily_digest']);
const ALLOWED_STATUSES = new Set(['open', 'acknowledged', 'resolved']);

const DEFAULT_PREFERENCES = Object.freeze({
  channels: ['in_app', 'email'],
  frequency: 'instant',
  drop_threshold_percent: 40,
  spike_threshold_percent: 100,
  min_sample_size: 30,
  dedupe_window_minutes: 60,
});

const OPS_RETRY_POLICY = Object.freeze({
  max_retries: 3,
  backoff_seconds: [60, 300, 900],
});

let alertsTablesReady = false;

/**
 * Evaluates a traffic drop/spike with strict noise-floor protection.
 * When baseline volume is below `minSampleSize`, never makes a definitive
 * negative claim — marks as `low_data_suspicious` or suppresses below floor.
 */
function evaluateTrafficSignal({
  baselineClicks = 0,
  currentClicks = 0,
  minSampleSize = DEFAULT_PREFERENCES.min_sample_size,
  dropThresholdPercent = DEFAULT_PREFERENCES.drop_threshold_percent,
  spikeThresholdPercent = DEFAULT_PREFERENCES.spike_threshold_percent,
} = {}) {
  const base = Math.max(0, Number(baselineClicks) || 0);
  const curr = Math.max(0, Number(currentClicks) || 0);
  const minSample = Math.max(5, Number(minSampleSize) || 30);
  const dropThresh = Math.max(10, Math.min(95, Number(dropThresholdPercent) || 40));
  const spikeThresh = Math.max(25, Math.min(1000, Number(spikeThresholdPercent) || 100));

  // Below absolute noise floor -> suppress completely
  if (base < 5 && curr < 10) {
    return {
      triggered: false,
      reason: 'below_noise_floor',
      confidence: 'none',
      delta_percent: null,
    };
  }

  const deltaPercent = base > 0 ? Math.round(((curr - base) / base) * 1000) / 10 : 100;
  const isDrop = base > 0 && deltaPercent <= -dropThresh;
  const isSpike = deltaPercent >= spikeThresh;

  if (!isDrop && !isSpike) {
    return {
      triggered: false,
      reason: 'within_normal_band',
      confidence: 'none',
      delta_percent: deltaPercent,
    };
  }

  // Low-data guard: never claim definitive campaign failure with thin data
  if (base < minSample) {
    return {
      triggered: true,
      direction: isDrop ? 'drop' : 'spike',
      severity: 'info',
      confidence: 'low_data_suspicious',
      label: 'suspicious',
      delta_percent: deltaPercent,
      summary: `Suspicious ${isDrop ? 'drop' : 'spike'} (${deltaPercent}%) observed on low sample volume (baseline ${base} < ${minSample}); verify before taking action.`,
    };
  }

  return {
    triggered: true,
    direction: isDrop ? 'drop' : 'spike',
    severity: Math.abs(deltaPercent) >= 70 ? 'critical' : 'warning',
    confidence: base >= minSample * 3 ? 'high' : 'medium',
    label: isDrop ? 'traffic_drop' : 'traffic_spike',
    delta_percent: deltaPercent,
    summary: `Significant traffic ${isDrop ? 'drop' : 'spike'} (${deltaPercent}% vs baseline ${base} clicks).`,
  };
}

function buildDedupeKey({ userId, signalType, entityId = 'global', direction = '' }) {
  return `${Number(userId)}:${String(signalType)}:${String(entityId)}:${String(direction)}`.slice(0, 120);
}

async function ensureBusinessAlertsTables(runFn = dbRunAsync) {
  if (alertsTablesReady) return;
  await runFn(`CREATE TABLE IF NOT EXISTS business_alerts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    campaign_id INTEGER,
    signal_type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    confidence TEXT NOT NULL DEFAULT 'medium',
    source_name TEXT NOT NULL DEFAULT 'ovlink_analytics',
    dedupe_key TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    action_url TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    ops_escalated BOOLEAN NOT NULL DEFAULT FALSE,
    retry_policy_json TEXT,
    metadata_json TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    resolved_at TEXT
  )`);
  await runFn('CREATE INDEX IF NOT EXISTS idx_business_alerts_user_status ON business_alerts(user_id, status, id DESC)').catch(() => {});
  await runFn('CREATE INDEX IF NOT EXISTS idx_business_alerts_dedupe ON business_alerts(dedupe_key, status, last_seen_at DESC)').catch(() => {});
  await runFn(`CREATE TABLE IF NOT EXISTS alert_preferences (
    user_id INTEGER PRIMARY KEY,
    channels_json TEXT NOT NULL,
    frequency TEXT NOT NULL DEFAULT 'instant',
    drop_threshold_percent INTEGER NOT NULL DEFAULT 40,
    spike_threshold_percent INTEGER NOT NULL DEFAULT 100,
    min_sample_size INTEGER NOT NULL DEFAULT 30,
    dedupe_window_minutes INTEGER NOT NULL DEFAULT 60,
    updated_at TEXT NOT NULL
  )`);
  alertsTablesReady = true;
}

async function getAlertPreferences({ userId, dbGet = dbGetAsync, dbRun = dbRunAsync } = {}) {
  await ensureBusinessAlertsTables(dbRun);
  const row = await dbGet('SELECT * FROM alert_preferences WHERE user_id = ? LIMIT 1', [Number(userId)]);
  if (!row) return { user_id: Number(userId), ...DEFAULT_PREFERENCES };
  let channels = [...DEFAULT_PREFERENCES.channels];
  try { channels = JSON.parse(row.channels_json || '[]'); } catch { channels = [...DEFAULT_PREFERENCES.channels]; }
  return {
    user_id: Number(row.user_id),
    channels: Array.isArray(channels) && channels.length ? channels : [...DEFAULT_PREFERENCES.channels],
    frequency: ALLOWED_FREQUENCIES.has(row.frequency) ? row.frequency : 'instant',
    drop_threshold_percent: Number(row.drop_threshold_percent || 40),
    spike_threshold_percent: Number(row.spike_threshold_percent || 100),
    min_sample_size: Number(row.min_sample_size || 30),
    dedupe_window_minutes: Number(row.dedupe_window_minutes || 60),
    updated_at: row.updated_at || null,
  };
}

async function saveAlertPreferences({ userId, body = {}, dbRun = dbRunAsync } = {}) {
  await ensureBusinessAlertsTables(dbRun);
  const rawChannels = Array.isArray(body.channels) ? body.channels : DEFAULT_PREFERENCES.channels;
  const channels = [...new Set(rawChannels.map((c) => String(c || '').trim().toLowerCase()).filter((c) => ALLOWED_CHANNELS.has(c)))];
  const safeChannels = channels.length > 0 ? channels : ['in_app'];
  const frequency = ALLOWED_FREQUENCIES.has(String(body.frequency || '').toLowerCase())
    ? String(body.frequency).toLowerCase()
    : 'instant';
  const dropThresh = Math.max(10, Math.min(95, Number.parseInt(body.drop_threshold_percent, 10) || 40));
  const spikeThresh = Math.max(25, Math.min(1000, Number.parseInt(body.spike_threshold_percent, 10) || 100));
  const minSample = Math.max(5, Math.min(10000, Number.parseInt(body.min_sample_size, 10) || 30));
  const dedupeMins = Math.max(5, Math.min(1440, Number.parseInt(body.dedupe_window_minutes, 10) || 60));
  const nowIso = new Date().toISOString();

  await dbRun(
    `INSERT INTO alert_preferences
       (user_id, channels_json, frequency, drop_threshold_percent, spike_threshold_percent, min_sample_size, dedupe_window_minutes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       channels_json = EXCLUDED.channels_json,
       frequency = EXCLUDED.frequency,
       drop_threshold_percent = EXCLUDED.drop_threshold_percent,
       spike_threshold_percent = EXCLUDED.spike_threshold_percent,
       min_sample_size = EXCLUDED.min_sample_size,
       dedupe_window_minutes = EXCLUDED.dedupe_window_minutes,
       updated_at = EXCLUDED.updated_at`,
    [Number(userId), JSON.stringify(safeChannels), frequency, dropThresh, spikeThresh, minSample, dedupeMins, nowIso]
  );

  return {
    user_id: Number(userId),
    channels: safeChannels,
    frequency,
    drop_threshold_percent: dropThresh,
    spike_threshold_percent: spikeThresh,
    min_sample_size: minSample,
    dedupe_window_minutes: dedupeMins,
    updated_at: nowIso,
  };
}

function mapAlertRow(row) {
  if (!row) return null;
  let retryPolicy = null;
  let metadata = {};
  try { retryPolicy = row.retry_policy_json ? JSON.parse(row.retry_policy_json) : null; } catch { retryPolicy = null; }
  try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch { metadata = {}; }
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    campaign_id: row.campaign_id ? Number(row.campaign_id) : null,
    signal_type: row.signal_type,
    severity: row.severity,
    confidence: row.confidence,
    source_name: row.source_name,
    dedupe_key: row.dedupe_key,
    title: row.title,
    summary: row.summary,
    action_url: row.action_url || null,
    status: row.status,
    occurrence_count: Number(row.occurrence_count || 1),
    ops_escalated: Boolean(row.ops_escalated),
    retry_policy: retryPolicy,
    metadata,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    resolved_at: row.resolved_at || null,
  };
}

/**
 * Records a business alert with anti-spam deduplication within the user's
 * configured `dedupe_window_minutes`.
 */
async function emitBusinessAlert({
  userId,
  campaignId = null,
  signalType,
  severity = 'warning',
  confidence = 'medium',
  sourceName = 'ovlink_analytics',
  title,
  summary,
  actionUrl = null,
  direction = '',
  metadata = {},
  dedupeWindowMinutes = DEFAULT_PREFERENCES.dedupe_window_minutes,
  dbGet = dbGetAsync,
  dbRun = dbRunAsync,
} = {}) {
  await ensureBusinessAlertsTables(dbRun);
  const safeSignal = ALLOWED_SIGNALS.has(signalType) ? signalType : 'traffic_anomaly';
  const dedupeKey = buildDedupeKey({
    userId,
    signalType: safeSignal,
    entityId: campaignId || 'global',
    direction,
  });
  const now = new Date();
  const nowIso = now.toISOString();
  const windowCutoffIso = new Date(now.getTime() - Math.max(1, Number(dedupeWindowMinutes) || 60) * 60000).toISOString();

  const existing = await dbGet(
    "SELECT * FROM business_alerts WHERE dedupe_key = ? AND status <> 'resolved' AND last_seen_at >= ? ORDER BY id DESC LIMIT 1",
    [dedupeKey, windowCutoffIso]
  );

  if (existing) {
    const nextCount = Number(existing.occurrence_count || 1) + 1;
    const opsEscalated = Boolean(existing.ops_escalated) || nextCount >= 3 || severity === 'critical';
    await dbRun(
      'UPDATE business_alerts SET occurrence_count = ?, last_seen_at = ?, ops_escalated = ?, summary = ? WHERE id = ?',
      [nextCount, nowIso, opsEscalated, String(summary || existing.summary).slice(0, 500), Number(existing.id)]
    );
    return {
      deduplicated: true,
      alert: mapAlertRow({ ...existing, occurrence_count: nextCount, last_seen_at: nowIso, ops_escalated: opsEscalated, summary: summary || existing.summary }),
    };
  }

  const opsEscalated = severity === 'critical' || ['broken_destination', 'report_failure', 'integration_disconnected'].includes(safeSignal);
  const retryPolicy = opsEscalated ? OPS_RETRY_POLICY : null;

  const inserted = await dbRun(
    `INSERT INTO business_alerts
       (user_id, campaign_id, signal_type, severity, confidence, source_name, dedupe_key,
        title, summary, action_url, status, occurrence_count, ops_escalated, retry_policy_json,
        metadata_json, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?, ?)`,
    [
      Number(userId),
      campaignId ? Number(campaignId) : null,
      safeSignal,
      severity,
      confidence,
      String(sourceName || 'ovlink_analytics').slice(0, 60),
      dedupeKey,
      String(title || safeSignal).slice(0, 140),
      String(summary || '').slice(0, 500),
      actionUrl ? String(actionUrl).slice(0, 300) : null,
      opsEscalated,
      retryPolicy ? JSON.stringify(retryPolicy) : null,
      JSON.stringify(metadata || {}),
      nowIso,
      nowIso,
    ]
  );

  return {
    deduplicated: false,
    alert: mapAlertRow({
      id: inserted.lastID,
      user_id: userId,
      campaign_id: campaignId,
      signal_type: safeSignal,
      severity,
      confidence,
      source_name: sourceName,
      dedupe_key: dedupeKey,
      title: String(title || safeSignal).slice(0, 140),
      summary: String(summary || '').slice(0, 500),
      action_url: actionUrl,
      status: 'open',
      occurrence_count: 1,
      ops_escalated: opsEscalated,
      retry_policy_json: retryPolicy ? JSON.stringify(retryPolicy) : null,
      metadata_json: JSON.stringify(metadata || {}),
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      resolved_at: null,
    }),
  };
}

async function listBusinessAlerts({ userId, status = null, dbAll = dbAllAsync, dbRun = dbRunAsync } = {}) {
  await ensureBusinessAlertsTables(dbRun);
  const safeStatus = status && ALLOWED_STATUSES.has(String(status).toLowerCase()) ? String(status).toLowerCase() : null;
  const rows = safeStatus
    ? await dbAll('SELECT * FROM business_alerts WHERE user_id = ? AND status = ? ORDER BY id DESC LIMIT 100', [Number(userId), safeStatus])
    : await dbAll('SELECT * FROM business_alerts WHERE user_id = ? ORDER BY id DESC LIMIT 100', [Number(userId)]);
  return (rows || []).map(mapAlertRow);
}

async function updateBusinessAlertStatus({ userId, alertId, status, dbRun = dbRunAsync } = {}) {
  await ensureBusinessAlertsTables(dbRun);
  const safeStatus = ALLOWED_STATUSES.has(String(status || '').toLowerCase()) ? String(status).toLowerCase() : null;
  if (!safeStatus) return { error: 'invalid_status', statusCode: 400 };
  const resolvedAt = safeStatus === 'resolved' ? new Date().toISOString() : null;
  const res = await dbRun(
    'UPDATE business_alerts SET status = ?, resolved_at = ? WHERE id = ? AND user_id = ?',
    [safeStatus, resolvedAt, Number(alertId), Number(userId)]
  );
  if (!res || !res.changes) return { error: 'not_found', statusCode: 404 };
  return { id: Number(alertId), status: safeStatus, resolved_at: resolvedAt };
}

module.exports = {
  BUSINESS_ALERTS_CONTRACT_VERSION,
  ALLOWED_SIGNALS,
  DEFAULT_PREFERENCES,
  OPS_RETRY_POLICY,
  evaluateTrafficSignal,
  buildDedupeKey,
  ensureBusinessAlertsTables,
  getAlertPreferences,
  saveAlertPreferences,
  emitBusinessAlert,
  listBusinessAlerts,
  updateBusinessAlertStatus,
};
