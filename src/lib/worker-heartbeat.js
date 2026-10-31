/**
 * In-memory heartbeat registry for background workers.
 *
 * A beat costs one Map write: no timers, no queries, no disk. `/api/health`
 * reads the snapshot so operators can see whether schedulers are alive without
 * adding load to Postgres.
 */
'use strict';

const beats = new Map();
const MAX_ENTRIES = 50;

function beat(name, meta) {
  try {
    const key = (name || 'unknown').toString().slice(0, 64);
    if (!beats.has(key) && beats.size >= MAX_ENTRIES) {
      beats.delete(beats.keys().next().value);
    }
    const previous = beats.get(key);
    beats.set(key, {
      lastBeatAt: Date.now(),
      runs: previous ? previous.runs + 1 : 1,
      meta: meta && typeof meta === 'object' ? meta : undefined,
    });
  } catch (err) {
    // Heartbeats are best-effort.
  }
}

function snapshot(now = Date.now()) {
  const out = {};
  for (const [name, entry] of beats.entries()) {
    out[name] = {
      lastBeatAt: new Date(entry.lastBeatAt).toISOString(),
      ageMs: Math.max(0, now - entry.lastBeatAt),
      runs: entry.runs,
    };
  }
  return out;
}

function reset() {
  beats.clear();
}

module.exports = { beat, snapshot, reset };
