const crypto = require('crypto');
const net = require('net');

const SHORT_CODE_RE = /^[A-Za-z0-9_-]{1,50}$/;

const RESERVED_SHORT_ALIASES = new Set([
  // Public pages
  'about', 'abuse-safety', 'account', 'contact', 'cookie-policy', 'dashboard',
  'docs', 'faq', 'forgot-password', 'help', 'how-it-works', 'login', 'notifications',
  'privacy', 'pricing', 'pro', 'register', 'reset-password', 'stats', 'stats-page', 'sss', 'terms',
  'updates', 'verify', 'why-ovlink', 'api-guide', 'workspaces',
  // System and route namespaces
  'admin', 'api', 'auth', 'consent', 'proceed', 'qrcode', 'verify-email', 'logout',
  // Reserved root-like names
  'robots', 'robots.txt', 'sitemap', 'sitemap.xml', 'bingsiteauth', 'yandex',
  'yandex_71461f9fd9f723bc'
]);

const CUSTOM_DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function ensureAbsoluteUrl(url) {
  if (!url) return '';
  const raw = (url || '').toString().trim();
  if (!raw) return '';
  const candidate = /^https?:\/\//i.test(raw) ? raw : ('http://' + raw);
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizeShortAlias(raw) {
  const short = (raw || '').toString().trim();
  if (!SHORT_CODE_RE.test(short)) return '';
  return short.toLowerCase();
}

function isReservedShortAlias(raw) {
  const alias = normalizeShortAlias(raw);
  if (!alias) return false;
  return RESERVED_SHORT_ALIASES.has(alias);
}

function normalizeShortCode(raw) {
  const short = (raw || '').toString().trim();
  if (!SHORT_CODE_RE.test(short)) return null;
  return short;
}

function pickFirstInputValue(...candidates) {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const value = candidate.toString().trim();
    if (value) return value;
  }
  return '';
}

function normalizeHostName(raw) {
  const value = (raw || '').toString().trim().toLowerCase();
  if (!value) return '';
  const host = value.split(':')[0].replace(/\.+$/, '');
  if (!host) return '';
  return host;
}

function normalizeCustomDomainInput(raw) {
  let value = (raw || '').toString().trim().toLowerCase();
  if (!value) return '';

  if (value.startsWith('http://') || value.startsWith('https://')) {
    try {
      value = new URL(value).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  value = value.split('/')[0].split('?')[0].split('#')[0].trim();
  if (!value) return '';
  value = value.replace(/\.+$/, '');

  if (value.includes(':')) {
    const parts = value.split(':');
    value = (parts[0] || '').trim();
  }

  if (!value || net.isIP(value)) return '';
  if (!CUSTOM_DOMAIN_RE.test(value)) return '';

  return value;
}

function getSafeHostHeader(req) {
  const host = (req.get('host') || '').toString().trim();
  if (!host) return '';
  if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host)) return '';
  return host;
}

function getRequestHostName(req) {
  const hostHeader = getSafeHostHeader(req);
  if (hostHeader) return normalizeHostName(hostHeader);
  return normalizeHostName(req && req.hostname);
}

function buildShortUrl(req, short, customDomainHost) {
  const shortPath = '/' + encodeURIComponent((short || '').toString().trim());
  if (customDomainHost) {
    const cleanHost = normalizeHostName(customDomainHost);
    if (cleanHost) {
      return `https://${cleanHost}${shortPath}`;
    }
  }
  const { buildAbsoluteUrl } = require('./security');
  return buildAbsoluteUrl(req, shortPath);
}

function buildAbsoluteUrlForHost(req, host, pathValue) {
  const cleanHost = normalizeHostName(host);
  const safePath = (pathValue || '/').toString();
  const normalizedPath = safePath.startsWith('/') ? safePath : `/${safePath}`;
  if (cleanHost) {
    const proto = req && req.secure ? 'https' : 'http';
    return `${proto}://${cleanHost}${normalizedPath}`;
  }
  const { buildAbsoluteUrl } = require('./security');
  return buildAbsoluteUrl(req, normalizedPath);
}

module.exports = {
  ensureAbsoluteUrl,
  normalizeShortCode,
  isReservedShortAlias,
  pickFirstInputValue,
  normalizeCustomDomainInput,
  normalizeHostName,
  getSafeHostHeader,
  getRequestHostName,
  buildShortUrl,
  buildAbsoluteUrlForHost,
  CUSTOM_DOMAIN_RE,
  RESERVED_SHORTS: RESERVED_SHORT_ALIASES
};

