'use strict';

/**
 * New vs returning visitors.
 *
 * A visitor is "new" the first day their hash appears for a link and
 * "returning" on every later day. The split is computed from `click_uniques`,
 * which already stores one row per (link, day, visitor hash) - no extra write on
 * the redirect path.
 *
 * `idx_click_uniques_url_ip (url_id, ip_hash, day)` makes the "seen before?"
 * probe an index lookup instead of a scan.
 */

const { dbGetAsync } = require('../db/helpers');
const { isoDay, addDays, clamp } = require('./link-stats');

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

function resolveStartDay({ days = DEFAULT_DAYS, now = new Date() } = {}) {
  const parsed = Number.parseInt(days, 10);
  const safeDays = Number.isInteger(parsed) && parsed > 0 ? clamp(parsed, 1, MAX_DAYS) : DEFAULT_DAYS;
  return { days: safeDays, startDay: isoDay(addDays(now, -(safeDays - 1))) };
}

/**
 * Returns unique visitors in the window split into first-time and returning.
 * `available:false` means the link has no visitor hashes at all (legacy rows or
 * `essential`-only consent), so the UI must show "—" instead of a fake zero.
 */
async function loadVisitorSplit({ urlId, startDay } = {}) {
  const id = Number.parseInt(urlId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return { available: false, visitors: 0, new_visitors: 0, returning_visitors: 0, start_day: startDay || null };
  }

  const day = (startDay || '1970-01-01').toString().slice(0, 10);
  const row = await dbGetAsync(
    'SELECT COUNT(*) AS visitors, ' +
      'COALESCE(SUM(CASE WHEN EXISTS (' +
      'SELECT 1 FROM click_uniques p ' +
      'WHERE p.url_id = cur.url_id AND p.ip_hash = cur.ip_hash AND p.day < ?' +
      ') THEN 1 ELSE 0 END), 0) AS returning_visitors ' +
      'FROM (SELECT DISTINCT url_id, ip_hash FROM click_uniques WHERE url_id = ? AND day >= ?) cur',
    [day, id, day]
  ).catch(() => null);

  const visitors = row ? Math.max(0, Number(row.visitors || 0)) : 0;
  const returning = Math.min(visitors, Math.max(0, Number(row.returning_visitors || 0)));

  return {
    available: visitors > 0,
    visitors,
    new_visitors: Math.max(0, visitors - returning),
    returning_visitors: returning,
    start_day: day,
  };
}

module.exports = {
  DEFAULT_DAYS,
  MAX_DAYS,
  resolveStartDay,
  loadVisitorSplit,
};
