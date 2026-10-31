'use strict';

/**
 * Removes every analytics row that references a link before the link itself is
 * deleted.
 *
 * Why this exists: `clicks`, `click_uniques`, `link_stats_daily`,
 * `link_conversions`, `link_funnel_steps` and `stats_shares` all carry a
 * foreign key to `urls(id)` without ON DELETE CASCADE. A bare
 * `DELETE FROM urls` therefore fails with a foreign-key violation as soon as
 * the link has any analytics history - i.e. for every real link.
 *
 * The helper runs inside the caller's transaction (tx.run) so a failed delete
 * cannot leave a half-removed link behind.
 */

const ANALYTICS_TABLES = Object.freeze([
  'link_funnel_steps',
  'link_conversions',
  'link_stats_daily',
  'click_uniques',
  'clicks',
  'stats_shares',
  'link_alert_settings',
  // No foreign key, but it is per-link data: erasing the link must erase the
  // record of who read its statistics.
  'analytics_audit_log',
]);

// QR storage is not part of ANALYTICS_TABLES because its daily counters are
// keyed by qr_id; the ordering lives in buildPurgeSteps().
const QR_TABLES = Object.freeze(['qr_scan_daily', 'qr_codes']);

function normalizeUrlIds(urlIds) {
  const list = Array.isArray(urlIds) ? urlIds : [urlIds];
  return Array.from(new Set(
    list
      .map((id) => Number.parseInt(id, 10))
      .filter((id) => Number.isInteger(id) && id > 0)
  ));
}

/**
 * Ordered delete plan for one purge. QR rows are returned first because
 * `qr_scan_daily` is keyed by `qr_id`, not `url_id`: its counters must be
 * removed through a subselect on `qr_codes` before the parent rows go.
 */
function buildPurgeSteps(ids) {
  const placeholders = ids.map(() => '?').join(', ');
  const steps = [
    {
      table: 'qr_scan_daily',
      sql: `DELETE FROM qr_scan_daily WHERE qr_id IN (SELECT id FROM qr_codes WHERE url_id IN (${placeholders}))`,
    },
    {
      table: 'qr_codes',
      sql: `DELETE FROM qr_codes WHERE url_id IN (${placeholders})`,
    },
  ];

  // Table names are module constants, never user input.
  for (const table of ANALYTICS_TABLES) {
    steps.push({ table, sql: `DELETE FROM ${table} WHERE url_id IN (${placeholders})` });
  }
  return steps;
}

/**
 * Deletes the analytics rows for one or more links inside `tx`.
 * Returns the number of link ids processed.
 */
async function purgeLinkAnalyticsRows(tx, urlIds) {
  if (!tx || typeof tx.run !== 'function') return 0;
  const ids = normalizeUrlIds(urlIds);
  if (!ids.length) return 0;

  for (const step of buildPurgeSteps(ids)) {
    await tx.run(step.sql, ids);
  }
  return ids.length;
}

module.exports = {
  ANALYTICS_TABLES,
  QR_TABLES,
  normalizeUrlIds,
  buildPurgeSteps,
  purgeLinkAnalyticsRows,
};
