/**
 * Liveness and readiness probes.
 *
 * Mounted in src/app.js *before* the rate limiters and the session middleware:
 * a probe must never create a session row, hit Redis or consume a rate-limit
 * budget. That ordering is the whole point of this file.
 *
 *   GET /health      liveness  — process only, never touches the database
 *   GET /api/health  readiness — DB round trip, Redis connection flag, worker beats
 *
 * Deep details (connection pool counters) are returned only when the caller
 * presents X-Health-Token matching HEALTH_TOKEN.
 */
'use strict';

const crypto = require('crypto');
const express = require('express');
const pkg = require('../../package.json');
const { dbGetAsync } = require('../db/helpers');
const { snapshot: workerSnapshot } = require('../lib/worker-heartbeat');
const { redisClient } = require('../config/redis');

const router = express.Router();

const DB_TIMEOUT_MS = 1500;
const NO_STORE = 'no-store, no-cache, must-revalidate';

function uptimeSeconds() {
  return Math.round(process.uptime());
}

function safeCompare(a, b) {
  try {
    const left = crypto.createHash('sha256').update(String(a)).digest();
    const right = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(left, right);
  } catch (err) {
    return false;
  }
}

function callerIsPrivileged(req) {
  const expected = (process.env.HEALTH_TOKEN || '').toString().trim();
  if (!expected) return false;
  const provided = (req.get('x-health-token') || '').toString().trim();
  if (!provided) return false;
  return safeCompare(provided, expected);
}

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function checkDatabase() {
  const startedAt = process.hrtime.bigint();
  try {
    const result = await withTimeout(dbGetAsync('SELECT 1 AS ok'), DB_TIMEOUT_MS);
    if (result && result.timedOut) return { ok: false, error: 'timeout' };
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return { ok: true, latencyMs: Math.round(latencyMs * 10) / 10 };
  } catch (err) {
    return { ok: false, error: 'unreachable' };
  }
}

function checkRedis() {
  // Connection state only: sending a command would add load on every probe.
  const configured = !!redisClient;
  return {
    configured,
    connected: configured && redisClient.isOpen === true,
  };
}

router.get(['/health', '/api/health'], async (req, res) => {
  res.setHeader('Cache-Control', NO_STORE);

  // Liveness: answer even when the database is down, otherwise orchestrators
  // restart a healthy process during a database incident.
  if (req.path === '/health') {
    return res.status(200).json({
      status: 'ok',
      uptime_s: uptimeSeconds(),
      version: pkg.version,
    });
  }

  const [db, redis] = await Promise.all([checkDatabase(), Promise.resolve(checkRedis())]);
  const workers = workerSnapshot();
  const status = db.ok ? 'ok' : 'unavailable';
  const body = {
    status,
    uptime_s: uptimeSeconds(),
    version: pkg.version,
    checks: {
      db,
      redis,
      workers,
    },
  };

  if (callerIsPrivileged(req)) {
    try {
      const { pool } = require('../db/pool');
      body.checks.pool = {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      };
    } catch (err) {
      body.checks.pool = { error: 'unavailable' };
    }
  }

  return res.status(db.ok ? 200 : 503).json(body);
});

module.exports = router;
