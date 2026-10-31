'use strict';

const { beat } = require('./worker-heartbeat');

/**
 * Multi-step funnel.
 *
 * The destination page emits the conversion pixel once per step:
 *   <img src="https://ovlink.sbs/c/abc123.gif?goal=signup&step=1" />
 *   <img src="https://ovlink.sbs/c/abc123.gif?goal=signup&step=2" />
 *
 * Steps live in their own table so the existing goal dedupe key
 * (url_id, goal, day, ip_hash) keeps working unchanged - one visitor may hit
 * several steps on the same day.
 *
 * Every write spells out ON CONFLICT: the SQL converter only rewrites
 * `INSERT OR IGNORE` for three legacy tables, so relying on it here would
 * produce duplicate-key errors.
 */

const { dbRunAsync, dbAllAsync } = require('../db/helpers');

const MAX_FUNNEL_STEP = 20;
// Funnel rows grow with (visitors x steps x days); keep the window bounded the
// same way the other per-day tables are.
const FUNNEL_RETENTION_DAYS = 180;
const FUNNEL_PURGE_BATCH = 2000;
const FUNNEL_PURGE_MAX_ROUNDS = 5;

/** Integer 1..MAX_FUNNEL_STEP, or null when the value is not a valid step. */
function normalizeStep(raw) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value)) return null;
  if (value < 1 || value > MAX_FUNNEL_STEP) return null;
  return value;
}

function toCounts(rawCounts) {
  const map = new Map();
  if (rawCounts instanceof Map) {
    rawCounts.forEach((count, step) => map.set(Number(step), Number(count || 0)));
  } else if (rawCounts && typeof rawCounts === 'object') {
    Object.entries(rawCounts).forEach(([step, count]) => map.set(Number(step), Number(count || 0)));
  }
  return map;
}

/**
 * Turns per-step visitor counts into the funnel payload.
 * `baseVisitors` is the number of unique visitors in the window (step-1 traffic
 * can be lower when the pixel only fires on later pages).
 */
function buildFunnelSeries({ baseVisitors, counts } = {}) {
  const base = Math.max(0, Number(baseVisitors) || 0);
  const map = toCounts(counts);
  const steps = Array.from(map.keys())
    .filter((step) => Number.isInteger(step) && step >= 1)
    .sort((a, b) => a - b);

  let previous = null;
  return steps.map((step) => {
    const visitors = Math.max(0, Number(map.get(step) || 0));
    const percentOfBase = base > 0 ? Math.round((visitors / base) * 1000) / 10 : 0;
    const dropFromPrevious = previous === null ? null : Math.max(0, previous - visitors);
    const row = { step, visitors, percent_of_base: percentOfBase, drop_from_previous: dropFromPrevious };
    previous = visitors;
    return row;
  });
}

/**
 * Writes one funnel step. `ipHash` must already be the consent-aware dedupe key
 * computed by the caller (analytics.js) - this module never touches the request
 * or the raw IP.
 */
async function recordFunnelStep({ urlId, step, ipHash, now = new Date() } = {}) {
  const id = Number.parseInt(urlId, 10);
  const safeStep = normalizeStep(step);
  const hash = (ipHash || '').toString().slice(0, 128);
  if (!Number.isInteger(id) || id <= 0 || !safeStep || !hash) {
    return { recorded: false, reason: 'invalid_input', step: safeStep };
  }

  const when = now instanceof Date ? now : new Date(now);
  const createdAt = when.toISOString();
  const day = createdAt.slice(0, 10);

  const inserted = await dbRunAsync(
    'INSERT INTO link_funnel_steps (url_id, step, day, ip_hash, created_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT (url_id, step, day, ip_hash) DO NOTHING',
    [id, safeStep, day, hash, createdAt]
  ).catch(() => null);

  return { recorded: !!(inserted && Number(inserted.changes) > 0), step: safeStep };
}

/** Per-step visitor counts inside a day window (bounded). */
async function loadFunnelCounts({ urlId, startDay } = {}) {
  const id = Number.parseInt(urlId, 10);
  if (!Number.isInteger(id) || id <= 0) return [];
  const rows = await dbAllAsync(
    'SELECT step, COUNT(*) AS visitors FROM link_funnel_steps ' +
      'WHERE url_id = ? AND day >= ? GROUP BY step ORDER BY step ASC LIMIT ?',
    [id, startDay || '1970-01-01', MAX_FUNNEL_STEP]
  ).catch(() => []);
  return (rows || []).map((row) => ({
    step: Number(row.step || 0),
    visitors: Number(row.visitors || 0),
  }));
}

/**
 * Deletes funnel rows older than the retention window in bounded batches so a
 * large table never turns into one long lock.
 */
async function purgeOldFunnelSteps({ now = new Date(), retentionDays = FUNNEL_RETENTION_DAYS } = {}) {
  const parsed = Number.parseInt(retentionDays, 10);
  const safeDays = Number.isInteger(parsed) && parsed > 0 ? parsed : FUNNEL_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let deleted = 0;
  for (let round = 0; round < FUNNEL_PURGE_MAX_ROUNDS; round += 1) {
    const result = await dbRunAsync(
      'DELETE FROM link_funnel_steps WHERE id IN (' +
        'SELECT id FROM link_funnel_steps WHERE day < ? LIMIT ?)',
      [cutoff, FUNNEL_PURGE_BATCH]
    ).catch(() => null);
    const changes = result && result.changes ? Number(result.changes) : 0;
    deleted += changes;
    if (!changes) break;
  }
  return { deleted, cutoff };
}

let retentionTimer = null;

function scheduleFunnelRetention({ intervalMs = 24 * 60 * 60 * 1000, startDelayMs = 20 * 60 * 1000 } = {}) {
  if (retentionTimer) return retentionTimer;
  const run = () => {
    beat('funnel-retention');
    void purgeOldFunnelSteps().catch(() => {});
  };
  retentionTimer = setTimeout(() => {
    run();
    const interval = setInterval(run, intervalMs);
    if (typeof interval.unref === 'function') interval.unref();
  }, startDelayMs);
  if (typeof retentionTimer.unref === 'function') retentionTimer.unref();
  return retentionTimer;
}

module.exports = {
  MAX_FUNNEL_STEP,
  FUNNEL_RETENTION_DAYS,
  normalizeStep,
  buildFunnelSeries,
  recordFunnelStep,
  loadFunnelCounts,
  purgeOldFunnelSteps,
  scheduleFunnelRetention,
};
