'use strict';

/**
 * P47 — Performance Budget, Backpressure Degrade Mode & Query Pagination Guard (perf-guard-v1).
 *
 * Ensures Ovlink stays fast on low-cost single-VPS hardware:
 *   - Bounded pagination (clamps limit & offset without changing analytical totals)
 *   - Explicit memory/queue backpressure degrade mode (throttles heavy exports with
 *     HTTP 503 + Retry-After while keeping short-link redirects 100% uninterrupted)
 *   - Honest single-VPS SLA disclosure (never claims 99.99% without multi-AZ failover)
 */

const os = require('node:os');

const PERF_GUARD_CONTRACT_VERSION = 'perf-guard-v1';
const DEFAULT_RSS_SOFT_LIMIT_MB = 450;
const DEFAULT_QUEUE_LAG_SOFT_LIMIT = 200;

const SINGLE_VPS_SLA_NOTE = 'A single small VPS targets best-effort 99.5%–99.9% availability; 99.99% uptime requires multi-AZ redundancy and automated failover.';

function clampPagination({ limit = 50, offset = 0, maxLimit = 200, maxOffset = 50000 } = {}) {
  const safeLimit = Math.min(maxLimit, Math.max(1, Number.parseInt(limit, 10) || 50));
  const safeOffset = Math.min(maxOffset, Math.max(0, Number.parseInt(offset, 10) || 0));
  return { limit: safeLimit, offset: safeOffset };
}

function evaluateResourceHealth({
  rssBytes = process.memoryUsage().rss,
  heapUsedBytes = process.memoryUsage().heapUsed,
  pendingJobs = 0,
  rssSoftLimitMb = Number(process.env.PERF_RSS_SOFT_LIMIT_MB) || DEFAULT_RSS_SOFT_LIMIT_MB,
  queueSoftLimit = Number(process.env.PERF_QUEUE_SOFT_LIMIT) || DEFAULT_QUEUE_LAG_SOFT_LIMIT,
} = {}) {
  const rssMb = Math.round((rssBytes / (1024 * 1024)) * 10) / 10;
  const heapMb = Math.round((heapUsedBytes / (1024 * 1024)) * 10) / 10;
  const queueDepth = Math.max(0, Number(pendingJobs) || 0);

  const memoryPressure = rssMb >= rssSoftLimitMb;
  const queuePressure = queueDepth >= queueSoftLimit;
  const degraded = memoryPressure || queuePressure;

  return {
    contract_version: PERF_GUARD_CONTRACT_VERSION,
    mode: degraded ? 'degraded_backpressure' : 'normal',
    redirects_unaffected: true,
    heavy_exports_throttled: degraded,
    retry_after_seconds: degraded ? 30 : 0,
    memory: {
      rss_mb: rssMb,
      heap_used_mb: heapMb,
      soft_limit_mb: rssSoftLimitMb,
      pressure: memoryPressure,
    },
    queue: {
      pending_jobs: queueDepth,
      soft_limit: queueSoftLimit,
      pressure: queuePressure,
    },
    host: {
      cpus: os.cpus().length,
      total_mem_mb: Math.round(os.totalmem() / (1024 * 1024)),
      free_mem_mb: Math.round(os.freemem() / (1024 * 1024)),
    },
    sla_honesty_note: SINGLE_VPS_SLA_NOTE,
  };
}

module.exports = {
  PERF_GUARD_CONTRACT_VERSION,
  DEFAULT_RSS_SOFT_LIMIT_MB,
  DEFAULT_QUEUE_LAG_SOFT_LIMIT,
  SINGLE_VPS_SLA_NOTE,
  clampPagination,
  evaluateResourceHealth,
};
