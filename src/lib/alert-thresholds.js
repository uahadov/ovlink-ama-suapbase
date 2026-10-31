'use strict';

/**
 * Per-user and per-link anomaly thresholds.
 *
 * Precedence is fixed and documented once here: environment defaults < user
 * defaults < link override. A NULL column means "inherit the next level", so a
 * user who only cares about spikes does not have to restate every value.
 *
 * The bounds mirror src/lib/anomaly-alerts.js#buildSettings so a value saved
 * through the UI can never produce a configuration the worker would reject.
 */

const { dbGetAsync, dbRunAsync } = require('../db/helpers');

const ALERT_FIELDS = Object.freeze({
  spikeMultiplier: {
    column: 'alert_spike_multiplier',
    setting: 'spikeMultiplier',
    type: 'float',
    min: 1.5,
    max: 100,
    aliases: ['spike_multiplier'],
  },
  spikeMinClicks: {
    column: 'alert_spike_min_clicks',
    setting: 'spikeMinClicks',
    type: 'int',
    min: 1,
    max: 100000,
    aliases: ['spike_min_clicks'],
  },
  dropMultiplier: {
    column: 'alert_drop_multiplier',
    setting: 'dropMultiplier',
    type: 'float',
    min: 0.01,
    max: 0.99,
    aliases: ['drop_multiplier'],
  },
  dropMinBaseline: {
    column: 'alert_drop_min_baseline',
    setting: 'dropMinBaselineAvg',
    type: 'int',
    min: 1,
    max: 100000,
    aliases: ['drop_min_baseline'],
  },
  healthEnabled: {
    column: 'alert_health_enabled',
    setting: 'healthEnabled',
    type: 'bool',
    aliases: ['health_enabled'],
  },
});

const BOOL_TRUE = new Set(['1', 'true', 'yes', 'on']);
const BOOL_FALSE = new Set(['0', 'false', 'no', 'off']);

function readInputValue(input, definition) {
  if (!input || typeof input !== 'object') return undefined;
  const candidates = [definition.column, definition.setting, ...definition.aliases];
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(input, key)) return input[key];
  }
  return undefined;
}

