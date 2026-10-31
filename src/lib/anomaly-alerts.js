'use strict';

const { beat } = require('./worker-heartbeat');

/**
 * Anomaly alerts for link statistics.
 *
 * Three independent signals:
 *   1. click spike   - today's clicks far above the trailing baseline
 *   2. click drop    - today's clicks far below it (only after the day is mature)
 *   3. limit warning - the click cap is almost used up
 *
 * A fourth, optional signal probes the destination so a dead landing page does
 * not silently burn traffic. Probing goes through a pinned-IP request with the
 * same IP/port/host guards used for outbound webhooks, so this worker can never
 * be turned into a port scanner or an SSRF pivot.
 *
 * Everything is best-effort: a scan never throws into a request path, and every
 * notification is idempotent through the `(user_id, event_key)` unique index.
 */

const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns').promises;

const { dbRunAsync, dbAllAsync, dbGetAsync } = require('../db/helpers');
const { queueWebhookDelivery } = require('./webhook');
const { sendOpsAlert } = require('./alerts');
const { mergeAlertSettings, describeThresholds } = require('./alert-thresholds');
const { isoDay, addDays, percentDelta, buildDaySeries } = require('./link-stats');
const {
  isBlockedWebhookIp,
  isBlockedWebhookHostname,
  isBlockedWebhookPort,
  getEffectivePort,
} = require('./url-validator');

const ANOMALY_KINDS = Object.freeze({
  SPIKE: 'spike',
  DROP: 'drop',
  LIMIT: 'limit',
  HEALTH: 'health',
});

const WEBHOOK_EVENTS = Object.freeze({
  spike: 'stats.anomaly.spike',
  drop: 'stats.anomaly.drop',
  limit: 'stats.limit.warning',
  health: 'stats.link.down',
});

const DEFAULT_SETTINGS = Object.freeze({
  baselineDays: 7,
  // A spike must clear both an absolute floor and a multiple of the baseline,
  // otherwise small links would page their owner every day.
  spikeMultiplier: 3,
  spikeMinClicks: 25,
  spikeMinBaselineAvg: 2,
  // Drops are only judged once most of the day is gone.
  dropMultiplier: 0.3,
  dropMinBaselineAvg: 10,
  dropAfterHourUtc: 12,
  // Limit warning threshold as a fraction of max_clicks.
  limitWarnRatio: 0.8,
  // Destination health checks.
  healthEnabled: true,
  healthMinClicks: 3,
  healthBatchLimit: 15,
  healthRecheckHours: 24,
  healthTimeoutMs: 5000,
  // Safety caps so one scan cannot turn into a table scan.
  scanLinkLimit: 2000,
});

const DNS_TIMEOUT_MS = 5000;
const MAX_LABEL = 60;

