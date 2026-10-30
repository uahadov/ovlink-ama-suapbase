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

// ---------------------------------------------------------------------------
// Signed "I know the risk" token for the dangerous-link interstitial.
// A bare ?confirm=1 asked the visitor nothing: anyone (including the abuser)
// could append it and suppress the warning entirely. The token is an HMAC over
// the short code + expiry, so it can only be produced by this server after the
// warning page was actually rendered.
// ---------------------------------------------------------------------------
const REDIRECT_CONFIRM_TTL_MS = 30 * 60 * 1000;

function signRedirectConfirmPayload(payload) {
  try {
    const secret = (process.env.SESSION_SECRET || '').toString();
    if (!secret) return '';
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  } catch {
    return '';
  }
}

function buildRedirectConfirmSignature(short, expiresAt) {
  const safeShort = (short || '').toString();
  const safeExpires = Number.parseInt(expiresAt, 10);
  if (!safeShort || !Number.isFinite(safeExpires)) return '';
  return signRedirectConfirmPayload(`ovlink:redirect-confirm:v1|${safeShort}|${safeExpires}`);
}

function buildRedirectConfirmToken(short, nowMs = Date.now()) {
  const safeShort = (short || '').toString();
  if (!safeShort) return '';
  const expiresAt = Number.parseInt(nowMs, 10) + REDIRECT_CONFIRM_TTL_MS;
  const signature = buildRedirectConfirmSignature(safeShort, expiresAt);
  if (!signature) return '';
  return `${expiresAt}.${signature}`;
}

function isRedirectConfirmTokenValid(short, rawToken, nowMs = Date.now()) {
  const safeShort = (short || '').toString();
  const value = (rawToken || '').toString().trim();
  if (!safeShort || !value) return false;
  const separator = value.indexOf('.');
  if (separator <= 0 || separator === value.length - 1) return false;
  const expiresAt = Number.parseInt(value.slice(0, separator), 10);
  const received = value.slice(separator + 1);
  if (!Number.isFinite(expiresAt) || expiresAt <= Number.parseInt(nowMs, 10)) return false;
  const expected = buildRedirectConfirmSignature(safeShort, expiresAt);
  if (!expected) return false;
  try {
    return tsscmp(expected, received);
  } catch {
    return false;
  }
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

const REDIRECT_CONSENT_COUNTDOWN_MS = 1500;
const REDIRECT_CONSENT_MARKER = 'consent_essential';

function getConsentResumePath(short, nextAction) {
  const safeShort = encodeURIComponent((short || '').toString().trim());
  const normalizedNext = normalizeConsentNext(nextAction);
  if (normalizedNext === 'proceed') {
    return `/proceed/${safeShort}`;
  }
  return `/${safeShort}`;
}

function setRedirectConsentSession(req, short, nextAction, mode) {
  if (!req || !req.session) return;
  req.session.redirectConsentApproved = {
    short: (short || '').toString(),
    next: normalizeConsentNext(nextAction),
    mode: normalizeConsentMode(mode) || REDIRECT_CONSENT_MODES.ANALYTICS,
    expiresAt: Date.now() + 15 * 60 * 1000,
  };
}

function clearRedirectConsentSession(req) {
  if (req && req.session) {
    delete req.session.redirectConsentApproved;
  }
}

function setRedirectConsentMode(res, mode) {
  if (!res || typeof res.cookie !== 'function') return;
  const normalized = normalizeConsentMode(mode) || REDIRECT_CONSENT_MODES.ANALYTICS;
  res.cookie(REDIRECT_CONSENT_COOKIE, normalized, {
    httpOnly: false,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
}

function clearRedirectConsentMode(res) {
  if (!res || typeof res.clearCookie !== 'function') return;
  res.clearCookie(REDIRECT_CONSENT_COOKIE, {
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
  });
}

module.exports = {
  buildRedirectConsentSignature,
  isRedirectConsentSignatureValid,
  buildRedirectConfirmSignature,
  buildRedirectConfirmToken,
  isRedirectConfirmTokenValid,
  REDIRECT_CONFIRM_TTL_MS,
  normalizeConsentMode,
  normalizeConsentNext,
  getRedirectConsentMode,
  getRedirectConsentModeForRequest,
  getConsentResumePath,
  setRedirectConsentSession,
  clearRedirectConsentSession,
  setRedirectConsentMode,
  clearRedirectConsentMode,
  REDIRECT_CONSENT_COOKIE,
  REDIRECT_CONSENT_MODES,
  REDIRECT_CONSENT_COUNTDOWN_MS,
  REDIRECT_CONSENT_MARKER
};

