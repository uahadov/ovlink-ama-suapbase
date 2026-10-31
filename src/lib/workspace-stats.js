'use strict';

/**
 * Workspace (team/agency) rollup.
 *
 * Same shape as the per-link payload, but aggregated over every link assigned
 * to the workspace. All aggregation happens in SQL over the rollup tables, so a
 * workspace with thousands of links still answers in one round-trip per metric.
 */

const { dbGetAsync, dbAllAsync } = require('../db/helpers');
const { isoDay, addDays, percentDelta, buildDaySeries, MAX_SERIES_POINTS } = require('./link-stats');

const WORKSPACE_ALLOWED_DAYS = new Set([7, 30, 90, 365]);

function normalizeWorkspaceDays(rawDays) {
  const value = Number.parseInt(rawDays, 10);
  return WORKSPACE_ALLOWED_DAYS.has(value) ? value : 30;
}

function rate(part, total) {
  const p = Number(part || 0);
  const t = Number(total || 0);
  if (!(t > 0) || !Number.isFinite(p)) return 0;
  return Math.round((p / t) * 1000) / 10;
}

async function loadWorkspaceStats(workspaceId, { days = 30, now = new Date() } = {}) {
  const id = Number.parseInt(workspaceId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;

  const safeDays = normalizeWorkspaceDays(days);
  const startDay = isoDay(addDays(now, -(safeDays - 1)));
  const previousStartDay = isoDay(addDays(now, -((safeDays * 2) - 1)));
  const todayDay = isoDay(now);
  const rangeStartIso = new Date(`${startDay}T00:00:00.000Z`).toISOString();

  const [totalsRow, previousRow, dailyRows, linkRows, sourceRows, deviceRows, goalRows] = await Promise.all([
    dbGetAsync(
      'SELECT COALESCE(SUM(d.clicks), 0) AS clicks, COALESCE(SUM(d.uniques), 0) AS uniques, ' +
        'COALESCE(SUM(d.bots), 0) AS bots, COALESCE(SUM(d.conversions), 0) AS conversions ' +
        'FROM link_stats_daily d JOIN urls u ON u.id = d.url_id ' +
        'WHERE u.workspace_id = ? AND d.day >= ? AND d.day <= ?',
      [id, startDay, todayDay]
    ).catch(() => null),
    dbGetAsync(
      'SELECT COALESCE(SUM(d.clicks), 0) AS clicks, COALESCE(SUM(d.uniques), 0) AS uniques ' +
        'FROM link_stats_daily d JOIN urls u ON u.id = d.url_id ' +
        'WHERE u.workspace_id = ? AND d.day >= ? AND d.day < ?',
      [id, previousStartDay, startDay]
    ).catch(() => null),
    dbAllAsync(
      'SELECT d.day AS day, COALESCE(SUM(d.clicks), 0) AS clicks, COALESCE(SUM(d.uniques), 0) AS uniques, ' +
        'COALESCE(SUM(d.conversions), 0) AS conversions ' +
        'FROM link_stats_daily d JOIN urls u ON u.id = d.url_id ' +
        'WHERE u.workspace_id = ? AND d.day >= ? ' +
        'GROUP BY d.day ORDER BY d.day ASC LIMIT ?',
      [id, startDay, MAX_SERIES_POINTS]
    ).catch(() => []),
    dbAllAsync(
      'SELECT u.short AS short, COALESCE(SUM(d.clicks), 0) AS clicks, COALESCE(SUM(d.uniques), 0) AS uniques, ' +
        'COALESCE(SUM(d.conversions), 0) AS conversions ' +
        'FROM link_stats_daily d JOIN urls u ON u.id = d.url_id ' +
        'WHERE u.workspace_id = ? AND d.day >= ? ' +
        'GROUP BY u.short ORDER BY clicks DESC LIMIT 10',
      [id, startDay]
    ).catch(() => []),
    dbAllAsync(
      "SELECT COALESCE(NULLIF(c.referrer_host, ''), 'direct') AS name, COUNT(*) AS count " +
        'FROM clicks c JOIN urls u ON u.id = c.url_id ' +
        'WHERE u.workspace_id = ? AND c.click_time >= ? AND COALESCE(c.is_bot, 0) = 0 ' +
        "GROUP BY COALESCE(NULLIF(c.referrer_host, ''), 'direct') ORDER BY count DESC LIMIT 8",
      [id, rangeStartIso]
    ).catch(() => []),
    dbAllAsync(
      "SELECT COALESCE(NULLIF(c.device_type, ''), 'unknown') AS name, COUNT(*) AS count " +
        'FROM clicks c JOIN urls u ON u.id = c.url_id ' +
        'WHERE u.workspace_id = ? AND c.click_time >= ? AND COALESCE(c.is_bot, 0) = 0 ' +
        "GROUP BY COALESCE(NULLIF(c.device_type, ''), 'unknown') ORDER BY count DESC LIMIT 8",
      [id, rangeStartIso]
    ).catch(() => []),
    dbAllAsync(
      'SELECT lc.goal AS name, COUNT(*) AS count ' +
        'FROM link_conversions lc JOIN urls u ON u.id = lc.url_id ' +
        'WHERE u.workspace_id = ? AND lc.day >= ? ' +
        'GROUP BY lc.goal ORDER BY count DESC LIMIT 8',
      [id, startDay]
    ).catch(() => []),
  ]);

  const clicks = totalsRow ? Number(totalsRow.clicks || 0) : 0;
  const uniques = totalsRow ? Number(totalsRow.uniques || 0) : 0;
  const bots = totalsRow ? Number(totalsRow.bots || 0) : 0;
  const conversions = totalsRow ? Number(totalsRow.conversions || 0) : 0;
  const previousClicks = previousRow ? Number(previousRow.clicks || 0) : 0;
  const previousUniques = previousRow ? Number(previousRow.uniques || 0) : 0;

  const clickMap = {};
  const uniqueMap = {};
  const conversionMap = {};
  for (const row of dailyRows || []) {
    if (!row || !row.day) continue;
    const day = String(row.day);
    clickMap[day] = Number(row.clicks || 0);
    uniqueMap[day] = Number(row.uniques || 0);
    conversionMap[day] = Number(row.conversions || 0);
  }

  const series = buildDaySeries(startDay, todayDay, clickMap).map((point) => ({
    date: point.date,
    clicks: point.count,
    uniques: Number(uniqueMap[point.date] || 0),
    conversions: Number(conversionMap[point.date] || 0),
  }));

  return {
    workspace_id: id,
    days: safeDays,
    period: { from: startDay, to: todayDay },
    totals: {
      clicks,
      uniques,
      bots,
      conversions,
      conversion_rate: rate(conversions, clicks),
      bot_rate: rate(bots, clicks),
    },
    previous: { clicks: previousClicks, uniques: previousUniques },
    deltas: {
      clicks_percent: percentDelta(clicks, previousClicks),
      uniques_percent: percentDelta(uniques, previousUniques),
    },
    series,
    top_links: (linkRows || []).map((row) => ({
      short: row.short,
      clicks: Number(row.clicks || 0),
      uniques: Number(row.uniques || 0),
      conversions: Number(row.conversions || 0),
    })),
    sources: (sourceRows || []).map((row) => ({ name: row.name, count: Number(row.count || 0) })),
    devices: (deviceRows || []).map((row) => ({ name: row.name, count: Number(row.count || 0) })),
    goals: (goalRows || []).map((row) => ({ name: row.name, count: Number(row.count || 0) })),
  };
}

module.exports = {
  WORKSPACE_ALLOWED_DAYS,
  normalizeWorkspaceDays,
  loadWorkspaceStats,
};
