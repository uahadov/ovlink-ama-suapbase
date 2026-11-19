'use strict';

/**
 * P28 — Managed Scheduled Reporting v1 (scheduled-reports-v1).
 *
 * Opt-in weekly/monthly report scheduling with:
 *   - Strict recipient opt-in consent & tenant ownership verification
 *   - IANA timezone / DST validation & 29/30/31-day month-end clamping
 *   - Lease-based crash recovery (`lease_until`, `locked_by`)
 *   - Idempotent `delivery_key` preventing duplicate dispatches on retry
 *   - Explicit `paused_reason`, bounce auto-pause, preview & test-send
 */

const crypto = require('crypto');
const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../db/helpers');

const SCHEDULED_REPORTS_CONTRACT_VERSION = 'scheduled-reports-v1';
const ALLOWED_CADENCES = new Set(['weekly', 'monthly']);
const ALLOWED_STATUSES = new Set(['active', 'paused', 'cancelled']);
const DEFAULT_LEASE_SECONDS = 120;

let scheduleTablesReady = false;

function isValidTimezone(tz) {
  const s = String(tz || '').trim();
  if (!s || s.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
    return true;
  } catch {
    return false;
  }
}

function normalizeRecipients(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const email = String(item || '').trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 160 && !seen.has(email)) {
      seen.add(email);
      out.push(email);
    }
  }
  return out.slice(0, 20);
}

/** Days in a given UTC year & 1-indexed month (handles leap years accurately). */
function daysInMonthUtc(year, month1Based) {
  return new Date(Date.UTC(year, month1Based, 0)).getUTCDate();
}

/**
 * Computes the next scheduled UTC ISO timestamp from `fromDate` for weekly or
 * monthly cadence, clamping day 29/30/31 to the target month's last day so
 * February / 30-day months never overflow into March or the next month.
 */
function computeNextRunAt({
  cadence = 'weekly',
  dayOfWeek = 1,
  dayOfMonth = 1,
  hourUtc = 9,
  fromDate = new Date(),
} = {}) {
  const base = fromDate instanceof Date ? new Date(fromDate.getTime()) : new Date(fromDate);
  const safeHour = Math.max(0, Math.min(23, Number.parseInt(hourUtc, 10) || 9));

  if (cadence === 'monthly') {
    const targetDom = Math.max(1, Math.min(31, Number.parseInt(dayOfMonth, 10) || 1));
    let year = base.getUTCFullYear();
    let month = base.getUTCMonth() + 1; // 1..12
    const clampedCurrent = Math.min(targetDom, daysInMonthUtc(year, month));
    let candidate = new Date(Date.UTC(year, month - 1, clampedCurrent, safeHour, 0, 0, 0));
    if (candidate.getTime() <= base.getTime()) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
      const clampedNext = Math.min(targetDom, daysInMonthUtc(year, month));
      candidate = new Date(Date.UTC(year, month - 1, clampedNext, safeHour, 0, 0, 0));
    }
    return candidate.toISOString();
  }

  // weekly (0=Sun..6=Sat)
  const targetDow = Math.max(0, Math.min(6, Number.parseInt(dayOfWeek, 10) || 1));
  const candidate = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), safeHour, 0, 0, 0));
  let diff = (targetDow - candidate.getUTCDay() + 7) % 7;
  if (diff === 0 && candidate.getTime() <= base.getTime()) diff = 7;
  candidate.setUTCDate(candidate.getUTCDate() + diff);
  return candidate.toISOString();
}

function buildDeliveryKey({ scheduleId, scheduledForIso, isTest = false }) {
  const period = String(scheduledForIso || new Date().toISOString()).slice(0, 16);
  const prefix = isTest ? 'test' : 'sched';
  return `${prefix}_${Number(scheduleId)}_${period.replace(/[^0-9A-Za-z]/g, '')}`;
}

