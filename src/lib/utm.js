'use strict';

/**
 * UTM builder.
 *
 * The dashboard form has always appended utm_source/medium/campaign in the
 * browser. This module is the server-side authority: the same normalisation for
 * the session API, the Pro API and any future client.
 *
 * `appendUtmParams` is idempotent - applying it twice yields the same URL - and
 * a no-op for anything it cannot parse, so a broken input never blocks link
 * creation.
 */

const UTM_KEYS = Object.freeze(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']);

// Same ceiling as analytics.js#UTM_LENGTH, so what we write is what we store.
const UTM_VALUE_MAX = 80;
const MAX_URL_LENGTH = 2048;

const FIELD_TO_KEY = Object.freeze({
  source: 'utm_source',
  medium: 'utm_medium',
  campaign: 'utm_campaign',
  term: 'utm_term',
  content: 'utm_content',
});

/** Lowercase, strip control characters, collapse whitespace, cap the length. */
function normalizeUtmValue(raw) {
  const value = (raw === null || raw === undefined ? '' : raw)
    .toString()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .toLowerCase();
  if (!value) return '';
  return value.replace(/\s+/g, '-').slice(0, UTM_VALUE_MAX);
}

/**
 * Reads UTM values from a request body. Both shapes are accepted:
 *   { utm_source, utm_medium, ... }  (dashboard form)
 *   { utm: { source, medium, ... } } (API clients)
 */
function readUtmFields(source) {
  const body = source && typeof source === 'object' ? source : {};
  const nested = body.utm && typeof body.utm === 'object' ? body.utm : {};
  const fields = {};
  for (const [field, key] of Object.entries(FIELD_TO_KEY)) {
    const raw = body[key] !== undefined ? body[key] : nested[field];
    fields[field] = normalizeUtmValue(raw);
  }
  return fields;
}

/** True when at least one UTM value is worth writing. */
function hasUtmValues(fields) {
  if (!fields || typeof fields !== 'object') return false;
  return Object.keys(FIELD_TO_KEY).some((field) => !!normalizeUtmValue(fields[field]));
}

/**
 * Appends (or replaces) utm_* parameters on an absolute http(s) URL.
 * Returns the original value untouched for empty input, unparseable URLs and
 * URLs that would grow past MAX_URL_LENGTH.
 */
function appendUtmParams(rawUrl, fields) {
  const original = rawUrl === null || rawUrl === undefined ? '' : rawUrl.toString();
  const url = original.trim();
  if (!url) return rawUrl;
  if (!hasUtmValues(fields)) return rawUrl;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return rawUrl;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return rawUrl;

  for (const [field, key] of Object.entries(FIELD_TO_KEY)) {
    const value = normalizeUtmValue(fields[field]);
    if (!value) continue;
    // set() (not append) keeps re-submitting the same form from stacking
    // duplicated utm_* parameters.
    parsed.searchParams.set(key, value);
  }

  const next = parsed.toString();
  if (next.length > MAX_URL_LENGTH) return rawUrl;
  return next;
}

module.exports = {
  UTM_KEYS,
  UTM_VALUE_MAX,
  MAX_URL_LENGTH,
  FIELD_TO_KEY,
  normalizeUtmValue,
  readUtmFields,
  hasUtmValues,
  appendUtmParams,
};
