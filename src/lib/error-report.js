/**
 * Optional outbound error reporting with no SDK dependency.
 *
 * When ERROR_WEBHOOK_URL is set, one JSON envelope per error *shape* is posted
 * (deduplicated for 60s). Delivery is fire-and-forget and time-boxed so a slow
 * or broken collector can never delay an HTTP response.
 */
'use strict';

const DEDUPE_MS = 60 * 1000;
const DEDUPE_MAX = 200;
const reportedAt = new Map();

function shouldSkip() {
  return process.env.NODE_ENV === 'test' || !(process.env.ERROR_WEBHOOK_URL || '').toString().trim();
}

function dedupeKey(err, ctx) {
  const name = (err && err.name) || 'Error';
  const message = (err && err.message) || String(err || '');
  const route = (ctx && (ctx.route || ctx.path)) || '';
  return `${name}|${message}|${route}`;
}

function reportError(err, ctx = {}) {
  try {
    if (shouldSkip()) return;
    const key = dedupeKey(err, ctx);
    const now = Date.now();
    const last = reportedAt.get(key) || 0;
    if (now - last < DEDUPE_MS) return;
    reportedAt.set(key, now);
    if (reportedAt.size > DEDUPE_MAX) {
      reportedAt.delete(reportedAt.keys().next().value);
    }

    const envelope = {
      timestamp: new Date().toISOString(),
      service: 'ovlink',
      level: 'error',
      error: {
        name: (err && err.name) || 'Error',
        message: (err && err.message) || String(err || ''),
        stack: (err && err.stack) ? String(err.stack).slice(0, 4000) : undefined,
      },
      context: {
        requestId: ctx.requestId,
        method: ctx.method,
        route: ctx.route || ctx.path,
        status: ctx.status,
      },
    };

    const url = (process.env.ERROR_WEBHOOK_URL || '').toString().trim();
    const timeout = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(3000)
      : undefined;

    Promise.resolve(fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      signal: timeout,
    })).catch(() => {});
  } catch (err) {
    // Reporting must never throw into the request path.
  }
}

module.exports = { reportError };