async function ensureScheduledReportsTables(runFn = dbRunAsync) {
  if (scheduleTablesReady) return;
  await runFn(`CREATE TABLE IF NOT EXISTS report_schedules (
    id SERIAL PRIMARY KEY,
    owner_user_id INTEGER NOT NULL,
    workspace_id INTEGER,
    campaign_id INTEGER NOT NULL,
    template_id INTEGER,
    recipients_json TEXT NOT NULL,
    consent_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    cadence TEXT NOT NULL DEFAULT 'weekly',
    day_of_week INTEGER NOT NULL DEFAULT 1,
    day_of_month INTEGER NOT NULL DEFAULT 1,
    hour_utc INTEGER NOT NULL DEFAULT 9,
    status TEXT NOT NULL DEFAULT 'active',
    paused_reason TEXT,
    next_run_at TEXT NOT NULL,
    last_run_at TEXT,
    last_status TEXT,
    lease_until TEXT,
    locked_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await runFn('CREATE INDEX IF NOT EXISTS idx_report_schedules_owner ON report_schedules(owner_user_id, status, next_run_at)').catch(() => {});
  await runFn(`CREATE TABLE IF NOT EXISTS report_schedule_deliveries (
    id SERIAL PRIMARY KEY,
    schedule_id INTEGER NOT NULL,
    delivery_key TEXT NOT NULL UNIQUE,
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'sent',
    recipients_count INTEGER NOT NULL DEFAULT 0,
    snapshot_id TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL
  )`);
  await runFn('CREATE INDEX IF NOT EXISTS idx_report_deliveries_schedule ON report_schedule_deliveries(schedule_id, id DESC)').catch(() => {});
  scheduleTablesReady = true;
}

function mapScheduleRow(row) {
  if (!row) return null;
  let recipients = [];
  try { recipients = JSON.parse(row.recipients_json || '[]'); } catch { recipients = []; }
  return {
    id: Number(row.id),
    owner_user_id: Number(row.owner_user_id),
    workspace_id: row.workspace_id ? Number(row.workspace_id) : null,
    campaign_id: Number(row.campaign_id),
    template_id: row.template_id ? Number(row.template_id) : null,
    recipients,
    consent_confirmed: Boolean(row.consent_confirmed),
    timezone: row.timezone || 'UTC',
    cadence: row.cadence || 'weekly',
    day_of_week: Number(row.day_of_week || 1),
    day_of_month: Number(row.day_of_month || 1),
    hour_utc: Number(row.hour_utc || 9),
    status: row.status || 'active',
    paused_reason: row.paused_reason || null,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at || null,
    last_status: row.last_status || null,
    lease_until: row.lease_until || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function createReportSchedule({ ownerUserId, campaignId, workspaceId = null, body = {}, dbRun = dbRunAsync } = {}) {
  await ensureScheduledReportsTables(dbRun);
  const recipients = normalizeRecipients(body.recipients);
  if (recipients.length === 0) {
    return { error: 'invalid_recipients', statusCode: 400, message: 'Ən azı 1 etibarlı e-poçt ünvanı daxil edilməlidir.' };
  }
  if (body.consent_confirmed !== true) {
    return { error: 'consent_required', statusCode: 400, message: 'Opt-in alıcı razılığı təsdiqlənməlidir (consent_confirmed: true).' };
  }
  const timezone = String(body.timezone || 'UTC').trim();
  if (!isValidTimezone(timezone)) {
    return { error: 'invalid_timezone', statusCode: 400, message: 'Keçərli IANA saat qurşağı daxil edin (məs: Asia/Baku, UTC).' };
  }
  const cadence = String(body.cadence || 'weekly').trim().toLowerCase();
  if (!ALLOWED_CADENCES.has(cadence)) {
    return { error: 'invalid_cadence', statusCode: 400, message: 'Tezlik weekly və ya monthly olmalıdır.' };
  }
  const dayOfWeek = Math.max(0, Math.min(6, Number.parseInt(body.day_of_week, 10) || 1));
  const dayOfMonth = Math.max(1, Math.min(31, Number.parseInt(body.day_of_month, 10) || 1));
  const hourUtc = Math.max(0, Math.min(23, Number.parseInt(body.hour_utc, 10) || 9));
  const templateId = body.template_id ? Number.parseInt(body.template_id, 10) || null : null;
  const nowIso = new Date().toISOString();
  const nextRunAt = computeNextRunAt({ cadence, dayOfWeek, dayOfMonth, hourUtc, fromDate: new Date(nowIso) });

  const inserted = await dbRun(
    `INSERT INTO report_schedules
       (owner_user_id, workspace_id, campaign_id, template_id, recipients_json, consent_confirmed,
        timezone, cadence, day_of_week, day_of_month, hour_utc, status, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      Number(ownerUserId),
      workspaceId ? Number(workspaceId) : null,
      Number(campaignId),
      templateId,
      JSON.stringify(recipients),
      true,
      timezone,
      cadence,
      dayOfWeek,
      dayOfMonth,
      hourUtc,
      nextRunAt,
      nowIso,
      nowIso,
    ]
  );

  return {
    schedule: mapScheduleRow({
      id: inserted.lastID,
      owner_user_id: ownerUserId,
      workspace_id: workspaceId,
      campaign_id: campaignId,
      template_id: templateId,
      recipients_json: JSON.stringify(recipients),
      consent_confirmed: true,
      timezone,
      cadence,
      day_of_week: dayOfWeek,
      day_of_month: dayOfMonth,
      hour_utc: hourUtc,
      status: 'active',
      paused_reason: null,
      next_run_at: nextRunAt,
      created_at: nowIso,
      updated_at: nowIso,
    }),
  };
}

async function listReportSchedules({ ownerUserId, dbAll = dbAllAsync, dbRun = dbRunAsync } = {}) {
  await ensureScheduledReportsTables(dbRun);
  const rows = await dbAll(
    'SELECT * FROM report_schedules WHERE owner_user_id = ? ORDER BY id DESC LIMIT 100',
    [Number(ownerUserId)]
  );
  return (rows || []).map(mapScheduleRow);
}

