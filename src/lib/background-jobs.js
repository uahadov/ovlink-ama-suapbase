'use strict';

/**
 * P30 — Durable Background Job & Outbox Infrastructure v1 (background-jobs-v1).
 *
 * PostgreSQL-backed outbox/queue designed for low-RAM single-instance & multi-worker
 * deployments without extra broker overhead:
 *   - Idempotent `idempotency_key` enqueue (zero duplicate jobs)
 *   - Atomic `FOR UPDATE SKIP LOCKED` claiming across parallel workers
 *   - Crash recovery via `lease_until` expiration
 *   - Bounded exponential backoff + `dead_letter` terminal state (no infinite loops)
 *   - Execution timeout guard & Ops inspection/requeue API
 */

const crypto = require('crypto');
const { dbGetAsync, dbRunAsync, dbAllAsync, withTransaction } = require('../db/helpers');

const BACKGROUND_JOBS_CONTRACT_VERSION = 'background-jobs-v1';
const ALLOWED_JOB_TYPES = new Set([
  'report_export',
  'audit_export',
  'scheduled_report',
  'alert_dispatch',
]);
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 3600 * 1000;

let jobsTableReady = false;

function computeBackoffMs(attempt, baseMs = BASE_BACKOFF_MS, maxMs = MAX_BACKOFF_MS) {
  const n = Math.max(1, Number.parseInt(attempt, 10) || 1);
  return Math.min(maxMs, Math.round(baseMs * Math.pow(2, n - 1)));
}

async function ensureBackgroundJobsTable(runFn = dbRunAsync) {
  if (jobsTableReady) return;
  await runFn(`CREATE TABLE IF NOT EXISTS background_jobs (
    id SERIAL PRIMARY KEY,
    job_type TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    owner_user_id INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    next_run_at TEXT NOT NULL,
    lease_until TEXT,
    locked_by TEXT,
    timeout_ms INTEGER NOT NULL DEFAULT 30000,
    last_error TEXT,
    result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )`);
  await runFn('CREATE INDEX IF NOT EXISTS idx_background_jobs_claim ON background_jobs(status, next_run_at, lease_until)').catch(() => {});
  await runFn('CREATE INDEX IF NOT EXISTS idx_background_jobs_owner ON background_jobs(owner_user_id, id DESC)').catch(() => {});
  jobsTableReady = true;
}

function mapJobRow(row) {
  if (!row) return null;
  let payload = {};
  let result = null;
  try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = {}; }
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { result = null; }
  return {
    id: Number(row.id),
    job_type: row.job_type,
    idempotency_key: row.idempotency_key,
    owner_user_id: Number(row.owner_user_id),
    payload,
    status: row.status,
    attempts: Number(row.attempts || 0),
    max_attempts: Number(row.max_attempts || DEFAULT_MAX_ATTEMPTS),
    next_run_at: row.next_run_at,
    lease_until: row.lease_until || null,
    locked_by: row.locked_by || null,
    timeout_ms: Number(row.timeout_ms || DEFAULT_TIMEOUT_MS),
    last_error: row.last_error || null,
    result,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at || null,
  };
}

