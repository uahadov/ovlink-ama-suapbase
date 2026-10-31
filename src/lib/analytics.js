'use strict';

/**
 * Click attribution + daily rollups.
 *
 * The redirect path must stay fast: this module only builds a flat record from
 * the request and writes it with a handful of small statements. Every rollup
 * write is best-effort — analytics must never block or break a redirect.
 */

const { dbRunAsync, dbGetAsync } = require('../db/helpers');
const crypto = require('crypto');
const { hashIpForStorage, getRequestIp, getRequestGeoMeta } = require('./geo');
const { REDIRECT_CONSENT_MARKER, REDIRECT_CONSENT_MODES, normalizeConsentMode } = require('./consent');
const { getRequestHostName } = require('./url-helpers');
const { normalizeStep, recordFunnelStep } = require('./funnel');

const MAX_LABEL_LENGTH = 120;
const UTM_LENGTH = 80;

// Link-preview bots and automation are flagged instead of being dropped so the
// dashboard can show a "human vs bot" split (and let owners filter them out).
const BOT_UA_PATTERN = new RegExp(
  [
    'bot\\b',
    'crawler',
    'spider',
    'crawl',
    'slurp',
    'facebookexternalhit',
    'embedly',
    'pinterest',
    'slackbot',
    'telegrambot',
    'discordbot',
    'whatsapp',
    'skypeuripreview',
    'vkshare',
    'w3c_validator',
    'headlesschrome',
    'phantomjs',
    'lighthouse',
    'pingdom',
    'uptimerobot',
    'gtmetrix',
    'curl/',
    'wget/',
    'python-requests',
    'python-urllib',
    'go-http-client',
    'java/',
    'okhttp',
    'axios/',
    'node-fetch',
    'postmanruntime',
  ].join('|'),
  'i'
);