function readEnvInt(raw, fallback, min, max) {
  const value = Number.parseInt(String(raw === undefined || raw === null ? '' : raw), 10);
  if (!Number.isInteger(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function readEnvFloat(raw, fallback, min, max) {
  const value = Number.parseFloat(String(raw === undefined || raw === null ? '' : raw));
  if (!Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function readEnvFlag(raw, fallback) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (!value) return fallback;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  return fallback;
}

/** Defaults, environment overrides and caller overrides in that order. */
function buildSettings(overrides = {}) {
  const env = process.env || {};
  const merged = {
    ...DEFAULT_SETTINGS,
    baselineDays: readEnvInt(env.ANOMALY_BASELINE_DAYS, DEFAULT_SETTINGS.baselineDays, 1, 30),
    spikeMultiplier: readEnvFloat(env.ANOMALY_SPIKE_MULTIPLIER, DEFAULT_SETTINGS.spikeMultiplier, 1.5, 100),
    spikeMinClicks: readEnvInt(env.ANOMALY_SPIKE_MIN_CLICKS, DEFAULT_SETTINGS.spikeMinClicks, 1, 100000),
    dropMultiplier: readEnvFloat(env.ANOMALY_DROP_MULTIPLIER, DEFAULT_SETTINGS.dropMultiplier, 0.01, 0.99),
    dropMinBaselineAvg: readEnvInt(env.ANOMALY_DROP_MIN_BASELINE, DEFAULT_SETTINGS.dropMinBaselineAvg, 1, 100000),
    healthEnabled: readEnvFlag(env.ANOMALY_HEALTH_CHECKS, DEFAULT_SETTINGS.healthEnabled),
    healthBatchLimit: readEnvInt(env.ANOMALY_HEALTH_BATCH, DEFAULT_SETTINGS.healthBatchLimit, 1, 200),
    scanLinkLimit: readEnvInt(env.ANOMALY_SCAN_LINK_LIMIT, DEFAULT_SETTINGS.scanLinkLimit, 1, 50000),
  };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value === undefined || value === null) continue;
    merged[key] = value;
  }
  return merged;
}

function round1(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 10) / 10;
}

function mean(values) {
  const list = Array.isArray(values) ? values : [];
  if (!list.length) return 0;
  let total = 0;
  for (const value of list) {
    const num = Number(value || 0);
    if (Number.isFinite(num)) total += num;
  }
  return total / list.length;
}

/** Accepts `{date,count}` (buildDaySeries) or `{day,clicks}` rows. */
function normalizeSeries(series) {
  const list = Array.isArray(series) ? series : [];
  return list
    .map((row) => {
      const day = (row && (row.day || row.date) ? String(row.day || row.date) : '').slice(0, 10);
      const clicks = Number(row && (row.clicks !== undefined ? row.clicks : row.count) || 0);
      return { day, clicks: Number.isFinite(clicks) && clicks > 0 ? clicks : 0 };
    })
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day));
}

/**
 * Compares one day with its baseline and returns the triggered flags.
 * Pure: everything the caller needs to test a threshold is passed in.
 */
function evaluateCounts(todayClicks, baselineAverage, settings = {}, { now = new Date(), isToday = true } = {}) {
  const cfg = settings && settings.baselineDays ? settings : buildSettings(settings);
  const clicks = Math.max(0, Number(todayClicks || 0));
  const baseline = Math.max(0, Number(baselineAverage || 0));
  const flags = [];

  if (
    clicks >= cfg.spikeMinClicks &&
    baseline >= cfg.spikeMinBaselineAvg &&
    clicks >= baseline * cfg.spikeMultiplier
  ) {
    flags.push({
      kind: ANOMALY_KINDS.SPIKE,
      severity: 'warning',
      clicks,
      baseline_average: round1(baseline),
      ratio: baseline > 0 ? round1(clicks / baseline) : null,
      delta_percent: percentDelta(clicks, Math.round(baseline)),
    });
  }

  // A drop is only meaningful once the day is mostly over; otherwise every
  // early-morning scan would page the owner.
  const hours = now && typeof now.getUTCHours === 'function' ? now.getUTCHours() : 23;
  const dayMature = !isToday || hours >= cfg.dropAfterHourUtc;
  if (dayMature && baseline >= cfg.dropMinBaselineAvg && clicks <= baseline * cfg.dropMultiplier) {
    flags.push({
      kind: ANOMALY_KINDS.DROP,
      severity: 'critical',
      clicks,
      baseline_average: round1(baseline),
      ratio: baseline > 0 ? round1(clicks / baseline) : null,
      delta_percent: percentDelta(clicks, Math.round(baseline)),
    });
  }

  return flags;
}

/** Walks a daily series and flags every day that deviates from its baseline. */
function detectSeriesAnomalies(series, settings = {}, { now = new Date() } = {}) {
  const cfg = buildSettings(settings);
  const points = normalizeSeries(series);
  const found = [];
  if (points.length < 3) return found;

  for (let index = 1; index < points.length; index += 1) {
    const windowStart = Math.max(0, index - cfg.baselineDays);
    const window = points.slice(windowStart, index);
    if (window.length < Math.min(cfg.baselineDays, 3)) continue;
    const baselineAverage = mean(window.map((point) => point.clicks));
    const isToday = index === points.length - 1;
    const flags = evaluateCounts(points[index].clicks, baselineAverage, cfg, { now, isToday });
    for (const flag of flags) found.push({ day: points[index].day, ...flag });
  }

  return found;
}

