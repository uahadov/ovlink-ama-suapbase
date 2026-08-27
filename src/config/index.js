const crypto = require('crypto');
function isEnabledEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return !!fallback;
  return ['1', 'true', 'yes', 'on'].includes((raw + '').trim().toLowerCase());
}

function estimateSecretBytes(rawSecret) {
  const raw = (rawSecret || '').toString().trim();
  if (!raw) return 0;

  let best = Buffer.byteLength(raw, 'utf8');
  const compact = raw.replace(/\s+/g, '');

  if (/^[A-Fa-f0-9]+$/.test(compact) && compact.length % 2 === 0) {
    best = Math.max(best, compact.length / 2);
  }

  if (/^[A-Za-z0-9+/_=-]+$/.test(compact)) {
    const normalizedB64 = compact.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = normalizedB64.length % 4 === 0 ? 0 : (4 - (normalizedB64.length % 4));
    const padded = normalizedB64 + '='.repeat(padLen);
    try {
      const decoded = Buffer.from(padded, 'base64');
      if (decoded && decoded.length > 0) {
        best = Math.max(best, decoded.length);
      }
    } catch {
      // ignore decode failures
    }
  }

  return best;
}

const isProdRuntime = process.env.NODE_ENV === 'production';

if (!process.env.SESSION_SECRET) {
  console.error('[startup] SESSION_SECRET is required');
  process.exit(1);
}

const sessionSecretEstimatedBytes = estimateSecretBytes(process.env.SESSION_SECRET);
if (sessionSecretEstimatedBytes < 64) {
  console.error('[startup] SESSION_SECRET must be at least 64 random bytes (or equivalent encoded length).');
  process.exit(1);
}

// Warn at startup if the Polar webhook secret is missing.  The webhook handler
// reads process.env.POLAR_WEBHOOK_SECRET at request time (not cached), so
// providing it in .env or the OS environment will activate it without restart
// in development — but in production the process must be started with the var set.
if (!process.env.POLAR_WEBHOOK_SECRET) {
  console.error('[startup] WARNING: POLAR_WEBHOOK_SECRET is not set. All Polar webhook events will be rejected with HTTP 403 and no subscription activations will succeed.');
}

if (isProdRuntime && !(process.env.POLAR_PRODUCT_ID || '').toString().trim()) {
  console.error('[startup] WARNING: POLAR_PRODUCT_ID is not set. The Polar webhook will FAIL CLOSED (HTTP 500) in production until it is configured.');
}

function decodeOptionalKeyMaterial(rawValue) {
  const raw = (rawValue || '').toString().trim();
  if (!raw) return null;

  const compact = raw.replace(/\s+/g, '');
  if (/^[A-Fa-f0-9]+$/.test(compact) && compact.length % 2 === 0) {
    try {
      const out = Buffer.from(compact, 'hex');
      if (out.length) return out;
    } catch {}
  }

  if (/^[A-Za-z0-9+/_=-]+$/.test(compact)) {
    try {
      const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
      const padLen = normalized.length % 4 === 0 ? 0 : (4 - (normalized.length % 4));
      const out = Buffer.from(normalized + '='.repeat(padLen), 'base64');
      if (out.length) return out;
    } catch {}
  }

  return Buffer.from(raw, 'utf8');
}

function resolveSecurityKeyMaterial(envName, label, options = {}) {
  const minBytes = Number.isInteger(options.minBytes) && options.minBytes > 0 ? options.minBytes : 32;
  const allowFallbackInProduction = options.allowFallbackInProduction === true;
  const explicit = decodeOptionalKeyMaterial(process.env[envName]);
  if (explicit && explicit.length) {
    if (explicit.length < minBytes) {
      const msg = `[startup] ${envName} must be at least ${minBytes} random bytes (or equivalent encoded length).`;
      if (isProdRuntime) {
        console.error(msg);
        process.exit(1);
      }
      console.warn(msg);
    }
    return explicit;
  }
  if (isProdRuntime && !allowFallbackInProduction) {
    console.error(`[startup] ${envName} is required in production and must be at least ${minBytes} random bytes.`);
    process.exit(1);
  }
  console.warn(`[startup] ${envName} missing; using SESSION_SECRET-derived fallback key.`);
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(label).digest();
}

const API_KEY_HASH_KEY_MATERIAL = resolveSecurityKeyMaterial('API_KEY_HASH_SECRET', 'ovlink:api-key-hash:v2', {
  minBytes: 64,
  allowFallbackInProduction: true,
});
const ASSET_VERSION = (process.env.ASSET_VERSION || process.env.RENDER_GIT_COMMIT || '').toString().trim() || '20260827-05';
const WEBHOOK_HASH_KEY_MATERIAL = resolveSecurityKeyMaterial('WEBHOOK_HASH_SECRET', 'ovlink:webhook-secret-hash:v2', {
  minBytes: 64,
  allowFallbackInProduction: true,
});

// Telegram calls our webhook with no built-in authenticity proof unless we
// configure a secret token (sent back on every request as the
// `X-Telegram-Bot-Api-Secret-Token` header). Without this, anyone who
// discovers the webhook URL could POST forged "updates" impersonating any
// linked Telegram user (create links against their quota, read their recent
// links, change their language, or unlink their account).
const TELEGRAM_WEBHOOK_SECRET_TOKEN = resolveSecurityKeyMaterial('TELEGRAM_WEBHOOK_SECRET', 'ovlink:telegram-webhook-secret:v1', {
  minBytes: 32,
  allowFallbackInProduction: true,
}).toString('hex').slice(0, 64);
module.exports = { isEnabledEnv, isProdRuntime, ASSET_VERSION, API_KEY_HASH_KEY_MATERIAL, WEBHOOK_HASH_KEY_MATERIAL, TELEGRAM_WEBHOOK_SECRET_TOKEN, estimateSecretBytes, resolveSecurityKeyMaterial, decodeOptionalKeyMaterial };

