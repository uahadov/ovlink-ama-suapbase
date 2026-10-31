// Account security primitives (W4.3, move-only from src/routes/api/account.js).
// These are the shared credential / session / 2FA helpers. Behaviour is
// unchanged; account.js (and links.js for buildBanMessage) re-export the local
// names so existing call sites and the source-level tests keep working.
const crypto = require('crypto');
const speakeasy = require('speakeasy');

const { safeDecrypt } = require('../../utils/crypto');
const { normalizeLang } = require('./i18n');

function generateVerificationCode() {
  // Math.random() is not a CSPRNG: its state is recoverable from a handful of
  // outputs, which would make 6-digit e-mail codes predictable.
  return crypto.randomInt(100000, 1000000).toString();
}

function normalizeSessionToken(raw) {
  const token = (raw || '').toString().trim();
  if (!token) return '';
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return '';
  return token;
}

function buildBanMessage(uiLang, banUntil, banReason) {
  const lang = normalizeLang(uiLang, 'az');
  let msg = lang === 'tr'
    ? 'Bu hesap engellendi.'
    : (lang === 'en' ? 'This account is blocked.' : 'Bu hesab bloklanıb.');
  return msg;
}

// TOTP secrets are stored encrypted; window 1 keeps a single clock-step of
// tolerance, which is the behaviour every existing verify call site uses.
function verifyTotpToken(encryptedSecret, token) {
  return speakeasy.totp.verify({
    secret: safeDecrypt(encryptedSecret, ''),
    encoding: 'base32',
    token,
    window: 1
  });
}

module.exports = {
  generateVerificationCode,
  normalizeSessionToken,
  buildBanMessage,
  verifyTotpToken,
};