function shortLabel(short) {
  const value = (short || '').toString();
  return value.length > MAX_LABEL ? value.slice(0, MAX_LABEL) : value;
}

function formatDelta(flag) {
  const pct = flag && flag.delta_percent;
  if (pct === null || pct === undefined) return '';
  return ` (${pct > 0 ? '+' : ''}${round1(pct)}%)`;
}

/**
 * Localized in-app notification payload for one flag. Returns null for unknown
 * kinds so a future signal can never insert a half-translated row.
 */
function buildAnomalyPayload(flag, { short } = {}) {
  const kind = flag && flag.kind;
  const code = shortLabel(short);
  const delta = formatDelta(flag);
  const clicks = Number(flag && flag.clicks || 0);
  const baseline = Number(flag && flag.baseline_average || 0);

  if (kind === ANOMALY_KINDS.SPIKE) {
    return {
      titleAz: 'Klik partlayışı',
      titleTr: 'Tıklama patlaması',
      titleEn: 'Click spike',
      bodyAz: `«${code}» linkinə son gündə ${clicks} klik gəldi; gündəlik orta ${baseline}${delta}.`,
      bodyTr: `«${code}» bağlantısına son günde ${clicks} tıklama geldi; günlük ortalama ${baseline}${delta}.`,
      bodyEn: `"${code}" received ${clicks} clicks in the last day; daily average ${baseline}${delta}.`,
      linkShort: code,
      eventKey: `anomaly_spike_${code}_${flag.day || isoDay(new Date())}`,
    };
  }

  if (kind === ANOMALY_KINDS.DROP) {
    return {
      titleAz: 'Klik düşməsi',
      titleTr: 'Tıklama düşüşü',
      titleEn: 'Click drop',
      bodyAz: `«${code}» linkinə bugün yalnız ${clicks} klik gəldi; gündəlik orta ${baseline}${delta}.`,
      bodyTr: `«${code}» bağlantısına bugün yalnızca ${clicks} tıklama geldi; günlük ortalama ${baseline}${delta}.`,
      bodyEn: `"${code}" received only ${clicks} clicks today; daily average ${baseline}${delta}.`,
      linkShort: code,
      eventKey: `anomaly_drop_${code}_${flag.day || isoDay(new Date())}`,
    };
  }

  if (kind === ANOMALY_KINDS.LIMIT) {
    const percent = Number(flag.percent || 0);
    return {
      titleAz: 'Klik limiti bitmək üzrədir',
      titleTr: 'Tıklama limiti dolmak üzere',
      titleEn: 'Click limit almost reached',
      bodyAz: `«${code}» linki maksimum klik limitinin ${percent}%-nə çatıb.`,
      bodyTr: `«${code}» bağlantısı maksimum tıklama limitinin %${percent} seviyesine ulaştı.`,
      bodyEn: `"${code}" reached ${percent}% of its maximum click limit.`,
      linkShort: code,
      eventKey: `anomaly_limit_${code}_${flag.day || isoDay(new Date())}`,
    };
  }

  if (kind === ANOMALY_KINDS.HEALTH) {
    const reason = (flag.reason || 'unreachable').toString().slice(0, 40);
    return {
      titleAz: 'Hədəf link cavab vermir',
      titleTr: 'Hedef bağlantı yanıt vermiyor',
      titleEn: 'Destination not responding',
      bodyAz: `«${code}» linkinin hədəfi yoxlanışda uğursuz oldu (${reason}). Kliklər itirilə bilər.`,
      bodyTr: `«${code}» bağlantısının hedefi denetimde başarısız oldu (${reason}). Tıklamalar kaybolabilir.`,
      bodyEn: `The destination behind "${code}" failed its check (${reason}). Clicks may be lost.`,
      linkShort: code,
      eventKey: `anomaly_health_${code}_${flag.day || isoDay(new Date())}`,
    };
  }

  return null;
}

