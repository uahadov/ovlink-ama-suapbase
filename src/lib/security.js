const crypto = require('crypto');
const API_KEY_SCOPES = Object.freeze({
  ACCOUNT_READ: 'account:read',
  SHORTEN_WRITE: 'shorten:write',
  WEBHOOKS_READ: 'webhooks:read',
  WEBHOOKS_WRITE: 'webhooks:write',
});
const DEFAULT_API_KEY_SCOPES = Object.freeze([
  API_KEY_SCOPES.ACCOUNT_READ,
  API_KEY_SCOPES.SHORTEN_WRITE,
  API_KEY_SCOPES.WEBHOOKS_READ,
  API_KEY_SCOPES.WEBHOOKS_WRITE,
]);
const DEFAULT_API_KEY_SCOPES_STORAGE = DEFAULT_API_KEY_SCOPES.join(',');
const ALLOWED_API_KEY_SCOPES = new Set(DEFAULT_API_KEY_SCOPES);

const { API_KEY_HASH_KEY_MATERIAL, WEBHOOK_HASH_KEY_MATERIAL } = require('../config/index');
const { getSafeHostHeader, normalizeHostName } = require('./url-helpers');

const PRO_API_KEY_MAX_ACTIVE = 2;

function buildApiKeyValue() {
  return `ovk_${crypto.randomBytes(32).toString('base64url')}`;
}

function getApiKeyPrefix(rawKey) {
  const value = (rawKey || '').toString();
  return value.slice(0, 12);
}

function getApiKeyLast4(rawKey) {
  const value = (rawKey || '').toString();
  return value.slice(-4);
}

function normalizeApiKeyScopes(rawScopes, fallbackScopes = DEFAULT_API_KEY_SCOPES) {
  const fallback = Array.isArray(fallbackScopes) && fallbackScopes.length
    ? fallbackScopes
    : DEFAULT_API_KEY_SCOPES;

  const candidates = [];
  if (Array.isArray(rawScopes)) {
    for (const item of rawScopes) candidates.push((item || '').toString().trim().toLowerCase());
  } else if (typeof rawScopes === 'string') {
    const split = rawScopes.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    candidates.push(...split);
  }

  const picked = new Set();
  for (const scope of candidates) {
    if (ALLOWED_API_KEY_SCOPES.has(scope)) picked.add(scope);
  }

  if (!picked.size) {
    for (const scope of fallback) {
      const normalized = (scope || '').toString().trim().toLowerCase();
      if (ALLOWED_API_KEY_SCOPES.has(normalized)) picked.add(normalized);
    }
  }

  const ordered = [];
  for (const scope of DEFAULT_API_KEY_SCOPES) {
    if (picked.has(scope)) ordered.push(scope);
  }
  return ordered.length ? ordered : [...DEFAULT_API_KEY_SCOPES];
}

function toApiKeyScopesStorage(rawScopes, fallbackScopes = DEFAULT_API_KEY_SCOPES) {
  return normalizeApiKeyScopes(rawScopes, fallbackScopes).join(',');
}

function hasApiScope(grantedScopes, requiredScope) {
  const required = (requiredScope || '').toString().trim().toLowerCase();
  if (!required) return true;
  const granted = new Set(normalizeApiKeyScopes(grantedScopes, DEFAULT_API_KEY_SCOPES));
  if (granted.has(required)) return true;
  if (required === API_KEY_SCOPES.WEBHOOKS_READ && granted.has(API_KEY_SCOPES.WEBHOOKS_WRITE)) return true;
  return false;
}

function hashApiKeyValueLegacy(rawKey) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update((rawKey || '').toString()).digest('hex');
}

function hashApiKeyValueV2(rawKey) {
  return crypto.createHmac('sha256', API_KEY_HASH_KEY_MATERIAL).update((rawKey || '').toString()).digest('hex');
}

function hashApiKeyValue(rawKey) {
  return hashApiKeyValueV2(rawKey);
}

function hashWebhookSecretValueV2(rawSecret) {
  return crypto.createHmac('sha256', WEBHOOK_HASH_KEY_MATERIAL).update((rawSecret || '').toString()).digest('hex');
}

function buildWebhookSignatureV2Key(rawSecret) {
  const secret = (rawSecret || '').toString().trim();
  if (!secret) return '';
  return crypto
    .createHash('sha256')
    .update(`ovlink:webhook-signature:v2|${secret}`)
    .digest('base64url');
}

function hasApiKeyAuthHeader(req) {
  const xApiKey = (req.get('x-api-key') || '').toString().trim();
  if (xApiKey) return true;
  const auth = (req.get('authorization') || '').toString().trim();
  return /^Bearer\s+\S+/i.test(auth);
}

function getConfiguredPublicBaseUrl() {
  const raw = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || '').toString().trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function parseHostFromUrl(raw) {
  const value = (raw || '').toString().trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return normalizeHostName(parsed.host || parsed.hostname);
  } catch {
    return '';
  }
}

function getConfiguredBaseHost() {
  return parseHostFromUrl(process.env.PUBLIC_BASE_URL) || parseHostFromUrl(process.env.BASE_URL);
}

