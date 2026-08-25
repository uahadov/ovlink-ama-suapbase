const { db } = require('../db/index');
const { normalizeHostName } = require('./url-helpers');
const { getConfiguredBaseHost } = require('./security');

const ACTIVE_CUSTOM_DOMAIN_HOSTS = new Set();

function isActiveCustomDomainHost(rawHost) {
  const host = normalizeHostName(rawHost);
  return !!host && ACTIVE_CUSTOM_DOMAIN_HOSTS.has(host);
}

function replaceCustomDomainCache(domains) {
  ACTIVE_CUSTOM_DOMAIN_HOSTS.clear();
  if (!Array.isArray(domains)) return;
  for (const item of domains) {
    const host = normalizeHostName(item);
    if (host) ACTIVE_CUSTOM_DOMAIN_HOSTS.add(host);
  }
}

async function refreshCustomDomainCache() {
  try {
    if (!db) return;
    db.all(
      "SELECT domain FROM custom_domains WHERE status = 'active'",
      [],
      (err, rows) => {
        if (err) return;
        replaceCustomDomainCache((rows || []).map((r) => r.domain));
      }
    );
  } catch {
    // ignore cache refresh errors
  }
}

function getCustomDomainTargetHost() {
  const explicit = normalizeHostName(process.env.CUSTOM_DOMAIN_TARGET_HOST || '');
  if (explicit) return explicit;
  const baseHost = getConfiguredBaseHost();
  return baseHost || '';
}

function getCustomDomainTxtHost(domain) {
  return `_ovlink-challenge.${domain}`;
}

function parseConfiguredBaseUrl(rawValue) {
  const raw = (rawValue || '').toString().trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed;
  } catch {
    return null;
  }
}

function validateBaseUrlConfiguration() {
  const rawPublic = (process.env.PUBLIC_BASE_URL || '').toString().trim();
  const rawBase = (process.env.BASE_URL || '').toString().trim();
  const parsedPublic = parseConfiguredBaseUrl(rawPublic);
  const parsedBase = parseConfiguredBaseUrl(rawBase);
  const strict = process.env.NODE_ENV === 'production';

  if (strict && !rawPublic && !rawBase) {
    console.error('[startup] PUBLIC_BASE_URL or BASE_URL must be set in production.');
    process.exit(1);
  }

  if (rawPublic && !parsedPublic) {
    console.error('[startup] PUBLIC_BASE_URL must be a valid absolute http/https URL.');
    if (strict) process.exit(1);
  }

  if (rawBase && !parsedBase) {
    console.error('[startup] BASE_URL must be a valid absolute http/https URL.');
    if (strict) process.exit(1);
  }

  if (strict && parsedPublic && parsedPublic.protocol !== 'https:') {
    console.error('[startup] PUBLIC_BASE_URL must use https in production.');
    process.exit(1);
  }

  if (strict && parsedBase && parsedBase.protocol !== 'https:') {
    console.error('[startup] BASE_URL must use https in production.');
    process.exit(1);
  }

  if (parsedPublic && parsedBase && parsedPublic.origin !== parsedBase.origin) {
    const msg = '[startup] PUBLIC_BASE_URL and BASE_URL should point to the same origin for canonical redirects.';
    if (strict) {
      console.error(msg);
      process.exit(1);
    } else {
      console.warn(msg);
    }
  }
}

module.exports = {
  isActiveCustomDomainHost,
  refreshCustomDomainCache,
  getCustomDomainTargetHost,
  getCustomDomainTxtHost,
  parseConfiguredBaseUrl,
  validateBaseUrlConfiguration
};