/**
 * Inserts one notification and reports whether it was new, so repeated scans
 * of the same anomaly do not inflate counters or spam the bell.
 */
async function insertAnomalyNotification(userId, payload) {
  const id = Number.parseInt(userId, 10);
  if (!Number.isInteger(id) || id <= 0 || !payload || !payload.eventKey) return false;

  const createdAt = new Date().toISOString();
  const result = await dbRunAsync(
    'INSERT OR IGNORE INTO notifications (user_id, type, title_az, title_tr, title_en, body_az, body_tr, body_en, link_short, event_key, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      'anomaly',
      payload.titleAz,
      payload.titleTr,
      payload.titleEn,
      payload.bodyAz,
      payload.bodyTr,
      payload.bodyEn,
      payload.linkShort || null,
      payload.eventKey,
      createdAt,
    ]
  ).catch(() => null);

  return !!(result && Number(result.changes) > 0);
}

async function dispatchAnomaly(row, flag) {
  const payload = buildAnomalyPayload(flag, { short: row.short });
  if (!payload) return 0;

  let created = 0;
  if (await insertAnomalyNotification(row.user_id, payload)) created = 1;

  // Ops channels only get signals that may need infrastructure attention; a
  // single link's traffic dip is the owner's business, not the on-call's.
  if (flag.kind === ANOMALY_KINDS.HEALTH || flag.kind === ANOMALY_KINDS.SPIKE) {
    sendOpsAlert(
      `anomaly:${flag.kind}:${row.short}:${flag.day || ''}`,
      `Anomaly ${flag.kind} on ${row.short}`,
      `clicks=${flag.clicks} baseline=${flag.baseline_average} delta=${flag.delta_percent}`
    );
  }

  const event = WEBHOOK_EVENTS[flag.kind];
  if (event) {
    void queueWebhookDelivery(row.user_id, event, {
      short: row.short,
      kind: flag.kind,
      day: flag.day || null,
      clicks: flag.clicks,
      baseline_average: flag.baseline_average,
      delta_percent: flag.delta_percent,
      severity: flag.severity || 'warning',
      detected_at: new Date().toISOString(),
    }).catch(() => {});
  }

  return created;
}

/**
 * Loads user defaults and per-link overrides for a scan in two bounded queries.
 * The IN lists are capped so a huge batch cannot build an unbounded statement.
 */
async function loadAlertOverrides({ userIds = [], urlIds = [] } = {}) {
  const userMap = new Map();
  const linkMap = new Map();

  const uniqueUsers = Array.from(new Set((userIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))).slice(0, 500);
  const uniqueLinks = Array.from(new Set((urlIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))).slice(0, 1000);

  if (uniqueUsers.length) {
    const rows = await dbAllAsync(
      'SELECT id, alert_spike_multiplier, alert_spike_min_clicks, alert_drop_multiplier, ' +
        'alert_drop_min_baseline, alert_health_enabled FROM users WHERE id IN (' +
        uniqueUsers.map(() => '?').join(', ') + ')',
      uniqueUsers
    ).catch(() => []);
    for (const row of rows || []) userMap.set(Number(row.id), row);
  }

  if (uniqueLinks.length) {
    const rows = await dbAllAsync(
      'SELECT * FROM link_alert_settings WHERE url_id IN (' + uniqueLinks.map(() => '?').join(', ') + ')',
      uniqueLinks
    ).catch(() => []);
    for (const row of rows || []) linkMap.set(Number(row.url_id), row);
  }

  return { userMap, linkMap };
}

