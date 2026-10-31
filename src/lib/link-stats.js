'use strict';

/**
 * Link statistics service.
 *
 * One implementation is shared by the session dashboard (`/api/stats/:short`),
 * the Pro API (`/api/pro/v1/links/:short/stats`) and the CSV export, so the
 * numbers can never drift between surfaces.
 */

const { dbGetAsync, dbAllAsync } = require('../db/helpers');
const { REDIRECT_CONSENT_MARKER } = require('./consent');

const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 365;
const DEFAULT_RAW_LIMIT = 2000;
const MAX_RAW_LIMIT = 5000;
const MAX_EXPORT_ROWS = 20000;
const GROUP_LIMIT = 12;
const MAX_SERIES_POINTS = 400;

const RAW_CLICK_COLUMNS =
  'click_time, browser, os, country, city, device_type, referrer_host, utm_source, ' +
  'utm_medium, utm_campaign, is_bot, variant';

function toInt(raw, fallback) {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Percentage change against the previous window. Returns null when there is no
 * baseline (previous = 0), so the UI can show "new" instead of a fake +100%.
 */
function percentDelta(current, previous) {
  const cur = Number(current || 0);
  const prev = Number(previous || 0);
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null;
  if (prev === 0) return cur === 0 ? 0 : null;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** `?days=7|30|90|365|all`. Anything invalid falls back to the default window. */
function parseRange(rawDays) {
  const raw = (rawDays || '').toString().trim().toLowerCase();
  if (raw === 'all' || raw === '0') return { all: true, days: null };
  const parsed = toInt(raw, NaN);
  if (!Number.isFinite(parsed) || parsed <= 0) return { all: false, days: DEFAULT_RANGE_DAYS };
  return { all: false, days: clamp(parsed, 1, MAX_RANGE_DAYS) };
}

function parseBotsFilter(rawValue) {
  const value = (rawValue || '').toString().trim().toLowerCase();
  return !['exclude', '0', 'false', 'no', 'off', 'human'].includes(value);
}

function normalizeBucketName(raw) {
  const value = (raw === null || raw === undefined ? '' : raw).toString().trim();
  return value || 'Unknown';
}

function rowsToCountMap(rows) {
  const map = {};
  (rows || []).forEach((row) => {
    const key = normalizeBucketName(row.name);
    map[key] = (map[key] || 0) + Number(row.count || 0);
  });
  return map;
}

function topEntries(rows, limit = GROUP_LIMIT) {
  return (rows || [])
    .map((row) => ({ name: normalizeBucketName(row.name), count: Number(row.count || 0) }))
    .filter((item) => item.count > 0)
    .slice(0, limit);
}

/**
 * Builds a zero-filled day series so charts never "jump" over quiet days.
 * Capped at MAX_SERIES_POINTS so an "all time" view on an old link stays small.
 */
function buildDaySeries(startDay, endDay, countMap) {
  const series = [];
  if (!startDay || !endDay) return series;
  let cursor = new Date(`${startDay}T00:00:00.000Z`);
  const end = new Date(`${endDay}T00:00:00.000Z`);
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(end.getTime())) return series;

  const totalDays = Math.floor((end.getTime() - cursor.getTime()) / 86400000) + 1;
  if (totalDays > MAX_SERIES_POINTS) {
    cursor = addDays(end, -(MAX_SERIES_POINTS - 1));
  }

  while (cursor.getTime() <= end.getTime()) {
    const day = isoDay(cursor);
    series.push({ date: day, count: Number(countMap[day] || 0) });
    cursor = addDays(cursor, 1);
  }
  return series;
}

function buildWindow(query, now = new Date()) {
  const range = parseRange(query && (query.days || query.range));
  const includeBots = parseBotsFilter(query && query.bots);
  const rangeStart = range.all ? null : addDays(now, -range.days);

  return {
    now,
    range,
    includeBots,
    endDay: isoDay(now),
    rangeStartIso: rangeStart ? rangeStart.toISOString() : null,
    rangeStartDay: rangeStart ? isoDay(rangeStart) : null,
    rangeClause: rangeStart ? ' AND click_time >= ?' : '',
    rangeParams: rangeStart ? [rangeStart.toISOString()] : [],
    botClause: includeBots ? '' : ' AND COALESCE(is_bot, 0) = 0',
  };
}

async function loadAllTimeTotals(urlId) {
  const rollup = await dbAllAsync(
    'SELECT COALESCE(SUM(clicks), 0) AS clicks, COALESCE(SUM(uniques), 0) AS uniques, ' +
      'COALESCE(SUM(bots), 0) AS bots, COALESCE(SUM(conversions), 0) AS conversions ' +
      'FROM link_stats_daily WHERE url_id = ?',
    [urlId]
  ).catch(() => null);

  const agg = rollup && rollup[0] ? rollup[0] : null;
  const rollupClicks = agg ? Number(agg.clicks || 0) : 0;
  if (rollupClicks > 0) {
    return {
      clicks: rollupClicks,
      uniques: Number(agg.uniques || 0),
      bots: Number(agg.bots || 0),
      conversions: Number(agg.conversions || 0),
      source: 'rollup',
    };
  }

  // Legacy links may predate the rollup table.
  const counted = await dbGetAsync('SELECT COUNT(*) AS clicks FROM clicks WHERE url_id = ?', [urlId]).catch(() => null);
  const countedBots = await dbGetAsync(
    'SELECT COUNT(*) AS bots FROM clicks WHERE url_id = ? AND COALESCE(is_bot, 0) = 1',
    [urlId]
  ).catch(() => null);
  const countedConversions = await dbGetAsync(
    'SELECT COUNT(*) AS conversions FROM link_conversions WHERE url_id = ?',
    [urlId]
  ).catch(() => null);
  return {
    clicks: counted ? Number(counted.clicks || 0) : 0,
    uniques: 0,
    bots: countedBots ? Number(countedBots.bots || 0) : 0,
    conversions: countedConversions ? Number(countedConversions.conversions || 0) : 0,
    source: 'clicks',
  };
}

function mapRawClick(click) {
  const browser = click.browser === REDIRECT_CONSENT_MARKER ? REDIRECT_CONSENT_MARKER : (click.browser || 'Unknown');
  const os = click.os === REDIRECT_CONSENT_MARKER ? REDIRECT_CONSENT_MARKER : (click.os || 'Unknown');
  const country = click.country === REDIRECT_CONSENT_MARKER ? REDIRECT_CONSENT_MARKER : (click.country || 'Unknown');
  return {
    time: click.click_time,
    browser,
    os,
    country,
    city: click.city === REDIRECT_CONSENT_MARKER ? '' : (click.city || ''),
    device_type: click.device_type || '',
    source: click.utm_source || click.referrer_host || '',
    campaign: click.utm_campaign || '',
    is_bot: Number(click.is_bot || 0) === 1,
    variant: click.variant || '',
  };
}

/**
 * Aggregates one link's statistics for the requested window.
 * All aggregation happens in SQL; only bounded result sets reach Node.
 */
async function loadLinkStats({ urlRow, query } = {}) {
  if (!urlRow || !urlRow.id) throw new Error('loadLinkStats requires a url row');

  const q = query && typeof query === 'object' ? query : {};
  const win = buildWindow(q);
  const rawLimit = clamp(toInt(q.limit, DEFAULT_RAW_LIMIT), 1, MAX_RAW_LIMIT);
  const { rangeClause, rangeParams, botClause, rangeStartDay, range, includeBots, now, endDay } = win;
  const urlId = urlRow.id;

  const bucketSql = (column) =>
    `SELECT ${column} AS name, COUNT(*) AS count FROM clicks ` +
    `WHERE url_id = ?${rangeClause}${botClause} ` +
    `GROUP BY ${column} ORDER BY count DESC LIMIT ${GROUP_LIMIT}`;

  const [
    totals,
    browsersRows,
    osRows,
    countriesRows,
    deviceRows,
    sourceRows,
    campaignRows,
    variantRows,
    dailyRows,
    hourlyRows,
    uniqueRows,
    rawRows,
    essentialRow,
    rangeCountRow,
    rangeBotRow,
    variantClicksRows,
    goalRows,
  ] = await Promise.all([
    loadAllTimeTotals(urlId),
    dbAllAsync(bucketSql('browser'), [urlId, ...rangeParams]).catch(() => []),
    dbAllAsync(bucketSql('os'), [urlId, ...rangeParams]).catch(() => []),
    dbAllAsync(bucketSql('country'), [urlId, ...rangeParams]).catch(() => []),
    dbAllAsync(bucketSql('device_type'), [urlId, ...rangeParams]).catch(() => []),
    dbAllAsync(bucketSql('referrer_host'), [urlId, ...rangeParams]).catch(() => []),
    dbAllAsync(bucketSql('utm_campaign'), [urlId, ...rangeParams]).catch(() => []),
    dbAllAsync(bucketSql('variant'), [urlId, ...rangeParams]).catch(() => []),
    dbAllAsync(
      `SELECT SUBSTR(click_time, 1, 10) AS name, COUNT(*) AS count FROM clicks ` +
        `WHERE url_id = ?${rangeClause}${botClause} GROUP BY SUBSTR(click_time, 1, 10)`,
      [urlId, ...rangeParams]
    ).catch(() => []),
    range.days && range.days <= 7
      ? dbAllAsync(
          `SELECT SUBSTR(click_time, 1, 13) AS name, COUNT(*) AS count FROM clicks ` +
            `WHERE url_id = ?${rangeClause}${botClause} GROUP BY SUBSTR(click_time, 1, 13)`,
          [urlId, ...rangeParams]
        ).catch(() => [])
      : Promise.resolve([]),
    dbAllAsync(
      'SELECT day AS name, uniques AS count, conversions FROM link_stats_daily WHERE url_id = ?' +
        (rangeStartDay ? ' AND day >= ?' : ''),
      rangeStartDay ? [urlId, rangeStartDay] : [urlId]
    ).catch(() => []),
    dbAllAsync(
      `SELECT ${RAW_CLICK_COLUMNS} FROM clicks ` +
        `WHERE url_id = ?${rangeClause}${botClause} ORDER BY click_time DESC LIMIT ?`,
      [urlId, ...rangeParams, rawLimit]
    ).catch(() => []),
    dbGetAsync(
      'SELECT COUNT(*) AS count FROM clicks WHERE url_id = ? AND browser = ?',
      [urlId, REDIRECT_CONSENT_MARKER]
    ).catch(() => null),
    dbGetAsync(
      `SELECT COUNT(*) AS count FROM clicks WHERE url_id = ?${rangeClause}${botClause}`,
      [urlId, ...rangeParams]
    ).catch(() => null),
    dbGetAsync(
      'SELECT COUNT(*) AS count FROM clicks WHERE url_id = ? AND COALESCE(is_bot, 0) = 1' + rangeClause,
      [urlId, ...rangeParams]
    ).catch(() => null),
    dbAllAsync(
      "SELECT variant AS name, COUNT(*) AS count FROM clicks WHERE url_id = ?" +
        `${rangeClause} AND variant IN ('a', 'b') GROUP BY variant`,
      [urlId, ...rangeParams]
    ).catch(() => []),
    dbAllAsync(
      'SELECT goal AS name, COUNT(*) AS count FROM link_conversions WHERE url_id = ?' +
        (rangeStartDay ? ' AND day >= ?' : '') +
        ' GROUP BY goal ORDER BY count DESC LIMIT 12',
      rangeStartDay ? [urlId, rangeStartDay] : [urlId]
    ).catch(() => []),
  ]);

  const browsers = rowsToCountMap(browsersRows);
  const os = rowsToCountMap(osRows);
  const countries = rowsToCountMap(countriesRows);
  const devices = rowsToCountMap(deviceRows);
  const campaigns = rowsToCountMap(campaignRows);
  const variants = rowsToCountMap(variantRows);

  // A missing referrer/UTM is "direct" traffic, not an unknown bucket.
  const sourceEntries = (sourceRows || []).map((row) => {
    const name = normalizeBucketName(row.name);
    return { name: name === 'Unknown' ? 'direct' : name, count: Number(row.count || 0) };
  });
  const sources = {};
  sourceEntries.forEach((entry) => {
    sources[entry.name] = (sources[entry.name] || 0) + entry.count;
  });

  const dayCounts = {};
  (dailyRows || []).forEach((row) => {
    const day = normalizeBucketName(row.name);
    if (day === 'Unknown') return;
    dayCounts[day] = (dayCounts[day] || 0) + Number(row.count || 0);
  });

  const uniqueByDay = {};
  const conversionsByDayCounts = {};
  (uniqueRows || []).forEach((row) => {
    const day = normalizeBucketName(row.name);
    if (day === 'Unknown') return;
    uniqueByDay[day] = (uniqueByDay[day] || 0) + Number(row.count || 0);
    conversionsByDayCounts[day] = (conversionsByDayCounts[day] || 0) + Number(row.conversions || 0);
  });

  const clickSeriesStart = rangeStartDay || Object.keys(dayCounts).sort()[0] || endDay;
  const clicksByDay = buildDaySeries(clickSeriesStart, endDay, dayCounts);
  const uniquesByDay = buildDaySeries(clickSeriesStart, endDay, uniqueByDay);
  const conversionsByDay = buildDaySeries(clickSeriesStart, endDay, conversionsByDayCounts);

  const clicksOverTime = {};
  (hourlyRows || []).forEach((row) => {
    const hour = normalizeBucketName(row.name);
    if (hour === 'Unknown') return;
    clicksOverTime[hour] = Number(row.count || 0);
  });

  const totalClicks = rangeCountRow ? Number(rangeCountRow.count || 0) : 0;

  let topCountry = '—';
  let topCountryCount = 0;
  Object.entries(countries).forEach(([country, count]) => {
    if (count > topCountryCount) {
      topCountry = country;
      topCountryCount = count;
    }
  });

  const variantClicks = {};
  (variantClicksRows || []).forEach((row) => {
    const key = normalizeBucketName(row.name);
    if (key !== 'a' && key !== 'b') return;
    variantClicks[key] = Number(row.count || 0);
  });

  const rangeUniques = uniquesByDay.reduce((sum, item) => sum + Number(item.count || 0), 0);
  const rangeConversions = conversionsByDay.reduce((sum, item) => sum + Number(item.count || 0), 0);
  const goals = rowsToCountMap(goalRows);
  const previous = range.all
    ? null
    : await loadPreviousWindowTotals({ urlId, days: range.days, includeBots });

  return {
    // Compatible with the existing dashboards.
    short: urlRow.short,
    original: urlRow.original,
    created_at: urlRow.created_at,
    total_clicks: totalClicks,
    clicks_total: totals.clicks,
    unique_visitors: totals.uniques,
    browsers,
    os,
    countries,
    clicks_over_time: clicksOverTime,
    clicks_by_day: clicksByDay,
    raw_clicks: (rawRows || []).map(mapRawClick),
    top_country: topCountry,
    top_country_count: topCountryCount,
    top_country_percent: totalClicks > 0 ? Math.round((topCountryCount / totalClicks) * 100) : 0,

    // Richer analytics surface.
    range: {
      days: range.all ? 'all' : range.days,
      from: win.rangeStartIso,
      to: now.toISOString(),
      bots: includeBots ? 'include' : 'exclude',
    },
    uniques_total: totals.uniques,
    // Links whose history predates the rollup have clicks but no visitor hashes;
    // say so instead of pretending "0 unique visitors".
    uniques_available: totals.uniques > 0 || totals.clicks === 0,
    uniques_range: rangeUniques,
    bots_total: totals.bots,
    bots_range: rangeBotRow ? Number(rangeBotRow.count || 0) : 0,
    totals_source: totals.source,
    uniques_by_day: uniquesByDay,
    devices,
    sources,
    campaigns,
    variants,
    variant_clicks: variantClicks,
    top_countries: topEntries(countriesRows),
    top_referrers: sourceEntries.slice(0, GROUP_LIMIT),
    top_campaigns: topEntries(campaignRows),
    top_devices: topEntries(deviceRows),
    essential_clicks: essentialRow ? Number(essentialRow.count || 0) : 0,
    conversions_total: totals.conversions,
    conversions_range: rangeConversions,
    conversion_rate: totalClicks > 0 ? Math.round((rangeConversions / totalClicks) * 1000) / 10 : 0,
    conversions_by_day: conversionsByDay,
    goals,
    top_goals: topEntries(goalRows),
    conversion_pixel_path: `/c/${urlRow.short}.gif`,
    raw_clicks_limit: rawLimit,
    raw_clicks_has_more: (rawRows || []).length >= rawLimit,
    max_clicks: urlRow.max_clicks || null,
    disabled: urlRow.disabled == 1,
    generated_at: now.toISOString(),

    // Period-over-period comparison (same length window, immediately before).
    previous,
    deltas: previous
      ? {
          clicks_percent: percentDelta(totalClicks, previous.clicks),
          uniques_percent: percentDelta(rangeUniques, previous.uniques),
        }
      : null,
  };
}

/**
 * Previous window of the same length, used for delta comparisons (Δ%).
 */
async function loadPreviousWindowTotals({ urlId, days, includeBots }) {
  if (!days || days <= 0) return null;
  const now = new Date();
  const currentStart = addDays(now, -days).toISOString();
  const previousStart = addDays(now, -(days * 2)).toISOString();
  const botClause = includeBots ? '' : ' AND COALESCE(is_bot, 0) = 0';

  const row = await dbGetAsync(
    `SELECT COUNT(*) AS clicks FROM clicks WHERE url_id = ? AND click_time >= ? AND click_time < ?${botClause}`,
    [urlId, previousStart, currentStart]
  ).catch(() => null);

  const uniqueRow = await dbGetAsync(
    'SELECT COALESCE(SUM(uniques), 0) AS uniques FROM link_stats_daily WHERE url_id = ? AND day >= ? AND day < ?',
    [urlId, isoDay(new Date(previousStart)), isoDay(new Date(currentStart))]
  ).catch(() => null);

  return {
    from: previousStart,
    to: currentStart,
    clicks: row ? Number(row.clicks || 0) : 0,
    uniques: uniqueRow ? Number(uniqueRow.uniques || 0) : 0,
  };
}

/** Raw click rows for export (bounded). */
async function loadRawClicks({ urlId, query, limit = MAX_EXPORT_ROWS } = {}) {
  const win = buildWindow(query && typeof query === 'object' ? query : {});
  const safeLimit = clamp(toInt(limit, MAX_EXPORT_ROWS), 1, MAX_EXPORT_ROWS);
  return dbAllAsync(
    `SELECT ${RAW_CLICK_COLUMNS} FROM clicks ` +
      `WHERE url_id = ?${win.rangeClause}${win.botClause} ORDER BY click_time DESC LIMIT ?`,
    [urlId, ...win.rangeParams, safeLimit]
  ).catch(() => []);
}

function escapeCsvCell(value) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  // Spreadsheet formula injection guard.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const PUBLIC_OMIT_KEYS = [
  'raw_clicks',
  'raw_clicks_limit',
  'raw_clicks_has_more',
  'essential_clicks',
  'totals_source',
];

