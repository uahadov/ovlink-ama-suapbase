'use strict';

/**
 * Saved statistics segments (named filter presets).
 *
 * A segment stores only the dashboard's own view state - range, bot filter and
 * the client-side buckets - so applying one never adds a new SQL path. The
 * server-side range/bots values trigger a refetch; device/source/country/variant
 * narrow the already loaded slice (the UI labels it as a view preset).
 */

const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../db/helpers');

const SEGMENT_FILTER_KEYS = Object.freeze(['days', 'bots', 'device', 'source', 'country', 'variant']);
const SEGMENT_NAME_MIN = 2;
const SEGMENT_NAME_MAX = 40;
const SEGMENT_VALUE_MAX = 60;
const MAX_SEGMENTS_PER_USER = 50;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

function normalizeSegmentName(raw) {
  const value = (raw === null || raw === undefined ? '' : raw)
    .toString()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (value.length < SEGMENT_NAME_MIN) return '';
  return value.slice(0, SEGMENT_NAME_MAX);
}

function normalizeLabel(raw) {
  return (raw === null || raw === undefined ? '' : raw)
    .toString()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, SEGMENT_VALUE_MAX);
}

/** Whitelists and clamps the filter object; unknown keys are dropped. */
function normalizeFilters(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const out = {};

  const rawDays = (input.days === undefined || input.days === null || input.days === '') ? '' : input.days.toString().trim().toLowerCase();
  if (rawDays === 'all' || rawDays === '0') {
    out.days = 'all';
  } else {
    const parsed = Number.parseInt(rawDays, 10);
    out.days = Number.isInteger(parsed) && parsed > 0 ? Math.min(MAX_DAYS, parsed) : DEFAULT_DAYS;
  }

  const bots = (input.bots || '').toString().trim().toLowerCase();
  out.bots = bots === 'exclude' ? 'exclude' : 'include';

  out.device = normalizeLabel(input.device);
  out.source = normalizeLabel(input.source);
  out.country = normalizeLabel(input.country).toUpperCase();
  out.variant = normalizeLabel(input.variant).toLowerCase();

  return out;
}

function parseFiltersJson(rawJson) {
  if (!rawJson) return normalizeFilters({});
  try {
    return normalizeFilters(JSON.parse(rawJson));
  } catch {
    return normalizeFilters({});
  }
}

function mapSegmentRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name || '',
    filters: parseFiltersJson(row.filters_json),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function listSegments(userId) {
  const id = Number.parseInt(userId, 10);
  if (!Number.isInteger(id) || id <= 0) return [];
  const rows = await dbAllAsync(
    'SELECT id, name, filters_json, created_at, updated_at FROM saved_segments WHERE user_id = ? ORDER BY created_at ASC LIMIT ?',
    [id, MAX_SEGMENTS_PER_USER]
  ).catch(() => []);
  return (rows || []).map(mapSegmentRow);
}

async function getSegmentForUser({ userId, segmentId }) {
  const ownerId = Number.parseInt(userId, 10);
  const id = Number.parseInt(segmentId, 10);
  if (!Number.isInteger(ownerId) || ownerId <= 0 || !Number.isInteger(id) || id <= 0) return null;
  const row = await dbGetAsync(
    'SELECT id, name, filters_json, created_at, updated_at FROM saved_segments WHERE id = ? AND user_id = ? LIMIT 1',
    [id, ownerId]
  ).catch(() => null);
  return mapSegmentRow(row);
}

async function countSegments(userId) {
  const id = Number.parseInt(userId, 10);
  if (!Number.isInteger(id) || id <= 0) return 0;
  const row = await dbGetAsync('SELECT COUNT(*) AS count FROM saved_segments WHERE user_id = ?', [id]).catch(() => null);
  return row ? Number(row.count || 0) : 0;
}

async function createSegment({ userId, name, filters }) {
  const ownerId = Number.parseInt(userId, 10);
  if (!Number.isInteger(ownerId) || ownerId <= 0) return { error: 'unauthorized' };

  const cleanName = normalizeSegmentName(name);
  if (!cleanName) return { error: 'invalid_name' };

  if (await countSegments(ownerId) >= MAX_SEGMENTS_PER_USER) return { error: 'limit_reached' };

  const existing = await dbGetAsync(
    'SELECT id FROM saved_segments WHERE user_id = ? AND name = ? LIMIT 1',
    [ownerId, cleanName]
  ).catch(() => null);
  if (existing) return { error: 'duplicate' };

  const now = new Date().toISOString();
  const inserted = await dbRunAsync(
    'INSERT INTO saved_segments (user_id, name, filters_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [ownerId, cleanName, JSON.stringify(normalizeFilters(filters)), now, now]
  ).catch(() => null);

  if (!inserted || !inserted.lastID) return { error: 'db_error' };
  const segment = await getSegmentForUser({ userId: ownerId, segmentId: inserted.lastID });
  return { segment: segment || { id: Number(inserted.lastID), name: cleanName, filters: normalizeFilters(filters) } };
}

async function updateSegment({ userId, segmentId, name, filters }) {
  const current = await getSegmentForUser({ userId, segmentId });
  if (!current) return { error: 'not_found' };

  let nextName = current.name;
  if (name !== undefined) {
    nextName = normalizeSegmentName(name);
    if (!nextName) return { error: 'invalid_name' };
    if (nextName !== current.name) {
      const clash = await dbGetAsync(
        'SELECT id FROM saved_segments WHERE user_id = ? AND name = ? AND id <> ? LIMIT 1',
        [Number.parseInt(userId, 10), nextName, current.id]
      ).catch(() => null);
      if (clash) return { error: 'duplicate' };
    }
  }

  const nextFilters = filters === undefined ? current.filters : normalizeFilters(filters);
  await dbRunAsync(
    'UPDATE saved_segments SET name = ?, filters_json = ?, updated_at = ? WHERE id = ? AND user_id = ?',
    [nextName, JSON.stringify(nextFilters), new Date().toISOString(), current.id, Number.parseInt(userId, 10)]
  ).catch(() => null);

  return { segment: await getSegmentForUser({ userId, segmentId: current.id }) };
}

async function deleteSegment({ userId, segmentId }) {
  const ownerId = Number.parseInt(userId, 10);
  const id = Number.parseInt(segmentId, 10);
  if (!Number.isInteger(ownerId) || ownerId <= 0 || !Number.isInteger(id) || id <= 0) return { deleted: false };
  const result = await dbRunAsync('DELETE FROM saved_segments WHERE id = ? AND user_id = ?', [id, ownerId]).catch(() => null);
  return { deleted: !!(result && Number(result.changes) > 0) };
}

module.exports = {
  SEGMENT_FILTER_KEYS,
  SEGMENT_NAME_MIN,
  SEGMENT_NAME_MAX,
  MAX_SEGMENTS_PER_USER,
  normalizeSegmentName,
  normalizeFilters,
  mapSegmentRow,
  listSegments,
  getSegmentForUser,
  countSegments,
  createSegment,
  updateSegment,
  deleteSegment,
};
