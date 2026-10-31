'use strict';

const { beat } = require('./worker-heartbeat');

/**
 * Weekly statistics report (opt-in e-mail).
 *
 * Runs on a timer: finds users who opted in, builds a 7-day summary from the
 * rollup tables and sends one digest. Nothing is sent for accounts without any
 * activity in the window.
 */

const { dbGetAsync, dbAllAsync, dbRunAsync } = require('../db/helpers');
const { sendStatsReportEmail } = require('./email');
const { safeDecrypt } = require('../../utils/crypto');
const { normalizeLang } = require('./i18n');
const { getConfiguredPublicBaseUrl } = require('./security');
const { isoDay, addDays, percentDelta } = require('./link-stats');

const REPORT_WINDOW_DAYS = 7;
const REPORT_RESEND_GUARD_DAYS = 6;
const REPORT_BATCH_LIMIT = 50;
const REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REPORT_START_DELAY_MS = 10 * 60 * 1000;

function buildDashboardUrl() {
  const base = getConfiguredPublicBaseUrl();
  return base ? `${base}/dashboard` : '/dashboard';
}

/**
 * Aggregated summary for one user over the last `days` days, compared with the
 * window before it.
 */
async function loadWeeklySummary(userId, { days = REPORT_WINDOW_DAYS, now = new Date() } = {}) {
  const id = Number.parseInt(userId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;

  const safeDays = Number.isInteger(days) && days > 0 ? days : REPORT_WINDOW_DAYS;
  const currentStart = addDays(now, -safeDays);
  const previousStart = addDays(now, -(safeDays * 2));
  const currentStartDay = isoDay(currentStart);
  const previousStartDay = isoDay(previousStart);
  const nowIso = now.toISOString();

  const [totalsRow, previousRow, linksRow, sourceRow] = await Promise.all([
    dbGetAsync(
      'SELECT COALESCE(SUM(d.clicks), 0) AS clicks, COALESCE(SUM(d.uniques), 0) AS uniques, ' +
        'COALESCE(SUM(d.conversions), 0) AS conversions ' +
        'FROM link_stats_daily d JOIN urls u ON u.id = d.url_id ' +
        'WHERE u.user_id = ? AND d.day >= ?',
      [id, currentStartDay]
    ).catch(() => null),
    dbGetAsync(
      'SELECT COALESCE(SUM(d.clicks), 0) AS clicks, COALESCE(SUM(d.uniques), 0) AS uniques ' +
        'FROM link_stats_daily d JOIN urls u ON u.id = d.url_id ' +
        'WHERE u.user_id = ? AND d.day >= ? AND d.day < ?',
      [id, previousStartDay, currentStartDay]
    ).catch(() => null),
    dbAllAsync(
      'SELECT u.short, COALESCE(SUM(d.clicks), 0) AS clicks, COALESCE(SUM(d.uniques), 0) AS uniques ' +
        'FROM urls u LEFT JOIN link_stats_daily d ON d.url_id = u.id AND d.day >= ? ' +
        'WHERE u.user_id = ? ' +
        'GROUP BY u.short HAVING COALESCE(SUM(d.clicks), 0) > 0 ' +
        'ORDER BY clicks DESC LIMIT 5',
      [currentStartDay, id]
    ).catch(() => []),
    dbGetAsync(
      "SELECT COALESCE(NULLIF(c.referrer_host, ''), 'direct') AS name, COUNT(*) AS count " +
        'FROM clicks c JOIN urls u ON u.id = c.url_id ' +
        'WHERE u.user_id = ? AND c.click_time >= ? ' +
        "GROUP BY COALESCE(NULLIF(c.referrer_host, ''), 'direct') ORDER BY count DESC LIMIT 1",
      [id, currentStart.toISOString()]
    ).catch(() => null),
  ]);

  const clicks = totalsRow ? Number(totalsRow.clicks || 0) : 0;
  const uniques = totalsRow ? Number(totalsRow.uniques || 0) : 0;
  const conversions = totalsRow ? Number(totalsRow.conversions || 0) : 0;
  const previousClicks = previousRow ? Number(previousRow.clicks || 0) : 0;
  const previousUniques = previousRow ? Number(previousRow.uniques || 0) : 0;

  return {
    days: safeDays,
    period_from: currentStartDay,
    period_to: isoDay(now),
    generated_at: nowIso,
    clicks,
    uniques,
    conversions,
    conversion_rate: clicks > 0 ? Math.round((conversions / clicks) * 1000) / 10 : 0,
    previous: { clicks: previousClicks, uniques: previousUniques },
    deltas: {
      clicks_percent: percentDelta(clicks, previousClicks),
      uniques_percent: percentDelta(uniques, previousUniques),
    },
    top_links: (linksRow || []).map((row) => ({
      short: row.short,
      clicks: Number(row.clicks || 0),
      uniques: Number(row.uniques || 0),
    })),
    top_source: sourceRow ? sourceRow.name : '',
    dashboard_url: buildDashboardUrl(),
  };
}

function readReportFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value === true ? '1' : value).toLowerCase());
}