function coerceValue(raw, definition) {
  if (raw === null || raw === undefined || raw === '') return null;

  if (definition.type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    const text = raw.toString().trim().toLowerCase();
    if (BOOL_TRUE.has(text)) return true;
    if (BOOL_FALSE.has(text)) return false;
    return null;
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  const clamped = Math.min(definition.max, Math.max(definition.min, numeric));
  return definition.type === 'int' ? Math.round(clamped) : Math.round(clamped * 100) / 100;
}

/**
 * Validates a PATCH body. Returns the sanitized values, which fields the caller
 * actually supplied (so PATCH stays partial) and human-readable warnings.
 */
function sanitizeThresholds(input) {
  const values = {};
  const provided = {};
  const errors = [];

  for (const [field, definition] of Object.entries(ALERT_FIELDS)) {
    const raw = readInputValue(input, definition);
    if (raw === undefined) continue;
    provided[field] = true;
    const value = coerceValue(raw, definition);
    if (value === null && raw !== null && raw !== '') {
      errors.push(`${field}: invalid value`);
      continue;
    }
    if (definition.type !== 'bool' && value !== null) {
      const numeric = Number(raw);
      if (Number.isFinite(numeric) && (numeric < definition.min || numeric > definition.max)) {
        errors.push(`${field}: clamped to ${definition.min}..${definition.max}`);
      }
    }
    values[field] = value;
  }

  return { values, provided, errors };
}

/** Reads one row's override for a field, or null when the row inherits. */
function readRowValue(row, definition) {
  if (!row || typeof row !== 'object') return null;
  const raw = row[definition.column];
  if (raw === null || raw === undefined) return null;
  if (definition.type === 'bool') {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) return null;
    return numeric === 1;
  }
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Applies link overrides on top of user overrides on top of the env-derived
 * settings object produced by anomaly-alerts#buildSettings.
 */
function mergeAlertSettings(envSettings, userRow, linkRow) {
  const merged = { ...(envSettings || {}) };
  for (const definition of Object.values(ALERT_FIELDS)) {
    const linkValue = readRowValue(linkRow, definition);
    const userValue = readRowValue(userRow, definition);
    const value = linkValue !== null ? linkValue : userValue;
    if (value !== null) merged[definition.setting] = value;
  }
  return merged;
}

/** Display-friendly view of the effective thresholds plus where they came from. */
function describeThresholds(envSettings, userRow, linkRow) {
  const effective = mergeAlertSettings(envSettings, userRow, linkRow);
  const out = {};
  for (const [field, definition] of Object.entries(ALERT_FIELDS)) {
    const linkValue = readRowValue(linkRow, definition);
    const userValue = readRowValue(userRow, definition);
    out[field] = {
      value: effective[definition.setting],
      source: linkValue !== null ? 'link' : (userValue !== null ? 'user' : 'default'),
    };
  }
  return out;
}

async function loadUserAlertOverrides(userId) {
  const id = Number.parseInt(userId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  return dbGetAsync(
    'SELECT alert_spike_multiplier, alert_spike_min_clicks, alert_drop_multiplier, ' +
      'alert_drop_min_baseline, alert_health_enabled FROM users WHERE id = ?',
    [id]
  ).catch(() => null);
}

async function loadLinkAlertOverrides(urlId) {
  const id = Number.parseInt(urlId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  return dbGetAsync('SELECT * FROM link_alert_settings WHERE url_id = ?', [id]).catch(() => null);
}

async function saveUserAlertOverrides(userId, values) {
  const id = Number.parseInt(userId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const cols = Object.values(ALERT_FIELDS).map((definition) => definition.column);
  const params = Object.values(ALERT_FIELDS).map((definition) => {
    const value = values ? values[definition.setting] : undefined;
    return value === undefined ? null : value;
  });
  await dbRunAsync(`UPDATE users SET ${cols.map((col) => `${col} = ?`).join(', ')} WHERE id = ?`, [...params, id]).catch(() => null);
  return loadUserAlertOverrides(id);
}

/** Upsert the per-link override row (all five columns at once). */
async function saveLinkAlertOverrides(urlId, values) {
  const id = Number.parseInt(urlId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const cols = Object.values(ALERT_FIELDS).map((definition) => definition.column);
  const params = Object.values(ALERT_FIELDS).map((definition) => {
    const value = values ? values[definition.setting] : undefined;
    return value === undefined ? null : value;
  });
  const updates = cols.map((col) => `${col} = EXCLUDED.${col}`).join(', ');
  await dbRunAsync(
    `INSERT INTO link_alert_settings (url_id, ${cols.join(', ')}, updated_at) ` +
      `VALUES (?, ${cols.map(() => '?').join(', ')}, ?) ` +
      `ON CONFLICT (url_id) DO UPDATE SET ${updates}, updated_at = EXCLUDED.updated_at`,
    [id, ...params, new Date().toISOString()]
  ).catch(() => null);
  return loadLinkAlertOverrides(id);
}

async function clearLinkAlertOverrides(urlId) {
  const id = Number.parseInt(urlId, 10);
  if (!Number.isInteger(id) || id <= 0) return false;
  const result = await dbRunAsync('DELETE FROM link_alert_settings WHERE url_id = ?', [id]).catch(() => null);
  return !!(result && Number(result.changes) > 0);
}

module.exports = {
  ALERT_FIELDS,
  sanitizeThresholds,
  mergeAlertSettings,
  describeThresholds,
  loadUserAlertOverrides,
  loadLinkAlertOverrides,
  saveUserAlertOverrides,
  saveLinkAlertOverrides,
  clearLinkAlertOverrides,
};