/**
 * Strips click-level rows and internal diagnostics from a stats payload before
 * it is exposed to a shared / embeddable audience.
 */
function toPublicPayload(payload) {
  const out = { ...(payload || {}) };
  for (const key of PUBLIC_OMIT_KEYS) delete out[key];
  return out;
}

const CSV_COLUMNS = [
  'click_time',
  'browser',
  'os',
  'device_type',
  'country',
  'city',
  'referrer_host',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'variant',
  'is_bot',
];

/** Click-level CSV (Excel-friendly: UTF-8 BOM + CRLF). */
function buildClicksCsv(rows) {
  const lines = [CSV_COLUMNS.map(escapeCsvCell).join(',')];
  (rows || []).forEach((row) => {
    lines.push(
      CSV_COLUMNS.map((column) => {
        if (column === 'is_bot') return escapeCsvCell(Number(row.is_bot || 0) === 1 ? '1' : '0');
        return escapeCsvCell(row[column] === undefined ? '' : row[column]);
      }).join(',')
    );
  });
  return '\uFEFF' + lines.join('\r\n');
}

module.exports = {
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  DEFAULT_RAW_LIMIT,
  MAX_RAW_LIMIT,
  MAX_EXPORT_ROWS,
  GROUP_LIMIT,
  MAX_SERIES_POINTS,
  CSV_COLUMNS,
  toInt,
  clamp,
  percentDelta,
  isoDay,
  addDays,
  parseRange,
  parseBotsFilter,
  normalizeBucketName,
  rowsToCountMap,
  topEntries,
  buildDaySeries,
  loadAllTimeTotals,
  loadLinkStats,
  loadPreviousWindowTotals,
  loadRawClicks,
  toPublicPayload,
  escapeCsvCell,
  buildClicksCsv,
};