/** Idempotently enqueues a background job. Duplicate idempotency_key returns existing job. */
async function enqueueJob({
  jobType,
  idempotencyKey,
  ownerUserId,
  payload = {},
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  nextRunAt = null,
  dbGet = dbGetAsync,
  dbRun = dbRunAsync,
} = {}) {
  await ensureBackgroundJobsTable(dbRun);
  const safeType = String(jobType || '').trim().toLowerCase();
  if (!ALLOWED_JOB_TYPES.has(safeType)) {
    return { error: 'invalid_job_type', statusCode: 400, message: 'Dəstəklənməyən job növü.' };
  }
  const key = String(idempotencyKey || '').trim() || `job_${crypto.randomBytes(10).toString('hex')}`;
  if (key.length > 140) return { error: 'invalid_idempotency_key', statusCode: 400 };
  const nowIso = new Date().toISOString();
  const runAtIso = nextRunAt ? new Date(nextRunAt).toISOString() : nowIso;
  const safeMax = Math.max(1, Math.min(10, Number.parseInt(maxAttempts, 10) || DEFAULT_MAX_ATTEMPTS));
  const safeTimeout = Math.max(1000, Math.min(300000, Number.parseInt(timeoutMs, 10) || DEFAULT_TIMEOUT_MS));

  const existing = await dbGet('SELECT * FROM background_jobs WHERE idempotency_key = ? LIMIT 1', [key]);
  if (existing) {
    return { deduplicated: true, job: mapJobRow(existing) };
  }

  const inserted = await dbRun(
    `INSERT INTO background_jobs
       (job_type, idempotency_key, owner_user_id, payload_json, status, attempts, max_attempts,
        next_run_at, timeout_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [safeType, key, Number(ownerUserId), JSON.stringify(payload || {}), safeMax, runAtIso, safeTimeout, nowIso, nowIso]
  );

  if (!inserted || !inserted.changes) {
    const raced = await dbGet('SELECT * FROM background_jobs WHERE idempotency_key = ? LIMIT 1', [key]);
    return { deduplicated: true, job: mapJobRow(raced) };
  }

  return {
    deduplicated: false,
    job: mapJobRow({
      id: inserted.lastID,
      job_type: safeType,
      idempotency_key: key,
      owner_user_id: ownerUserId,
      payload_json: JSON.stringify(payload || {}),
      status: 'queued',
      attempts: 0,
      max_attempts: safeMax,
      next_run_at: runAtIso,
      timeout_ms: safeTimeout,
      created_at: nowIso,
      updated_at: nowIso,
    }),
  };
}

/**
 * Atomically claims the next eligible queued or lease-expired job using
 * PostgreSQL `FOR UPDATE SKIP LOCKED` so concurrent workers never duplicate work.
 */
async function claimNextJob({
  workerId = 'worker-' + crypto.randomBytes(4).toString('hex'),
  leaseMs = DEFAULT_LEASE_MS,
  jobTypes = null,
  ownerUserId = null,
  now = new Date(),
} = {}) {
  await ensureBackgroundJobsTable();
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const leaseUntilIso = new Date((now instanceof Date ? now : new Date(now)).getTime() + Math.max(1, Number(leaseMs) || DEFAULT_LEASE_MS)).toISOString();

  return withTransaction(async (tx) => {
    const params = [nowIso, nowIso];
    let extraWhere = '';
    if (Array.isArray(jobTypes) && jobTypes.length > 0) {
      extraWhere += ` AND job_type IN (${jobTypes.map(() => '?').join(', ')})`;
      params.push(...jobTypes);
    }
    if (ownerUserId) {
      extraWhere += ' AND owner_user_id = ?';
      params.push(Number(ownerUserId));
    }

    const row = await tx.get(
      `SELECT * FROM background_jobs
        WHERE ((status = 'queued' AND next_run_at <= ?)
            OR (status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?))
          ${extraWhere}
        ORDER BY id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      params
    );
    if (!row) return null;

    const nextAttempts = Number(row.attempts || 0) + 1;
    await tx.run(
      `UPDATE background_jobs
          SET status = 'running', attempts = ?, locked_by = ?, lease_until = ?, updated_at = ?
        WHERE id = ?`,
      [nextAttempts, workerId, leaseUntilIso, nowIso, Number(row.id)]
    );

    return mapJobRow({
      ...row,
      status: 'running',
      attempts: nextAttempts,
      locked_by: workerId,
      lease_until: leaseUntilIso,
      updated_at: nowIso,
    });
  });
}

async function completeJob({ jobId, result = {}, dbRun = dbRunAsync } = {}) {
  const nowIso = new Date().toISOString();
  await dbRun(
    `UPDATE background_jobs
        SET status = 'completed', result_json = ?, lease_until = NULL, locked_by = NULL,
            last_error = NULL, updated_at = ?, completed_at = ?
      WHERE id = ?`,
    [JSON.stringify(result || {}), nowIso, nowIso, Number(jobId)]
  );
  return { id: Number(jobId), status: 'completed', completed_at: nowIso };
}

