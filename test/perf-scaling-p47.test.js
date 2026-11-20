'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const perfGuard = require('../src/lib/perf-guard');

test('P47 unit: pagination guard bounds inputs and backpressure degrade mode preserves redirect continuity', () => {
  const p1 = perfGuard.clampPagination({ limit: 99999, offset: -5 });
  assert.equal(p1.limit, 200);
  assert.equal(p1.offset, 0);

  const normal = perfGuard.evaluateResourceHealth({
    rssBytes: 120 * 1024 * 1024,
    heapUsedBytes: 60 * 1024 * 1024,
    pendingJobs: 5,
    rssSoftLimitMb: 450,
    queueSoftLimit: 200,
  });
  assert.equal(normal.mode, 'normal');
  assert.equal(normal.redirects_unaffected, true);
  assert.equal(normal.heavy_exports_throttled, false);
  assert.match(normal.sla_honesty_note, /99\.99%/);

  const pressured = perfGuard.evaluateResourceHealth({
    rssBytes: 510 * 1024 * 1024,
    heapUsedBytes: 380 * 1024 * 1024,
    pendingJobs: 250,
    rssSoftLimitMb: 450,
    queueSoftLimit: 200,
  });
  assert.equal(pressured.mode, 'degraded_backpressure');
  assert.equal(pressured.redirects_unaffected, true);
  assert.equal(pressured.heavy_exports_throttled, true);
  assert.equal(pressured.retry_after_seconds, 30);
});
