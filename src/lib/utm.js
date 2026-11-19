'use strict';

/**
 * UTM builder & agency convention engine (P17).
 *
 * `appendUtmParams` is idempotent - applying it twice yields the same URL - and
 * a no-op for anything it cannot parse, so a broken input never blocks link
 * creation.
 */

const UTM_KEYS = Object.freeze(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']);
const UTM_VALUE_MAX = 80;
const MAX_URL_LENGTH = 2048;

const FIELD_TO_KEY = Object.freeze({
  source: 'utm_source',
  medium: 'utm_medium',
  campaign: 'utm_campaign',
  term: 'utm_term',
  content: 'utm_content',
});

const LOCALE_CHAR_MAP = Object.freeze({
  '\u0259': 'e',
  '\u018f': 'E',
  '\u0131': 'i',
  '\u0130': 'I',
  '\u011f': 'g',
  '\u011e': 'G',
  '\u015f': 's',
  '\u015e': 'S',
  '\u00e7': 'c',
  '\u00c7': 'C',
  '\u00f6': 'o',
  '\u00d6': 'O',
  '\u00fc': 'u',
  '\u00dc': 'U',
});

const DEFAULT_CONVENTION = Object.freeze({
  separator: '-',
  case_mode: 'lower',
  transliterate_locale: false,
});

function normalizeConvention(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const separator = obj.separator === '_' ? '_' : '-';
  const case_mode = obj.case_mode === 'preserve' ? 'preserve' : 'lower';
  const transliterate_locale = Boolean(obj.transliterate_locale);
  return { separator, case_mode, transliterate_locale };
}

function transliterateLocaleText(text) {
  return String(text || '')
    .replace(/[\u0259\u018f\u0131\u0130\u011f\u011e\u015f\u015e\u00e7\u00c7\u00f6\u00d6\u00fc\u00dc]/g, (ch) => LOCALE_CHAR_MAP[ch] || ch)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Lowercase, strip control characters, collapse whitespace, cap the length. */
function normalizeUtmValue(raw, convention = DEFAULT_CONVENTION) {
  const conv = normalizeConvention(convention);
  let value = (raw === null || raw === undefined ? '' : raw)
    .toString()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!value) return '';
  if (conv.transliterate_locale) {
    value = transliterateLocaleText(value);
  }
  if (conv.case_mode !== 'preserve') {
    value = value.toLowerCase();
  }
  return value.replace(/\s+/g, conv.separator).slice(0, UTM_VALUE_MAX);
}

/**
 * Reads UTM values from a request body. Both shapes are accepted:
 *   { utm_source, utm_medium, ... }  (dashboard form)
 *   { utm: { source, medium, ... } } (API clients)
 */
function readUtmFields(source, convention = DEFAULT_CONVENTION) {
  const body = source && typeof source === 'object' ? source : {};
  const nested = body.utm && typeof body.utm === 'object' ? body.utm : {};
  const fields = {};
  for (const [field, key] of Object.entries(FIELD_TO_KEY)) {
    const raw = body[key] !== undefined ? body[key] : nested[field];
    fields[field] = normalizeUtmValue(raw, convention);
  }
  return fields;
}

/** True when at least one UTM value is worth writing. */
function hasUtmValues(fields, convention = DEFAULT_CONVENTION) {
  if (!fields || typeof fields !== 'object') return false;
  return Object.entries(FIELD_TO_KEY).some(([field, key]) => {
    const raw = fields[field] !== undefined ? fields[field] : fields[key];
    return !!normalizeUtmValue(raw, convention);
  });
}

/**
 * Appends (or replaces) utm_* parameters on an absolute http(s) URL.
 * Removes case-variant duplicate utm_* keys (e.g. UTM_SOURCE) before setting
 * canonical lowercase keys so repeated applications never duplicate params.
 */
function appendUtmParams(rawUrl, fields, convention = DEFAULT_CONVENTION) {
  const original = rawUrl === null || rawUrl === undefined ? '' : rawUrl.toString();
  const url = original.trim();
  if (!url) return rawUrl;
  if (!hasUtmValues(fields, convention)) return rawUrl;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return rawUrl;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return rawUrl;

  for (const [field, key] of Object.entries(FIELD_TO_KEY)) {
    const raw = fields[field] !== undefined ? fields[field] : fields[key];
    const value = normalizeUtmValue(raw, convention);
    if (!value) continue;

    // Remove any case-variant duplicate keys (e.g. UTM_SOURCE) before setting canonical key.
    const toDelete = [];
    for (const existingKey of parsed.searchParams.keys()) {
      if (existingKey.toLowerCase() === key && existingKey !== key) {
        toDelete.push(existingKey);
      }
    }
    for (const dupKey of toDelete) {
      parsed.searchParams.delete(dupKey);
    }

    parsed.searchParams.set(key, value);
  }

  const next = parsed.toString();
  if (next.length > MAX_URL_LENGTH) return rawUrl;
  return next;
}

function applyUtmPreset(rawUrl, preset = {}, overrides = {}) {
  const conv = normalizeConvention(preset.convention || preset.convention_json);
  const merged = {};
  for (const [field, key] of Object.entries(FIELD_TO_KEY)) {
    const overrideVal = overrides[key] !== undefined ? overrides[key] : overrides[field];
    const presetVal = preset[key] !== undefined ? preset[key] : preset[field];
    merged[key] = overrideVal !== undefined && overrideVal !== '' ? overrideVal : presetVal;
  }
  return appendUtmParams(rawUrl, merged, conv);
}

function csvEscapeCell(val) {
  const s = String(val == null ? '' : val);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

function buildChannelUtmPreview({ baseUrl, preset = {}, channels = [], campaignSlug = '' } = {}) {
  const conv = normalizeConvention(preset.convention || preset.convention_json);
  const channelList = Array.isArray(channels) && channels.length
    ? channels
    : [preset.utm_source || preset.source || 'instagram'];

  const rows = channelList.slice(0, 20).map((ch) => {
    const channelSource = normalizeUtmValue(ch, conv) || 'direct';
    const taggedUrl = applyUtmPreset(baseUrl, preset, {
      utm_source: channelSource,
      utm_campaign: campaignSlug || preset.utm_campaign || preset.campaign || '',
    });
    return {
      channel: channelSource,
      utm_source: channelSource,
      utm_medium: normalizeUtmValue(preset.utm_medium || preset.medium || 'social', conv),
      utm_campaign: normalizeUtmValue(campaignSlug || preset.utm_campaign || preset.campaign || '', conv),
      utm_term: normalizeUtmValue(preset.utm_term || preset.term || '', conv),
      utm_content: normalizeUtmValue(preset.utm_content || preset.content || '', conv),
      tagged_url: taggedUrl,
    };
  });

  const csvLines = [
    'channel,utm_source,utm_medium,utm_campaign,utm_term,utm_content,tagged_url',
    ...rows.map((r) => [
      r.channel,
      r.utm_source,
      r.utm_medium,
      r.utm_campaign,
      r.utm_term,
      r.utm_content,
      r.tagged_url,
    ].map(csvEscapeCell).join(',')),
  ];

  return {
    convention: conv,
    rows,
    csv: csvLines.join('\n'),
  };
}

module.exports = {
  UTM_KEYS,
  UTM_VALUE_MAX,
  MAX_URL_LENGTH,
  FIELD_TO_KEY,
  DEFAULT_CONVENTION,
  normalizeConvention,
  transliterateLocaleText,
  normalizeUtmValue,
  readUtmFields,
  hasUtmValues,
  appendUtmParams,
  applyUtmPreset,
  buildChannelUtmPreview,
};