async function setReportPreference(userId, enabled) {
  const id = Number.parseInt(userId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const flag = readReportFlag(enabled) ? 1 : 0;
  await dbRunAsync('UPDATE users SET stats_report_enabled = ? WHERE id = ?', [flag, id]).catch(() => null);
  return { enabled: flag === 1 };
}

async function getReportPreference(userId) {
  const id = Number.parseInt(userId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await dbGetAsync(
    'SELECT stats_report_enabled, stats_report_last_sent_at FROM users WHERE id = ?',
    [id]
  ).catch(() => null);
  if (!row) return null;
  return {
    enabled: Number(row.stats_report_enabled || 0) === 1,
    last_sent_at: row.stats_report_last_sent_at || null,
  };
}

/**
 * Sends the digest to everybody who is due. Returns counters for observability.
 */
async function sendWeeklyStatsReports({ now = new Date(), limit = REPORT_BATCH_LIMIT } = {}) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : REPORT_BATCH_LIMIT;
  const guardCutoff = addDays(now, -REPORT_RESEND_GUARD_DAYS).toISOString();

  const recipients = await dbAllAsync(
    'SELECT id, email, ui_lang FROM users ' +
      'WHERE stats_report_enabled = 1 AND COALESCE(email_verified, 0) = 1 AND COALESCE(banned, 0) = 0 ' +
      'AND (stats_report_last_sent_at IS NULL OR stats_report_last_sent_at < ?) ' +
      'ORDER BY id ASC LIMIT ?',
    [guardCutoff, safeLimit]
  ).catch(() => []);

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const user of recipients || []) {
    const summary = await loadWeeklySummary(user.id, { now }).catch(() => null);
    if (!summary || (summary.clicks === 0 && summary.conversions === 0)) {
      skipped += 1;
      continue;
    }

    const email = safeDecrypt(user.email, '');
    if (!email || !email.includes('@')) {
      skipped += 1;
      continue;
    }

    try {
      await sendStatsReportEmail(email, summary, normalizeLang(user.ui_lang, 'az'));
      await dbRunAsync('UPDATE users SET stats_report_last_sent_at = ? WHERE id = ?', [now.toISOString(), user.id]);
      sent += 1;
    } catch (err) {
      failed += 1;
      console.warn('[stats-report] send failed', user.id, err && (err.message || err));
    }
  }

  if (sent || failed) {
    console.log(`[stats-report] sent=${sent} skipped=${skipped} failed=${failed}`);
  }
  return { sent, skipped, failed, candidates: (recipients || []).length };
}

function scheduleWeeklyStatsReports() {
  const run = () => {
    beat('stats-report');
    void sendWeeklyStatsReports().catch((err) => {
      console.warn('[stats-report] run failed:', err && (err.message || err));
    });
  };

  const startTimer = setTimeout(run, REPORT_START_DELAY_MS);
  if (typeof startTimer.unref === 'function') startTimer.unref();

  const interval = setInterval(run, REPORT_INTERVAL_MS);
  if (typeof interval.unref === 'function') interval.unref();
  return interval;
}

module.exports = {
  REPORT_WINDOW_DAYS,
  REPORT_RESEND_GUARD_DAYS,
  REPORT_BATCH_LIMIT,
  REPORT_INTERVAL_MS,
  REPORT_START_DELAY_MS,
  loadWeeklySummary,
  readReportFlag,
  setReportPreference,
  getReportPreference,
  sendWeeklyStatsReports,
  scheduleWeeklyStatsReports,
};