/**
 * Records a job failure: retries with bounded exponential backoff until
 * `attempts >= max_attempts`, then transitions permanently to `dead_letter`.
 */
async function failJob({ job, errorMessage = 'job_failed', baseBackoffMs = BASE_BACKOFF_MS, dbRun = dbRunAsync } = {}) {
  const now = new Date();
  const nowIso = now.toISOString();
  const attempts = Number(job.attempts || 1);
  const maxAttempts = Number(job.max_attempts || DEFAULT_MAX_ATTEMPTS);
  const isDead = attempts >= maxAttempts;
  const nextStatus = isDead ? 'dead_letter' : 'queued';
  const backoffMs = isDead ? 0 : computeBackoffMs(attempts, baseBackoffMs);
  const nextRunIso = isDead ? job.next_run_at : new Date(now.getTime() + backoffMs).toISOString();

  await dbRun(
    `UPDATE background_jobs
        SET status = ?, last_error = ?, next_run_at = ?, lease_until = NULL, locked_by = NULL, updated_at = ?
      WHERE id = ?`,
    [nextStatus, String(errorMessage || 'job_failed').slice(0, 400), nextRunIso, nowIso, Number(job.id)]
  );
  return {
    id: Number(job.id),
    status: nextStatus,
    attempts,
    max_attempts: maxAttempts,
    backoff_ms: backoffMs,
    next_run_at: nextRunIso,
  };
}

/** Executes a claimed job handler under a strict timeout guard. */
async function runClaimedJob({ job, handler, baseBackoffMs = BASE_BACKOFF_MS } = {}) {
  const timeoutMs = Math.max(50, Number(job.timeout_ms || DEFAULT_TIMEOUT_MS));
  let timer = null;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => handler(job)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`job_timeout_${timeoutMs}ms`)), timeoutMs);
        if (timer.unref) timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    return await completeJob({ jobId: job.id, result });
  } catch (err) {
    if (timer) clearTimeout(timer);
    return await failJob({ job, errorMessage: (err && err.message) || 'handler_error', baseBackoffMs });
  }
}

async function listOpsJobs({ ownerUserId, status = null, limit = 50, dbAll = dbAllAsync, dbRun = dbRunAsync } = {}) {
  await ensureBackgroundJobsTable(dbRun);
  const safeLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 50));
  const rows = status
    ? await dbAll(
        'SELECT * FROM background_jobs WHERE owner_user_id = ? AND status = ? ORDER BY id DESC LIMIT ?',
        [Number(ownerUserId), String(status).toLowerCase(), safeLimit]
      )
    : await dbAll(
        'SELECT * FROM background_jobs WHERE owner_user_id = ? ORDER BY id DESC LIMIT ?',
        [Number(ownerUserId), safeLimit]
      );
  const jobs = (rows || []).map(mapJobRow);
  const counts = { queued: 0, running: 0, completed: 0, dead_letter: 0 };
  for (const j of jobs) {
    if (Object.prototype.hasOwnProperty.call(counts, j.status)) counts[j.status] += 1;
  }
  return { counts, jobs };
}

async function requeueDeadLetterJob({ ownerUserId, jobId, dbRun = dbRunAsync } = {}) {
  await ensureBackgroundJobsTable(dbRun);
  const nowIso = new Date().toISOString();
  const res = await dbRun(
    `UPDATE background_jobs
        SET status = 'queued', attempts = 0, next_run_at = ?, lease_until = NULL, locked_by = NULL, last_error = NULL, updated_at = ?
      WHERE id = ? AND owner_user_id = ? AND status = 'dead_letter'`,
    [nowIso, nowIso, Number(jobId), Number(ownerUserId)]
  );
  if (!res || !res.changes) return { error: 'not_found', statusCode: 404 };
  return { id: Number(jobId), status: 'queued', requeued_at: nowIso };
}

module.exports = {
  BACKGROUND_JOBS_CONTRACT_VERSION,
  ALLOWED_JOB_TYPES,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_LEASE_MS,
  computeBackoffMs,
  ensureBackgroundJobsTable,
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
  runClaimedJob,
  listOpsJobs,
  requeueDeadLetterJob,
};
