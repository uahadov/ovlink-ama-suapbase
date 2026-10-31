/**
 * Zero-dependency structured logger.
 *
 * Design goals:
 * - never throw: a logging failure must not mask the original error;
 * - redact secrets by key name before serialising;
 * - one line per event so `docker logs` / PM2 logs stay greppable;
 * - no console monkey-patching (a global side effect that is hard to revert).
 *
 * Env:
 *   LOG_LEVEL=debug|info|warn|error   (default: info, silent in tests)
 *   LOG_FORMAT=text|json              (default: text outside production)
 */
'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACT_KEY_RE = /(pass(word|wd)?|token|secret|authorization|cookie|api[_-]?key|session|dsn)/i;
const MAX_DEPTH = 3;
const MAX_STRING = 800;

let customSink = null;

function setSink(fn) {
  customSink = typeof fn === 'function' ? fn : null;
}

function resolveLevel() {
  const raw = (process.env.LOG_LEVEL || '').toString().trim().toLowerCase();
  if (LEVELS[raw]) return raw;
  return process.env.NODE_ENV === 'test' ? 'error' : 'info';
}

function redact(value, depth = 0, seen = new Set()) {
  try {
    if (value == null) return value;
    if (typeof value === 'string') {
      return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    }
    if (typeof value !== 'object') return value;
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        code: value.code,
        status: value.status,
      };
    }
    if (depth >= MAX_DEPTH) return '[depth-limit]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 25).map((item) => redact(item, depth + 1, seen));
    }
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = REDACT_KEY_RE.test(key) ? '[redacted]' : redact(val, depth + 1, seen);
    }
    return out;
  } catch (err) {
    return '[unserialisable]';
  }
}

function formatText(entry) {
  const parts = [`[${entry.level}]`, entry.scope ? `${entry.scope}:` : '', entry.msg];
  for (const [key, value] of Object.entries(entry)) {
    if (['ts', 'level', 'scope', 'msg'].includes(key)) continue;
    const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
    parts.push(`${key}=${rendered}`);
  }
  return parts.filter(Boolean).join(' ');
}

function emit(level, scope, msg, fields) {
  try {
    if (LEVELS[level] < LEVELS[resolveLevel()]) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      scope: scope || undefined,
      msg: msg == null ? '' : String(msg),
    };
    if (fields && typeof fields === 'object') {
      const clean = redact(fields);
      for (const [key, value] of Object.entries(clean)) {
        if (['ts', 'level', 'scope', 'msg'].includes(key)) continue;
        entry[key] = value;
      }
    }
    if (customSink) {
      customSink(entry);
      return;
    }
    const asJson = (process.env.LOG_FORMAT || '').toLowerCase() === 'json';
    const line = asJson ? JSON.stringify(entry) : formatText(entry);
    process.stdout.write(`${line}\n`);
  } catch (err) {
    // Never let logging break the caller.
  }
}

function createLogger(scope) {
  return {
    debug: (msg, fields) => emit('debug', scope, msg, fields),
    info: (msg, fields) => emit('info', scope, msg, fields),
    warn: (msg, fields) => emit('warn', scope, msg, fields),
    error: (msg, fields) => emit('error', scope, msg, fields),
  };
}

module.exports = {
  createLogger,
  setSink,
  redact,
  LEVELS,
};
