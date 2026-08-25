const crypto = require('crypto');
const { db } = require('../db/index');
const { getRequestGeoMeta, hashIpForStorage } = require('./geo');
const { sendNewDeviceLoginEmailForUser } = require('./email');
const { createUserNotification } = require('./notifications');
const { normalizeLang, pickLang } = require('./i18n');

function normalizeSessionToken(raw) {
  const token = (raw || '').toString().trim();
  if (!token) return '';
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return '';
  return token;
}

function getOrCreateUserSessionToken(req) {
  if (!req || !req.session) return '';
  const existing = normalizeSessionToken(req.session.userSessionToken);
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('base64url');
  req.session.userSessionToken = token;
  return token;
}

function buildVerificationExpiryIso(minutes = 15) {
  const safeMinutes = Number.isInteger(minutes) && minutes > 0 ? minutes : 15;
  return new Date(Date.now() + safeMinutes * 60 * 1000).toISOString();
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

function buildDeviceFingerprint(agent, country, uaRaw) {
  const browser = (agent && agent.browser ? agent.browser : 'unknown').toString().toLowerCase();
  const os = (agent && agent.os ? agent.os : 'unknown').toString().toLowerCase();
  const cc = (country || 'unknown').toString().toLowerCase();
  const ua = (uaRaw || '').toString().slice(0, 200).toLowerCase();
  return crypto.createHash('sha256').update(`${browser}|${os}|${cc}|${ua}`).digest('hex');
}

function buildLoginMethodLabel(loginMethod, lang) {
  const safeLang = normalizeLang(lang, 'az');
  const method = (loginMethod || '').toString();
  if (method === 'google') {
    return pickLang(safeLang, 'Google ilə giriş', 'Google ile giriş', 'Google sign-in');
  }
  if (method === 'verify_email') {
    return pickLang(safeLang, 'E-poçt təsdiqi sonrası giriş', 'E-posta doğrulaması sonrası giriş', 'Sign-in after email verification');
  }
  return pickLang(safeLang, 'Parol ilə giriş', 'Parola ile giriş', 'Password sign-in');
}

function trackUserSession(req, userId, options = {}, done = () => {}) {
  if (!req || !req.session || !userId) return done();
  const sessionToken = getOrCreateUserSessionToken(req);
  if (!sessionToken) return done();

  const loginMethod = (options.loginMethod || 'password').toString();
  const shouldAlert = options.sendAlert !== false;
  const nowIso = new Date().toISOString();
  const agent = parseUserAgentInfo(req.headers['user-agent']);
  const geoMeta = getRequestGeoMeta(req);
  const country = geoMeta && geoMeta.country ? geoMeta.country : 'Unknown';
  const browser = agent.browser || 'Unknown';
  const os = agent.os || 'Unknown';
  const deviceLabel = `${browser} / ${os}`;
  const ipHash = hashIpForStorage(geoMeta.ip || '');
  const userAgent = (req.headers['user-agent'] || '').toString().slice(0, 512);
  const fingerprint = buildDeviceFingerprint(agent, country, userAgent);

  db.get(
    `SELECT
       COUNT(*) AS total_count,
       SUM(CASE WHEN device_fingerprint = ? THEN 1 ELSE 0 END) AS same_device_count
     FROM user_sessions
     WHERE user_id = ?`,
    [fingerprint, userId],
    (seenErr, seenMeta) => {
      const totalCount = seenErr ? 0 : Number(seenMeta && seenMeta.total_count ? seenMeta.total_count : 0);
      const sameDeviceCount = seenErr ? 0 : Number(seenMeta && seenMeta.same_device_count ? seenMeta.same_device_count : 0);
      const hadPreviousDevice = totalCount > 0;
      const isNewDevice = sameDeviceCount === 0;

      db.run(
        `INSERT INTO user_sessions (
          user_id, session_token, user_agent, device_label, browser, os, country, ip_hash,
          created_at, last_seen_at, last_login_at, last_login_method, is_revoked, revoked_at, device_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
        ON CONFLICT(session_token) DO UPDATE SET
          user_id = excluded.user_id,
          user_agent = excluded.user_agent,
          device_label = excluded.device_label,
          browser = excluded.browser,
          os = excluded.os,
          country = excluded.country,
          ip_hash = excluded.ip_hash,
          last_seen_at = excluded.last_seen_at,
          last_login_at = excluded.last_login_at,
          last_login_method = excluded.last_login_method,
          device_fingerprint = excluded.device_fingerprint
        WHERE user_sessions.is_revoked = 0`,
        [
          userId,
          sessionToken,
          userAgent,
          deviceLabel,
          browser,
          os,
          country,
          ipHash,
          nowIso,
          nowIso,
          nowIso,
          loginMethod,
          fingerprint,
        ],
        (upsertErr) => {
          const shouldNotify = !upsertErr && shouldAlert && loginMethod !== 'session_restore' && hadPreviousDevice && isNewDevice;
          if (shouldNotify) {
            const notificationPayload = {
              titleAz: 'Yeni cihazdan giriş',
              titleTr: 'Yeni cihazdan giriş',
              titleEn: 'New device sign-in',
              bodyAz: `${deviceLabel} (${country}) üzərindən yeni giriş qeydə alındı. Metod: ${buildLoginMethodLabel(loginMethod, 'az')}.`,
              bodyTr: `${deviceLabel} (${country}) üzerinden yeni giriş algılandı. Yöntem: ${buildLoginMethodLabel(loginMethod, 'tr')}.`,
              bodyEn: `A new sign-in was detected from ${deviceLabel} (${country}). Method: ${buildLoginMethodLabel(loginMethod, 'en')}.`,
              eventKey: `security_device_${fingerprint}`,
            };
            createUserNotification(db, userId, 'security', notificationPayload);
            sendNewDeviceLoginEmailForUser(userId, {
              deviceLabel,
              country,
              loginMethod,
              occurredAt: nowIso,
            });
          }
          return done();
        }
      );
    }
  );
}

module.exports = {
  trackUserSession,
  buildLoginMethodLabel,
  buildVerificationExpiryIso
};
