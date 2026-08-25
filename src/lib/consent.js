const crypto = require('crypto');
const tsscmp = require('tsscmp');
const { WEBHOOK_HASH_KEY_MATERIAL } = require('../config/index');

const REDIRECT_CONSENT_COOKIE = 'ovlink_redirect_consent';
const REDIRECT_CONSENT_MODES = Object.freeze({
  ESSENTIAL: 'essential',
  ANALYTICS: 'analytics',
});

function getCookieValue(req, name) {
  const key = (name || '').toString().trim();
  if (!key) return '';
  try {
    const cookie = (req.headers.cookie || '').toString();
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = cookie.match(new RegExp('(?:^|;)\\s*' + escapedKey + '=([^;]+)', 'i'));
    if (!m) return '';
    return decodeURIComponent(m[1] || '').trim();
  } catch {
    return '';
  }
}

function normalizeConsentMode(raw) {
  const mode = (raw || '').toString().trim().toLowerCase();
  if (mode === REDIRECT_CONSENT_MODES.ESSENTIAL) return REDIRECT_CONSENT_MODES.ESSENTIAL;
  if (mode === REDIRECT_CONSENT_MODES.ANALYTICS) return REDIRECT_CONSENT_MODES.ANALYTICS;
  return '';
}

function normalizeConsentNext(raw) {
  return (raw || '').toString().trim().toLowerCase() === 'proceed' ? 'proceed' : 'redirect';
}

function getRedirectConsentMode(req) {
  return normalizeConsentMode(getCookieValue(req, REDIRECT_CONSENT_COOKIE));
}

function buildRedirectConsentSignature(short, nextAction, readyAt) {
  const safeShort = (short || '').toString();
  const safeNext = normalizeConsentNext(nextAction);
  const safeReadyAt = Number.parseInt(readyAt, 10);
  if (!safeShort || !Number.isFinite(safeReadyAt)) return '';
  const payload = `${safeShort}|${safeNext}|${safeReadyAt}`;
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
}

function isRedirectConsentSignatureValid(short, nextAction, readyAt, signature) {
  const expected = buildRedirectConsentSignature(short, nextAction, readyAt);
  const received = (signature || '').toString().trim();
  if (!expected || !received) return false;
  return tsscmp(expected, received);
}

function getRedirectConsentModeForRequest(req, short, nextAction) {
  const cookieMode = getRedirectConsentMode(req);
  if (cookieMode) return { mode: cookieMode, source: 'cookie' };

  const approved = req && req.session ? req.session.redirectConsentApproved : null;
  const normalizedNext = normalizeConsentNext(nextAction);
  const normalizedShort = (short || '').toString();
  if (approved
    && approved.short === normalizedShort
    && approved.next === normalizedNext
    && Number.isFinite(approved.expiresAt)
    && Date.now() <= approved.expiresAt) {
    const mode = normalizeConsentMode(approved.mode) || REDIRECT_CONSENT_MODES.ANALYTICS;
    return { mode, source: 'session' };
  }

  return { mode: '', source: '' };
}

module.exports = {
  buildRedirectConsentSignature,
  isRedirectConsentSignatureValid,
  normalizeConsentMode,
  normalizeConsentNext,
  getRedirectConsentModeForRequest
};
