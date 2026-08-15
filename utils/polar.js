const crypto = require('crypto');

const POLAR_WEBHOOK_SECRET = (
  process.env.POLAR_WEBHOOK_SECRET || ''
).toString().trim();

/**
 * Verifies Standard Webhooks (used by Polar.sh) HMAC-SHA256 signature.
 * @param {Buffer|string} rawBody
 * @param {object} headers
 * @param {string} secret
 * @returns {boolean}
 */
function verifyPolarWebhook(rawBody, headers = {}, secret = POLAR_WEBHOOK_SECRET) {
  if (!secret) return false;

  const msgId = headers['webhook-id'] || headers['Webhook-Id'];
  const msgTimestamp = headers['webhook-timestamp'] || headers['Webhook-Timestamp'];
  const msgSignature = headers['webhook-signature'] || headers['Webhook-Signature'];

  if (!msgId || !msgTimestamp || !msgSignature) {
    return false;
  }

  // Prevent replay attacks (allow 5-minute clock drift)
  const timestamp = parseInt(msgTimestamp, 10);
  if (!Number.isFinite(timestamp)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return false;
  }

  let keyBuffer;
  if (secret.startsWith('whsec_')) {
    try {
      keyBuffer = Buffer.from(secret.slice(6), 'base64');
    } catch {
      keyBuffer = Buffer.from(secret, 'utf8');
    }
  } else {
    keyBuffer = Buffer.from(secret, 'utf8');
  }

  const rawPayloadString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const toSign = `${msgId}.${msgTimestamp}.${rawPayloadString}`;
  const computedSignature = crypto.createHmac('sha256', keyBuffer).update(toSign).digest('base64');

  const passedSignatures = msgSignature.split(' ').map((s) => {
    const parts = s.split(',');
    return parts.length === 2 && parts[0] === 'v1' ? parts[1] : s;
  });

  for (const sig of passedSignatures) {
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(computedSignature);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return true;
      }
    } catch (_) {}
  }

  return false;
}

/**
 * Decides how the webhook product allowlist must behave.
 * - enforce:      an expected product id is configured; only its events pass.
 * - fail_closed:  no product id configured AND running in production; the
 *                 caller must refuse to process events (otherwise ANY product
 *                 in the organization would grant entitlements).
 * - disabled:     no product id configured in a non-production environment;
 *                 callers may process events (with a warning) for local use.
 */
function resolvePolarProductPolicy(configuredId, isProduction) {
  const expectedProductId = (configuredId == null ? '' : configuredId).toString().trim();
  if (expectedProductId) {
    return { mode: 'enforce', expectedProductId };
  }
  if (isProduction) {
    return { mode: 'fail_closed', expectedProductId: '' };
  }
  return { mode: 'disabled', expectedProductId: '' };
}

module.exports = {
  POLAR_WEBHOOK_SECRET,
  verifyPolarWebhook,
  resolvePolarProductPolicy,
};