// ---------------------------------------------------------------------------
// Scan 1: spikes and drops
// ---------------------------------------------------------------------------
async function scanClickAnomalies({ now = new Date(), settings } = {}) {
  const cfg = buildSettings(settings);
  const today = isoDay(now);
  const startDay = isoDay(addDays(now, -cfg.baselineDays));

  const rows = await dbAllAsync(
    'SELECT u.id AS url_id, u.user_id, u.short, ' +
      'COALESCE(SUM(CASE WHEN d.day = ? THEN d.clicks ELSE 0 END), 0) AS today_clicks, ' +
      'COALESCE(SUM(CASE WHEN d.day >= ? AND d.day < ? THEN d.clicks ELSE 0 END), 0) AS baseline_clicks ' +
      'FROM urls u JOIN link_stats_daily d ON d.url_id = u.id ' +
      'WHERE COALESCE(u.disabled, 0) = 0 AND d.day >= ? ' +
      'GROUP BY u.id, u.user_id, u.short ' +
      'ORDER BY today_clicks DESC, u.id ASC ' +
      'LIMIT ?',
    [today, startDay, today, startDay, cfg.scanLinkLimit]
  ).catch(() => []);

  const summary = { scanned: (rows || []).length, flagged: 0, notified: 0 };
  if (!rows || !rows.length) return summary;

  // One lookup per scan (not per link): user defaults and per-link overrides.
  const overrides = await loadAlertOverrides({
    userIds: rows.map((row) => row.user_id),
    urlIds: rows.map((row) => row.url_id),
  }).catch(() => ({ userMap: new Map(), linkMap: new Map() }));

  for (const row of rows) {
    const todayClicks = Number(row.today_clicks || 0);
    const baselineAverage = Number(row.baseline_clicks || 0) / cfg.baselineDays;
    const rowSettings = mergeAlertSettings(
      cfg,
      overrides.userMap.get(Number(row.user_id)) || null,
      overrides.linkMap.get(Number(row.url_id)) || null
    );
    const flags = evaluateCounts(todayClicks, baselineAverage, rowSettings, { now, isToday: true });
    for (const flag of flags) {
      summary.flagged += 1;
      summary.notified += await dispatchAnomaly(row, { ...flag, day: today });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Scan 2: click limits about to be exhausted
// ---------------------------------------------------------------------------
async function scanLimitWarnings({ now = new Date(), settings } = {}) {
  const cfg = buildSettings(settings);
  const today = isoDay(now);

  const rows = await dbAllAsync(
    'SELECT u.id AS url_id, u.user_id, u.short, u.max_clicks, COALESCE(SUM(d.clicks), 0) AS clicks ' +
      'FROM urls u JOIN link_stats_daily d ON d.url_id = u.id ' +
      'WHERE COALESCE(u.disabled, 0) = 0 AND COALESCE(u.max_clicks, 0) > 0 ' +
      'GROUP BY u.id, u.user_id, u.short, u.max_clicks ' +
      'HAVING COALESCE(SUM(d.clicks), 0) >= u.max_clicks * ? AND COALESCE(SUM(d.clicks), 0) < u.max_clicks ' +
      'LIMIT ?',
    [cfg.limitWarnRatio, cfg.scanLinkLimit]
  ).catch(() => []);

  const summary = { scanned: (rows || []).length, flagged: 0, notified: 0 };

  for (const row of rows || []) {
    const maxClicks = Number(row.max_clicks || 0);
    if (!(maxClicks > 0)) continue;
    const clicks = Number(row.clicks || 0);
    const percent = Math.min(99, Math.floor((clicks / maxClicks) * 100));
    const flag = {
      kind: ANOMALY_KINDS.LIMIT,
      severity: 'warning',
      clicks,
      baseline_average: maxClicks,
      percent,
      day: today,
    };
    summary.flagged += 1;
    summary.notified += await dispatchAnomaly(row, flag);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Scan 3: destination health
// ---------------------------------------------------------------------------
async function resolveHostnameIps(hostname) {
  const resolver = dns.lookup(hostname, { all: true, verbatim: true })
    .then((rows) => (rows || []).map((row) => (row && row.address ? String(row.address) : '')).filter(Boolean))
    .catch(() => []);
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), DNS_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  });
  const ips = await Promise.race([resolver, timeout]);
  return Array.isArray(ips) ? ips : [];
}

/**
 * Resolves a destination to a pinned IP, refusing anything the outbound guards
 * consider private, loopback or a non-web service port.
 */
async function resolveDestinationTarget(rawUrl) {
  let parsed;
  try {
    parsed = new URL((rawUrl || '').toString().trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (isBlockedWebhookPort(getEffectivePort(parsed))) return null;

  const hostname = (parsed.hostname || '').toString().trim().toLowerCase().replace(/\.+$/, '');
  if (!hostname) return null;

  const directVersion = net.isIP(hostname);
  if (directVersion) {
    if (isBlockedWebhookIp(hostname)) return null;
    return { targetUrl: parsed.toString(), pinnedIp: hostname };
  }

  if (isBlockedWebhookHostname(hostname)) return null;
  const ips = await resolveHostnameIps(hostname);
  const pinnedIp = ips.find((ip) => !isBlockedWebhookIp(ip));
  if (!pinnedIp) return null;
  return { targetUrl: parsed.toString(), pinnedIp };
}

/** 2xx/3xx is healthy; 4xx/5xx is not. Redirects are deliberately not followed. */
function classifyStatus(statusCode) {
  const status = Number.parseInt(statusCode, 10);
  if (!Number.isInteger(status) || status <= 0) return { ok: false, status: 0, reason: 'no_response' };
  if (status >= 200 && status < 400) return { ok: true, status, reason: '' };
  return { ok: false, status, reason: `http_${status}` };
}

/**
 * Requests the destination with a pinned IP and only keeps the status line.
 * `ok: null` means "not probeable" (blocked target, DNS failure) rather than
 * "down", so an unprobeable host never produces a false alarm.
 */
async function probeDestination(rawUrl, { timeoutMs = DEFAULT_SETTINGS.healthTimeoutMs } = {}) {
  const target = await resolveDestinationTarget(rawUrl).catch(() => null);
  if (!target) return { ok: null, status: 0, reason: 'not_probeable' };

  return new Promise((resolve) => {
    let settled = false;
    let gotResponse = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    let parsed;
    try {
      parsed = new URL(target.targetUrl);
    } catch {
      return finish({ ok: null, status: 0, reason: 'not_probeable' });
    }

    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const ipFamily = net.isIP(target.pinnedIp);
    if (!ipFamily) return finish({ ok: null, status: 0, reason: 'not_probeable' });

    let req;
    try {
      req = transport.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port ? Number.parseInt(parsed.port, 10) : (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: {
            host: parsed.host,
            'user-agent': 'OvlinkHealthCheck/1.0 (+https://ovlink.sbs)',
            accept: 'text/html,*/*;q=0.8',
            'cache-control': 'no-cache',
          },
          servername: isHttps ? parsed.hostname : undefined,
          lookup: (_hostname, _options, callback) => {
            callback(null, target.pinnedIp, ipFamily);
          },
        },
        (res) => {
          gotResponse = true;
          const check = classifyStatus(res.statusCode);
          // Status is all we need; drop the socket before the body arrives.
          res.destroy();
          finish(check);
        }
      );
    } catch (err) {
      return finish({ ok: null, status: 0, reason: (err && err.code) || 'request_failed' });
    }

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => finish({ ok: false, status: 0, reason: (err && (err.code || err.message)) || 'network_error' }));
    // A socket that closes before a status line means the connection really did
    // fail; once a response arrived the probe already finished.
    req.on('close', () => {
      if (!gotResponse) finish({ ok: false, status: 0, reason: 'connection_closed' });
    });
    req.end();
  });
}

async function scanDestinationHealth({ now = new Date(), settings, probe = probeDestination } = {}) {
  const cfg = buildSettings(settings);
  const summary = { checked: 0, failed: 0, skipped: 0, notified: 0 };
  if (!cfg.healthEnabled) return summary;

  const recentStart = isoDay(addDays(now, -7));
  const recheckBefore = new Date(now.getTime() - cfg.healthRecheckHours * 60 * 60 * 1000).toISOString();

  const rows = await dbAllAsync(
    'SELECT u.id AS url_id, u.user_id, u.short, u.original ' +
      'FROM urls u JOIN link_stats_daily d ON d.url_id = u.id AND d.day >= ? ' +
      'WHERE COALESCE(u.disabled, 0) = 0 ' +
      'AND (u.last_health_checked_at IS NULL OR u.last_health_checked_at < ?) ' +
      'GROUP BY u.id, u.user_id, u.short, u.original ' +
      'HAVING COALESCE(SUM(d.clicks), 0) >= ? ' +
      'ORDER BY COALESCE(SUM(d.clicks), 0) DESC ' +
      'LIMIT ?',
    [recentStart, recheckBefore, cfg.healthMinClicks, cfg.healthBatchLimit]
  ).catch(() => []);

  // The env flag stays the master switch: overrides can disable a probe, never
  // turn probing on when the operator turned it off.
  const overrides = rows && rows.length
    ? await loadAlertOverrides({ userIds: rows.map((row) => row.user_id), urlIds: rows.map((row) => row.url_id) })
      .catch(() => ({ userMap: new Map(), linkMap: new Map() }))
    : { userMap: new Map(), linkMap: new Map() };

  for (const row of rows || []) {
    const original = (row.original || '').toString();
    if (!/^https?:\/\//i.test(original)) continue;

    const rowSettings = mergeAlertSettings(
      cfg,
      overrides.userMap.get(Number(row.user_id)) || null,
      overrides.linkMap.get(Number(row.url_id)) || null
    );
    if (rowSettings.healthEnabled === false) {
      summary.skipped += 1;
      continue;
    }

    const result = await probe(original, { timeoutMs: cfg.healthTimeoutMs }).catch(() => ({
      ok: null,
      status: 0,
      reason: 'probe_error',
    }));

    if (!result || result.ok === null) {
      summary.skipped += 1;
      await dbRunAsync(
        'UPDATE urls SET last_health_status = ?, last_health_checked_at = ?, last_health_error = ? WHERE id = ?',
        [0, now.toISOString(), String((result && result.reason) || 'not_probeable').slice(0, 120), row.url_id]
      ).catch(() => null);
      continue;
    }

    summary.checked += 1;
    await dbRunAsync(
      'UPDATE urls SET last_health_status = ?, last_health_checked_at = ?, last_health_error = ? WHERE id = ?',
      [result.status, now.toISOString(), result.ok ? null : String(result.reason || '').slice(0, 120), row.url_id]
    ).catch(() => null);

    if (result.ok) continue;
    summary.failed += 1;
    summary.notified += await dispatchAnomaly(
      row,
      {
        kind: ANOMALY_KINDS.HEALTH,
        severity: 'critical',
        day: isoDay(now),
        clicks: result.status,
        baseline_average: 0,
        reason: result.reason || `http_${result.status}`,
      }
    );
  }

  return summary;
}

async function runAnomalyScan({ now = new Date(), settings } = {}) {
  const [clicks, limits] = await Promise.all([
    scanClickAnomalies({ now, settings }).catch(() => ({ scanned: 0, flagged: 0, notified: 0 })),
    scanLimitWarnings({ now, settings }).catch(() => ({ scanned: 0, flagged: 0, notified: 0 })),
  ]);
  const health = await scanDestinationHealth({ now, settings }).catch(() => ({
    checked: 0,
    failed: 0,
    skipped: 0,
    notified: 0,
  }));

  return { clicks, limits, health, ran_at: now.toISOString() };
}

// ---------------------------------------------------------------------------
// Read-only insights for one link (powers the stats page panel)
// ---------------------------------------------------------------------------
async function loadLinkAnomalyInsights(urlId, { days = 30, now = new Date(), settings } = {}) {
  const id = Number.parseInt(urlId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;

  const cfg = buildSettings(settings);
  const safeDays = Math.min(Math.max(Number.parseInt(days, 10) || 30, 7), 365);
  const startDay = isoDay(addDays(now, -(safeDays - 1)));

  const [rows, ownerRow, linkOverride] = await Promise.all([
    dbAllAsync(
      'SELECT day, clicks FROM link_stats_daily WHERE url_id = ? AND day >= ? ORDER BY day ASC LIMIT 400',
      [id, startDay]
    ).catch(() => []),
    dbGetAsync('SELECT id AS user_id FROM urls WHERE id = ?', [id]).catch(() => null),
    dbGetAsync('SELECT * FROM link_alert_settings WHERE url_id = ?', [id]).catch(() => null),
  ]);

  let userOverride = null;
  if (ownerRow && ownerRow.user_id) {
    userOverride = await dbGetAsync(
      'SELECT alert_spike_multiplier, alert_spike_min_clicks, alert_drop_multiplier, ' +
        'alert_drop_min_baseline, alert_health_enabled FROM users WHERE id = ?',
      [ownerRow.user_id]
    ).catch(() => null);
  }

  const counts = {};
  for (const row of rows || []) {
    if (row && row.day) counts[String(row.day)] = Number(row.clicks || 0);
  }

  const series = buildDaySeries(startDay, isoDay(now), counts).map((point) => ({
    date: point.date,
    clicks: point.count,
  }));
  const effective = mergeAlertSettings(cfg, userOverride, linkOverride);
  const anomalies = detectSeriesAnomalies(series, effective, { now });
  const described = describeThresholds(cfg, userOverride, linkOverride);

  return {
    days: safeDays,
    series,
    anomalies,
    thresholds: {
      baseline_days: effective.baselineDays,
      spike_multiplier: effective.spikeMultiplier,
      spike_min_clicks: effective.spikeMinClicks,
      drop_multiplier: effective.dropMultiplier,
      drop_min_baseline: effective.dropMinBaselineAvg,
      health_enabled: effective.healthEnabled !== false,
      sources: {
        spike_multiplier: described.spikeMultiplier.source,
        spike_min_clicks: described.spikeMinClicks.source,
        drop_multiplier: described.dropMultiplier.source,
        drop_min_baseline: described.dropMinBaseline.source,
        health_enabled: described.healthEnabled.source,
      },
    },
  };
}

let schedulerTimer = null;
let schedulerInterval = null;

function scheduleAnomalyAlerts({ intervalMs = 30 * 60 * 1000, startDelayMs = 5 * 60 * 1000 } = {}) {
  if (schedulerTimer || schedulerInterval) return schedulerTimer || schedulerInterval;

  const run = () => {
    beat('anomaly-alerts');
    void runAnomalyScan().catch((err) => {
      console.error('[anomaly-alerts] scan failed:', err && (err.message || err));
    });
  };

  schedulerTimer = setTimeout(() => {
    run();
    schedulerInterval = setInterval(run, intervalMs);
    if (typeof schedulerInterval.unref === 'function') schedulerInterval.unref();
  }, startDelayMs);
  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref();
  return schedulerTimer;
}

function stopAnomalyAlerts() {
  if (schedulerTimer) clearTimeout(schedulerTimer);
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerTimer = null;
  schedulerInterval = null;
}

module.exports = {
  ANOMALY_KINDS,
  WEBHOOK_EVENTS,
  DEFAULT_SETTINGS,
  buildSettings,
  normalizeSeries,
  evaluateCounts,
  detectSeriesAnomalies,
  buildAnomalyPayload,
  insertAnomalyNotification,
  scanClickAnomalies,
  scanLimitWarnings,
  scanDestinationHealth,
  runAnomalyScan,
  loadLinkAnomalyInsights,
  classifyStatus,
  resolveDestinationTarget,
  probeDestination,
  scheduleAnomalyAlerts,
  stopAnomalyAlerts,
};