function cleanLabel(raw, maxLength = MAX_LABEL_LENGTH) {
  const value = (raw === null || raw === undefined ? '' : raw)
    .toString()
    // Strip control characters so nothing can be used to forge log/dashboard rows.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!value) return '';
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function parseUserAgentInfo(userAgentRaw) {
  const ua = (userAgentRaw || '').toString().slice(0, 512);

  let browser = 'Unknown';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/opr\//i.test(ua)) browser = 'Opera';
  else if (/chrome\//i.test(ua) && !/edg\//i.test(ua)) browser = 'Chrome';
  else if (/safari\//i.test(ua) && !/chrome\//i.test(ua)) browser = 'Safari';
  else if (/firefox\//i.test(ua)) browser = 'Firefox';
  else if (/msie|trident/i.test(ua)) browser = 'Internet Explorer';

  let os = 'Unknown';
  if (/windows nt/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/mac os x/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  return { browser, os };
}

function detectDeviceType(userAgentRaw) {
  const ua = (userAgentRaw || '').toString().slice(0, 512);
  if (!ua) return 'unknown';
  if (/ipad|tablet|kindle|silk|playbook|nexus 7|nexus 9|sm-t/i.test(ua)) return 'tablet';
  if (/android/i.test(ua) && !/mobile/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|windows phone|iemobile|blackberry|opera mini|opera mobi/i.test(ua)) return 'mobile';
  return 'desktop';
}

function isBotUserAgent(userAgentRaw) {
  const ua = (userAgentRaw || '').toString().slice(0, 512).trim();
  // A real browser always sends a User-Agent; an empty one means automation.
  if (!ua) return true;
  return BOT_UA_PATTERN.test(ua);
}

function normalizeHostForCompare(rawHost) {
  return (rawHost || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.+$/, '');
}

/**
 * Returns the external referrer host, or '' when the click has no referrer or
 * came from one of our own hosts (which is "direct" traffic, not a source).
 */
function getReferrerHost(rawReferrer, internalHosts = []) {
  const value = (rawReferrer || '').toString().trim();
  if (!value) return '';
  let host = '';
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
  if (!host) return '';
  const normalized = normalizeHostForCompare(host);

  const blocked = new Set(['localhost', '127.0.0.1', '::1']);
  for (const internal of internalHosts) {
    const candidate = normalizeHostForCompare(internal);
    if (candidate) blocked.add(candidate);
  }
  for (const candidate of blocked) {
    if (!candidate) continue;
    if (normalized === candidate || normalized.endsWith('.' + candidate)) return '';
  }

  return cleanLabel(host);
}

function pickFirstQueryValue(rawValue) {
  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  return cleanLabel(value, UTM_LENGTH).toLowerCase();
}

/** Reads utm_source / utm_medium / utm_campaign from the short-link URL. */
function getUtmParams(query) {
  const source = query && typeof query === 'object' ? query : {};
  return {
    source: pickFirstQueryValue(source.utm_source),
    medium: pickFirstQueryValue(source.utm_medium),
    campaign: pickFirstQueryValue(source.utm_campaign),
  };
}

/**
 * Builds the flat click record written to `clicks`.
 *
 * In essential-consent mode the request is still counted, but no attribution or
 * network identifier is persisted — only the consent marker columns that the
 * dashboard already understands.
 */
function buildClickRecord({ req, consentMode }) {
  const clickTime = new Date().toISOString();
  const mode = (consentMode || '').toString().trim().toLowerCase();
  const analyticsAllowed = mode === 'analytics';

  if (!analyticsAllowed) {
    return {
      analyticsAllowed: false,
      clickTime,
      browser: REDIRECT_CONSENT_MARKER,
      os: REDIRECT_CONSENT_MARKER,
      country: REDIRECT_CONSENT_MARKER,
      city: null,
      region: null,
      ipHash: null,
      referrerHost: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      deviceType: null,
      isBot: 0,
    };
  }

  const userAgent = ((req && req.headers && req.headers['user-agent']) || '').toString().slice(0, 512);
  const agent = parseUserAgentInfo(userAgent);
  const geo = getRequestGeoMeta(req) || {};
  const internalHosts = [];
  try {
    internalHosts.push(getRequestHostName(req));
  } catch {
    // ignore host resolution failures
  }
  const referrerHost = getReferrerHost(req && req.headers ? req.headers.referer : '', internalHosts);
  const utm = getUtmParams(req && req.query);

  let ipHash = '';
  try {
    ipHash = hashIpForStorage(getRequestIp(req));
  } catch {
    ipHash = '';
  }

  return {
    analyticsAllowed: true,
    clickTime,
    browser: cleanLabel(agent.browser, 64) || 'Unknown',
    os: cleanLabel(agent.os, 64) || 'Unknown',
    country: cleanLabel(geo.country, 64) || 'Unknown',
    city: cleanLabel(geo.city, 96) || null,
    region: null,
    ipHash: cleanLabel(ipHash, 64) || null,
    referrerHost: referrerHost || null,
    utmSource: utm.source || null,
    utmMedium: utm.medium || null,
    utmCampaign: utm.campaign || null,
    deviceType: detectDeviceType(userAgent),
    isBot: isBotUserAgent(userAgent) ? 1 : 0,
  };
}

function buildRollupStatement(record, urlId, uniqueIncrement = 0) {
  const day = record.clickTime.slice(0, 10);
  return {
    sql:
      'INSERT INTO link_stats_daily (url_id, day, clicks, uniques, bots, first_click_at, last_click_at) ' +
      'VALUES (?, ?, 1, ?, ?, ?, ?) ' +
      'ON CONFLICT (url_id, day) DO UPDATE SET ' +
      'clicks = link_stats_daily.clicks + 1, ' +
      'uniques = link_stats_daily.uniques + EXCLUDED.uniques, ' +
      'bots = link_stats_daily.bots + EXCLUDED.bots, ' +
      'last_click_at = EXCLUDED.last_click_at',
    params: [urlId, day, uniqueIncrement, record.isBot ? 1 : 0, record.clickTime, record.clickTime],
  };
}

/**
 * Persists one click and updates the daily rollup.
 * @returns {Promise<void>}
 */
async function recordClick({ row, req, consentMode, context } = {}) {
  if (!row || !row.id) return;
  const record = buildClickRecord({ req, consentMode });
  const variantRaw = context && context.variant ? context.variant.toString().toLowerCase() : '';
  const variant = variantRaw === 'a' || variantRaw === 'b' ? variantRaw : null;

  await dbRunAsync(
    'INSERT INTO clicks (url_id, click_time, ip, browser, os, country, city, region, ip_hash, ' +
      'referrer_host, utm_source, utm_medium, utm_campaign, device_type, is_bot, variant) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      row.id,
      record.clickTime,
      null, // raw IP is never stored — only ip_hash
      record.browser,
      record.os,
      record.country,
      record.city,
      record.region,
      record.ipHash,
      record.referrerHost,
      record.utmSource,
      record.utmMedium,
      record.utmCampaign,
      record.deviceType,
      record.isBot,
      variant,
    ]
  );

  // Unique visitors: one row per (link, day, visitor hash).
  let uniqueIncrement = 0;
  if (record.analyticsAllowed && record.ipHash) {
    const inserted = await dbRunAsync(
      'INSERT INTO click_uniques (url_id, day, ip_hash, created_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (url_id, day, ip_hash) DO NOTHING',
      [row.id, record.clickTime.slice(0, 10), record.ipHash, record.clickTime]
    ).catch(() => null);
    uniqueIncrement = inserted && inserted.changes ? 1 : 0;
  }

  const rollup = buildRollupStatement(record, row.id, uniqueIncrement);
  await dbRunAsync(rollup.sql, rollup.params);
}

/** Fire-and-forget wrapper used by the redirect path. */
function recordClickSafe(options) {
  return recordClick(options).catch((err) => {
    console.error('[analytics] click record failed:', err && (err.message || err));
  });
}

// ---------------------------------------------------------------------------
// Conversion goals
// The destination page pings /c/<short>.gif?goal=<name>. A conversion is
// deduplicated per (link, goal, day, visitor hash) so refreshes cannot inflate
// the numbers, and no raw IP is ever stored.
// ---------------------------------------------------------------------------
const GOAL_PATTERN = /^[a-z0-9_-]{1,40}$/;

function normalizeGoal(rawGoal) {
  const value = (rawGoal || '').toString().trim().toLowerCase();
  return GOAL_PATTERN.test(value) ? value : 'default';
}

/**
 * Resolves the A/B branch the converting visitor arrived on. Returns null when
 * the visitor cannot be matched to a click (blocked consent, no A/B test, or a
 * pixel fired from a different browser context) - the caller then reports the
 * A/B test on clicks only instead of inventing a conversion split.
 */
async function resolveConversionVariant({ urlId, ipHash, day }) {
  const hash = (ipHash || '').toString();
  if (!hash || hash.startsWith('anon:')) return null;
  // Range comparison keeps idx_clicks_url_ip (url_id, ip_hash, click_time)
  // usable; SUBSTR(click_time, 1, 10) would force a wider scan.
  const dayStart = `${day}T00:00:00.000Z`;
  const dayEnd = new Date(new Date(dayStart).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const row = await dbGetAsync(
    "SELECT variant FROM clicks WHERE url_id = ? AND ip_hash = ? AND click_time >= ? AND click_time < ? " +
      "AND variant IN ('a', 'b') ORDER BY id DESC LIMIT 1",
    [urlId, hash, dayStart, dayEnd]
  ).catch(() => null);
  const value = row && row.variant ? row.variant.toString().toLowerCase() : '';
  return value === 'a' || value === 'b' ? value : null;
}

async function recordConversion({ urlId, goal, step, req, now = new Date(), consentMode } = {}) {
  const id = Number.parseInt(urlId, 10);
  if (!Number.isInteger(id) || id <= 0) return { recorded: false, deduped: false };

  const safeGoal = normalizeGoal(goal);
  const safeStep = normalizeStep(step);

  // Automation never converts: the pixel is only embedded on the destination
  // page, so a bot hit would otherwise inflate every goal.
  const userAgent = ((req && req.headers && req.headers['user-agent']) || '').toString().slice(0, 512);
  if (isBotUserAgent(userAgent)) return { recorded: false, deduped: false, goal: safeGoal, reason: 'bot' };

  const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const day = createdAt.slice(0, 10);

  let dedupeKey = '';
  if (normalizeConsentMode(consentMode) === REDIRECT_CONSENT_MODES.ESSENTIAL) {
    // The visitor explicitly limited storage to essentials: still count the
    // conversion, but never derive an identifier from their address.
    dedupeKey = `anon:${crypto.randomBytes(8).toString('hex')}`;
  } else {
    let ipHash = '';
    try {
      ipHash = hashIpForStorage(getRequestIp(req));
    } catch {
      ipHash = '';
    }
    // Without a hash we still count the event, but cannot deduplicate it.
    dedupeKey = ipHash || `anon:${crypto.randomBytes(8).toString('hex')}`;
  }

  // Best-effort: which A/B branch produced this conversion (NULL when unknown).
  const variant = await resolveConversionVariant({ urlId: id, ipHash: dedupeKey, day });

  // Funnel steps are written before the goal row so a repeat visitor still
  // advances to the next step even when the goal itself is deduplicated.
  // Anonymous consent keys are skipped: every page load would look unique.
  let stepRecorded = false;
  if (safeStep && !dedupeKey.startsWith('anon:')) {
    const stepResult = await recordFunnelStep({ urlId: id, step: safeStep, ipHash: dedupeKey, now }).catch(() => null);
    stepRecorded = !!(stepResult && stepResult.recorded);
  }

  const inserted = await dbRunAsync(
    'INSERT INTO link_conversions (url_id, goal, day, ip_hash, created_at, variant) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (url_id, goal, day, ip_hash) DO NOTHING',
    [id, safeGoal, day, dedupeKey, createdAt, variant]
  ).catch(() => null);

  if (!inserted || !inserted.changes) {
    return { recorded: false, deduped: true, goal: safeGoal, variant, step: safeStep, step_recorded: stepRecorded };
  }

  await dbRunAsync(
    'INSERT INTO link_stats_daily (url_id, day, clicks, conversions, first_click_at, last_click_at) VALUES (?, ?, 0, 1, ?, ?) ' +
      'ON CONFLICT (url_id, day) DO UPDATE SET conversions = link_stats_daily.conversions + EXCLUDED.conversions',
    [id, day, createdAt, createdAt]
  ).catch(() => {});

  return { recorded: true, deduped: false, goal: safeGoal, variant, step: safeStep, step_recorded: stepRecorded };
}

module.exports = {
  MAX_LABEL_LENGTH,
  UTM_LENGTH,
  cleanLabel,
  parseUserAgentInfo,
  detectDeviceType,
  isBotUserAgent,
  getReferrerHost,
  getUtmParams,
  buildClickRecord,
  buildRollupStatement,
  recordClick,
  recordClickSafe,
  GOAL_PATTERN,
  normalizeGoal,
  resolveConversionVariant,
  recordConversion,
};
