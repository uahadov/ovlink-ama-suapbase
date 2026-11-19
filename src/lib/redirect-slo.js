'use strict';
/**
 * P12 Lightweight In-Memory Redirect SLO Telemetry.
 * Zero DB writes, zero external network calls, bounded ring buffer (500 samples).
 * Exposed only on privileged GET /api/health (X-Health-Token).
 */
const MAX_SAMPLES = 500;
const samples = new Array(MAX_SAMPLES);
let sampleCount = 0;
let sampleCursor = 0;

const counters = {
  total: 0,
  delivered: 0,
  consent_redirects: 0,
  gated: 0,
  not_found: 0,
  errors: 0,
  analytics_failures: 0,
};

function recordLatency(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return;
  samples[sampleCursor] = ms;
  sampleCursor = (sampleCursor + 1) % MAX_SAMPLES;
  if (sampleCount < MAX_SAMPLES) sampleCount += 1;
}

function recordOutcome(kind, durationMs) {
  counters.total += 1;
  if (Object.prototype.hasOwnProperty.call(counters, kind)) {
    counters[kind] += 1;
  }
  if (durationMs !== undefined) recordLatency(durationMs);
}

function recordAnalyticsFailure() {
  counters.analytics_failures += 1;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 10) / 10;
}

function snapshot() {
  const active = sampleCount === MAX_SAMPLES ? samples.slice() : samples.slice(0, sampleCount);
  active.sort((a, b) => a - b);
  return {
    ...counters,
    window_samples: active.length,
    p50_ms: percentile(active, 50),
    p95_ms: percentile(active, 95),
    p99_ms: percentile(active, 99),
  };
}

function reset() {
  sampleCount = 0;
  sampleCursor = 0;
  for (const k of Object.keys(counters)) counters[k] = 0;
}

module.exports = {
  recordOutcome,
  recordAnalyticsFailure,
  snapshot,
  reset,
};