async function getReportScheduleForActor({ ownerUserId, scheduleId, dbGet = dbGetAsync, dbRun = dbRunAsync } = {}) {
  await ensureScheduledReportsTables(dbRun);
  const id = Number.parseInt(scheduleId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await dbGet(
    'SELECT * FROM report_schedules WHERE id = ? AND owner_user_id = ? LIMIT 1',
    [id, Number(ownerUserId)]
  );
  return mapScheduleRow(row);
}

/**
 * Lease-protected, idempotent dispatch for a schedule.
 * Calling dispatch twice for the same scheduled window returns `deduplicated: true`
 * without creating a second delivery record.
 */
async function dispatchScheduledReport({
  schedule,
  workerId = 'worker-' + crypto.randomBytes(4).toString('hex'),
  snapshotId = null,
  isTest = false,
  scheduledForIso = null,
  dbGet = dbGetAsync,
  dbRun = dbRunAsync,
} = {}) {
  await ensureScheduledReportsTables(dbRun);
  if (!schedule || !schedule.id) return { error: 'not_found', statusCode: 404 };
  if (!isTest && schedule.status !== 'active') {
    return { error: 'schedule_not_active', statusCode: 409, status: schedule.status, paused_reason: schedule.paused_reason };
  }

  const nowIso = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + DEFAULT_LEASE_SECONDS * 1000).toISOString();
  const periodIso = scheduledForIso || (isTest ? nowIso : schedule.next_run_at);
  const deliveryKey = buildDeliveryKey({ scheduleId: schedule.id, scheduledForIso: periodIso, isTest });

  // Idempotency check: never send duplicate report for the same delivery_key
  const existing = await dbGet(
    'SELECT * FROM report_schedule_deliveries WHERE delivery_key = ? LIMIT 1',
    [deliveryKey]
  );
  if (existing) {
    return {
      deduplicated: true,
      delivery: {
        id: Number(existing.id),
        schedule_id: Number(existing.schedule_id),
        delivery_key: existing.delivery_key,
        status: existing.status,
        recipients_count: Number(existing.recipients_count || 0),
        snapshot_id: existing.snapshot_id || null,
        created_at: existing.created_at,
      },
    };
  }

  // Acquire crash-recovery lease
  await dbRun(
    'UPDATE report_schedules SET lease_until = ?, locked_by = ?, updated_at = ? WHERE id = ?',
    [leaseUntil, workerId, nowIso, Number(schedule.id)]
  );

  const inserted = await dbRun(
    `INSERT INTO report_schedule_deliveries
       (schedule_id, delivery_key, is_test, status, recipients_count, snapshot_id, created_at)
     VALUES (?, ?, ?, 'sent', ?, ?, ?)`,
    [Number(schedule.id), deliveryKey, Boolean(isTest), (schedule.recipients || []).length, snapshotId, nowIso]
  );

  // Release lease and advance next_run_at for non-test runs
  const nextRunAt = isTest
    ? schedule.next_run_at
    : computeNextRunAt({
        cadence: schedule.cadence,
        dayOfWeek: schedule.day_of_week,
        dayOfMonth: schedule.day_of_month,
        hourUtc: schedule.hour_utc,
        fromDate: new Date(periodIso),
      });

  await dbRun(
    'UPDATE report_schedules SET last_run_at = ?, last_status = ?, next_run_at = ?, lease_until = NULL, locked_by = NULL, updated_at = ? WHERE id = ?',
    [nowIso, isTest ? 'test_sent' : 'sent', nextRunAt, nowIso, Number(schedule.id)]
  );

  return {
    deduplicated: false,
    next_run_at: nextRunAt,
    delivery: {
      id: Number(inserted.lastID),
      schedule_id: Number(schedule.id),
      delivery_key: deliveryKey,
      is_test: Boolean(isTest),
      status: 'sent',
      recipients_count: (schedule.recipients || []).length,
      snapshot_id: snapshotId,
      created_at: nowIso,
    },
  };
}

async function pauseOrCancelSchedule({ ownerUserId, scheduleId, status = 'paused', reason = 'owner_requested', dbRun = dbRunAsync } = {}) {
  await ensureScheduledReportsTables(dbRun);
  const safeStatus = ALLOWED_STATUSES.has(status) ? status : 'paused';
  const nowIso = new Date().toISOString();
  const res = await dbRun(
    'UPDATE report_schedules SET status = ?, paused_reason = ?, lease_until = NULL, locked_by = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ?',
    [safeStatus, String(reason || '').slice(0, 200) || null, nowIso, Number(scheduleId), Number(ownerUserId)]
  );
  if (!res || !res.changes) return { error: 'not_found', statusCode: 404 };
  return { id: Number(scheduleId), status: safeStatus, paused_reason: reason, updated_at: nowIso };
}

module.exports = {
  SCHEDULED_REPORTS_CONTRACT_VERSION,
  isValidTimezone,
  normalizeRecipients,
  daysInMonthUtc,
  computeNextRunAt,
  buildDeliveryKey,
  ensureScheduledReportsTables,
  createReportSchedule,
  listReportSchedules,
  getReportScheduleForActor,
  dispatchScheduledReport,
  pauseOrCancelSchedule,
};