const INTERNAL_HOSTS = new Set();

function refreshInternalHostCache() {
  INTERNAL_HOSTS.clear();
  const configured = getConfiguredBaseHost();
  if (configured) {
    INTERNAL_HOSTS.add(configured);
    if (configured.startsWith('www.')) {
      INTERNAL_HOSTS.add(configured.slice(4));
    } else {
      INTERNAL_HOSTS.add('www.' + configured);
    }
  }

  const extraHosts = (process.env.ADDITIONAL_BASE_HOSTS || '').toString().split(',').map((v) => normalizeHostName(v)).filter(Boolean);
  for (const host of extraHosts) INTERNAL_HOSTS.add(host);

  INTERNAL_HOSTS.add('localhost');
  INTERNAL_HOSTS.add('127.0.0.1');
  INTERNAL_HOSTS.add('::1');
}

refreshInternalHostCache();

function isInternalHost(rawHost) {
  const host = normalizeHostName(rawHost);
  return !!host && INTERNAL_HOSTS.has(host);
}

function getPublicBaseUrl(req) {
  const configured = getConfiguredPublicBaseUrl();
  if (configured) return configured;

  const proto = req.secure ? 'https' : 'http';
  const hostHeader = getSafeHostHeader(req);
  const host = normalizeHostName(hostHeader);

  // Avoid host-header poisoning: only accept first-party/internal hosts.
  if (hostHeader && host && isInternalHost(host)) {
    return `${proto}://${hostHeader.toLowerCase()}`.replace(/\/+$/, '');
  }

  const fallbackHost = getConfiguredBaseHost() || 'localhost';
  return `${proto}://${fallbackHost}`.replace(/\/+$/, '');
}

function buildAbsoluteUrl(req, pathValue) {
  const base = getPublicBaseUrl(req) + '/';
  const safePath = (pathValue || '/').toString();
  try {
    return new URL(safePath.startsWith('/') ? safePath : `/${safePath}`, base).toString();
  } catch {
    return base;
  }
}

const { getRequestIp, buildNetworkFingerprintForDisplay, maskIpForDisplay } = require('./geo');
const { db } = require('../db/index');

function safeJsonStringify(value, maxLen = 5000) {
  try {
    const json = JSON.stringify(value);
    if (json.length > maxLen) {
      return JSON.stringify({ error: 'Payload too large', truncated: true });
    }
    return json;
  } catch {
    return '{}';
  }
}

function logSecurityEvent(req, eventType, outcome, details = {}) {
  if (!db) return;
  const now = new Date().toISOString();
  const ipRaw = getRequestIp(req);
  const ipHash = buildNetworkFingerprintForDisplay(ipRaw);
  const ipMasked = maskIpForDisplay(ipRaw);
  const userAgent = ((req && req.get && req.get('user-agent')) || '').toString().slice(0, 512);
  const userId = Number.isInteger(details.user_id) ? details.user_id : (req && req.session && req.session.userId ? req.session.userId : null);
  const apiKeyId = Number.isInteger(details.api_key_id) ? details.api_key_id : null;
  const sanitizedDetails = { ...details };
  delete sanitizedDetails.user_id;
  delete sanitizedDetails.api_key_id;
  const detailsJson = safeJsonStringify(sanitizedDetails, 4000);

  const insertSql = 'INSERT INTO security_events (created_at, event_type, outcome, user_id, api_key_id, ip_hash, ip_masked, user_agent, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
  const eventTypeStr = (eventType || '').toString().slice(0, 128);
  const outcomeStr = (outcome || '').toString().slice(0, 32);
  db.run(
    insertSql,
    [now, eventTypeStr, outcomeStr, userId, apiKeyId, ipHash || null, ipMasked || null, userAgent, detailsJson],
    (err) => {
      if (err && err.message && err.message.includes('FOREIGN KEY constraint failed')) {
        const fallbackDetails = { ...sanitizedDetails, original_user_id: userId, original_api_key_id: apiKeyId };
        db.run(
          insertSql,
          [now, eventTypeStr, outcomeStr, null, null, ipHash || null, ipMasked || null, userAgent, safeJsonStringify(fallbackDetails, 4000)],
          () => {}
        );
      }
    }
  );
}

module.exports = {
  API_KEY_SCOPES,
  DEFAULT_API_KEY_SCOPES,
  DEFAULT_API_KEY_SCOPES_STORAGE,
  ALLOWED_API_KEY_SCOPES,
  PRO_API_KEY_MAX_ACTIVE,
  normalizeApiKeyScopes,
  toApiKeyScopesStorage,
  hasApiScope,
  buildApiKeyValue,
  getApiKeyPrefix,
  getApiKeyLast4,
  hashApiKeyValue,
  hashApiKeyValueLegacy,
  hashWebhookSecretValueV2,
  buildWebhookSignatureV2Key,
  hasApiKeyAuthHeader,
  getPublicBaseUrl,
  buildAbsoluteUrl,
  getConfiguredBaseHost,
  getConfiguredPublicBaseUrl,
  logSecurityEvent,
  safeJsonStringify
};

