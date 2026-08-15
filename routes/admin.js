const path = require('path');
const express = require('express');
const { encryptAES256GCM, decryptAES256GCM, blindIndex } = require('../utils/crypto.js');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const geoip = require('geoip-lite');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');

const REPORT_THRESHOLD = 4;
const SHORT_CODE_RE = /^[A-Za-z0-9_-]{1,50}$/;

const LINKS_SORT_SQL = Object.freeze({
  recent: 'datetime(u.created_at) DESC',
  reports: 'u.reports DESC, datetime(u.created_at) DESC',
  clicks: 'clicks_count DESC, datetime(u.created_at) DESC',
});

const SITE_USERS_SORT_SQL = Object.freeze({
  recent: 'last_link_at DESC, u.id DESC',
  links: 'link_count DESC, u.id DESC',
  reports: 'open_reports DESC, u.id DESC',
});

const PLAN_TIERS = Object.freeze({
  FREE: 'free',
  PRO: 'pro',
});

const PLAN_STATUS = Object.freeze({
  ACTIVE: 'active',
  PAUSED: 'paused',
});

function normalizePlanTier(raw) {
  const value = (raw || '').toString().trim().toLowerCase();
  return value === PLAN_TIERS.PRO ? PLAN_TIERS.PRO : PLAN_TIERS.FREE;
}

function normalizePlanStatus(raw) {
  const value = (raw || '').toString().trim().toLowerCase();
  return value === PLAN_STATUS.PAUSED ? PLAN_STATUS.PAUSED : PLAN_STATUS.ACTIVE;
}

function parseDurationSpec(rawValue, rawUnit) {
  const unit = (rawUnit || '').toString().trim().toLowerCase();
  const value = Number.parseInt((rawValue || '').toString(), 10);
  if (!Number.isInteger(value) || value <= 0) return null;
  if (unit === 'minute' || unit === 'minutes') return { value, unit: 'minute', seconds: value * 60 };
  if (unit === 'hour' || unit === 'hours') return { value, unit: 'hour', seconds: value * 60 * 60 };
  if (unit === 'day' || unit === 'days') return { value, unit: 'day', seconds: value * 24 * 60 * 60 };
  if (unit === 'month' || unit === 'months') return { value, unit: 'month', seconds: value * 30 * 24 * 60 * 60 };
  if (unit === 'year' || unit === 'years') return { value, unit: 'year', seconds: value * 365 * 24 * 60 * 60 };
  return null;
}

function applyDurationToDate(baseDate, durationSpec) {
  const result = new Date(baseDate.getTime());
  const value = durationSpec && durationSpec.value ? durationSpec.value : 0;
  const unit = durationSpec && durationSpec.unit ? durationSpec.unit : '';
  if (!value || !unit) return result;
  if (unit === 'minute') {
    result.setUTCMinutes(result.getUTCMinutes() + value);
  } else if (unit === 'hour') {
    result.setUTCHours(result.getUTCHours() + value);
  } else if (unit === 'day') {
    result.setUTCDate(result.getUTCDate() + value);
  } else if (unit === 'month') {
    result.setUTCMonth(result.getUTCMonth() + value);
  } else if (unit === 'year') {
    result.setUTCFullYear(result.getUTCFullYear() + value);
  }
  return result;
}

function parseIsoMs(raw) {
  if (!raw) return Number.NaN;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function isProCurrentlyActiveRow(row, nowMs = Date.now()) {
  if (!row) return false;
  if (normalizePlanTier(row.plan_tier) !== PLAN_TIERS.PRO) return false;
  if (normalizePlanStatus(row.plan_status) !== PLAN_STATUS.ACTIVE) return false;
  const expiresMs = parseIsoMs(row.pro_expires_at);
  if (!Number.isFinite(expiresMs)) return false;
  return expiresMs > nowMs;
}

function makeDb(db) {
  const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
  const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
  return { get, all, run };
}

function nowIso() {
  return new Date().toISOString();
}

function safeNext(nextUrl) {
  if (!nextUrl || typeof nextUrl !== 'string') return null;
  const value = nextUrl.trim();
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//')) return null;
  if (value.includes('\\')) return null;
  if (/[\r\n\t]/.test(value)) return null;
  if (!/^[\x20-\x7E]+$/.test(value)) return null;
  if (value.length > 512) return null;
  return value;
}

function normalizeIp(rawIp) {
  let ip = (rawIp || '').toString().trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function getClientIp(req, ipResolver = null) {
  try {
    if (typeof ipResolver === 'function') {
      const resolved = normalizeIp(ipResolver(req));
      if (resolved) return resolved;
    }
  } catch {}
  return normalizeIp(req && (req.ip || req.socket?.remoteAddress));
}

function normalizeCountryCode(raw) {
  const code = (raw || '').toString().trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  if (code === 'XX' || code === 'T1' || code === 'A1' || code === 'A2') return '';
  return code;
}

function isPrivateIp(ip) {
  const value = normalizeIp(ip).toLowerCase();
  if (!value) return false;
  if (value === '::1' || value === '127.0.0.1' || value === 'localhost') return true;
  if (value.startsWith('10.') || value.startsWith('192.168.')) return true;
  if (value.startsWith('172.')) {
    const parts = value.split('.');
    const second = Number.parseInt(parts[1] || '0', 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) return true;
  return false;
}

function getCountryCodeFromIp(ip) {
  const normalizedIp = normalizeIp(ip);
  if (!normalizedIp) return 'Unknown';
  if (isPrivateIp(normalizedIp)) return 'Local Dev';
  const geo = geoip.lookup(normalizedIp);
  const geoCountry = normalizeCountryCode(geo && geo.country);
  return geoCountry || 'Unknown';
}

function parseDomain(url) {
  try {
    const u = new URL(url);
    return (u.hostname || '').toLowerCase();
  } catch {
    return '';
  }
}
function isValidBlockDomain(domain) {
  const d = (domain || '').toString().trim().toLowerCase();
  if (!d || d.length > 253) return false;
  if (d.includes('..')) return false;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(d);
}

function normalizeSearchQuery(raw) {
  const q = (raw || '').toString().trim();
  if (!q) return '';

  // If user pastes a full short URL, extract the code (path segment).
  try {
    if (q.includes('://')) {
      const u = new URL(q);
      const seg = (u.pathname || '').replace(/^\/+/, '').trim();
      if (seg && !seg.includes('/')) return seg;
    }
  } catch {
    // ignore
  }

  // Also handle scheme-less pastes like "example.com/abc123" or "localhost:3000/abc123".
  // To avoid mangling normal URLs, only extract when it looks like a single path segment.
  if (!q.includes('://')) {
    const cleaned = q.split('?')[0].split('#')[0];
    const m = cleaned.match(/^(?:[A-Za-z0-9.-]+(?::\d+)?)(?:\/)([A-Za-z0-9_-]+)$/);
    if (m && m[1]) return m[1];
  }

  return q;
}

function normalizeShortCode(raw) {
  const short = (raw || '').toString().trim();
  if (!SHORT_CODE_RE.test(short)) return null;
  return short;
}


module.exports = function createAdminRouter(db, options = {}) {
  const router = express.Router();
  const { get, all, run } = makeDb(db);
  const createRateLimitStore = options && typeof options.createRateLimitStore === 'function'
    ? options.createRateLimitStore
    : null;
  const getRequestIpFromOptions = options && typeof options.getRequestIp === 'function'
    ? options.getRequestIp
    : null;
  const getRequestGeoMetaFromOptions = options && typeof options.getRequestGeoMeta === 'function'
    ? options.getRequestGeoMeta
    : null;
  const blockIpFn = options && typeof options.blockIp === 'function' ? options.blockIp : null;
  const unblockIpFn = options && typeof options.unblockIp === 'function' ? options.unblockIp : null;
  const getBlockedIpsFn = options && typeof options.getBlockedIps === 'function' ? options.getBlockedIps : null;

  function getClientIpForAdmin(req) {
    return getClientIp(req, getRequestIpFromOptions);
  }

  function getGeoMetaForAdminRequest(req) {
    if (req && req._adminGeoMeta && typeof req._adminGeoMeta === 'object') {
      return req._adminGeoMeta;
    }

    let resolvedIp = getClientIpForAdmin(req);
    let country = 'Unknown';
    let city = 'Unknown';

    try {
      if (typeof getRequestGeoMetaFromOptions === 'function') {
        const external = getRequestGeoMetaFromOptions(req) || {};
        const extIp = normalizeIp(external.ip);
        if (extIp) resolvedIp = extIp;
        if ((external.country || '').toString().trim() === 'Local Dev') {
          country = 'Local Dev';
        } else {
          const extCountry = normalizeCountryCode(external.country);
          if (extCountry) country = extCountry;
        }
        if (external.city && typeof external.city === 'string' && external.city.trim()) {
          city = external.city.trim();
        }
      }
    } catch {}

    if (country === 'Unknown') {
      const cfCountry = normalizeCountryCode(
        req && typeof req.get === 'function'
          ? (req.get('cf-ipcountry') || req.get('x-vercel-ip-country'))
          : ''
      );
      if (cfCountry) {
        country = cfCountry;
      } else if (isPrivateIp(resolvedIp)) {
        country = 'Local Dev';
        city = 'Localhost';
      } else {
        const geo = geoip.lookup(resolvedIp || '');
        const geoCountry = normalizeCountryCode(geo && geo.country);
        if (geoCountry) country = geoCountry;
        if (geo && geo.city) city = (geo.city || '').toString().trim() || city;
      }
    }

    const out = { ip: resolvedIp, country, city };
    if (req) req._adminGeoMeta = out;
    return out;
  }

  function buildAdminRateLimitKey(req, scope = 'admin') {
    const safeScope = (scope || 'admin').toString().slice(0, 24);
    if (req && req.session && Number.isInteger(req.session.adminUserId)) {
      return `${safeScope}:admin:${req.session.adminUserId}`;
    }
    const ip = getClientIpForAdmin(req) || 'unknown';
    return `${safeScope}:ip:${ip}`;
  }

  async function notifyUserDisabledLink(short, reason) {
    try {
      const url = await get('SELECT user_id FROM urls WHERE short = ?', [short]);
      if (!url || !url.user_id) return;
      const prefs = await get('SELECT notify_disabled FROM users WHERE id = ?', [url.user_id]);
      if (!prefs || prefs.notify_disabled != 1) return;

      const bodyAz = reason ? `Qısa link: ${short}. Səbəb: ${reason}` : `Qısa link: ${short}.`;
      const bodyTr = reason ? `Kısa link: ${short}. Sebep: ${reason}` : `Kısa link: ${short}.`;
      const bodyEn = reason ? `Short link: ${short}. Reason: ${reason}` : `Short link: ${short}.`;

      await run(
        'INSERT INTO notifications (user_id, type, title_az, title_tr, title_en, body_az, body_tr, body_en, link_short, event_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          url.user_id,
          'disabled',
          'Linkiniz deaktiv edildi',
          'Linkiniz devre dışı bırakıldı',
          'Your link was disabled',
          bodyAz,
          bodyTr,
          bodyEn,
          short,
          `disabled_${short}_${Date.now()}`,
          nowIso(),
        ],
      );
    } catch (e) {
      // best-effort
    }
  }

  function buildSubscriptionReasonSuffix(reason, lang) {
    const text = (reason || '').toString().trim();
    if (!text) return '';
    if (lang === 'tr') return ` Sebep: ${text}`;
    if (lang === 'en') return ` Reason: ${text}`;
    return ` Səbəb: ${text}`;
  }

  async function notifyUserSubscriptionChange(userId, action, afterRow, reason) {
    try {
      if (!userId) return;

      const mode = (action || 'downgrade').toString().trim().toLowerCase();
      const expiresAt = afterRow && afterRow.pro_expires_at ? afterRow.pro_expires_at : null;
      const expiresAz = expiresAt ? ` Bitmə: ${expiresAt}.` : '';
      const expiresTr = expiresAt ? ` Bitiş: ${expiresAt}.` : '';
      const expiresEn = expiresAt ? ` Expires: ${expiresAt}.` : '';
      const reasonAz = buildSubscriptionReasonSuffix(reason, 'az');
      const reasonTr = buildSubscriptionReasonSuffix(reason, 'tr');
      const reasonEn = buildSubscriptionReasonSuffix(reason, 'en');

      let titleAz = 'Abunəlik yeniləndi';
      let titleTr = 'Abonelik güncellendi';
      let titleEn = 'Subscription updated';
      let bodyAz = 'Admin hesab abunəliyinizdə dəyişiklik etdi.';
      let bodyTr = 'Admin hesap aboneliğinizde değişiklik yaptı.';
      let bodyEn = 'An admin changed your subscription settings.';

      if (mode === 'activate') {
        titleAz = 'Pro plan aktiv edildi';
        titleTr = 'Pro plan aktif edildi';
        titleEn = 'Pro plan activated';
        bodyAz = `Admin hesabınız üçün Pro planı aktiv etdi.${expiresAz}${reasonAz}`;
        bodyTr = `Admin hesabınız için Pro planı aktif etti.${expiresTr}${reasonTr}`;
        bodyEn = `An admin activated Pro for your account.${expiresEn}${reasonEn}`;
      } else if (mode === 'extend') {
        titleAz = 'Pro plan müddəti uzadıldı';
        titleTr = 'Pro plan süresi uzatıldı';
        titleEn = 'Pro plan extended';
        bodyAz = `Pro plan müddətiniz uzadıldı.${expiresAz}${reasonAz}`;
        bodyTr = `Pro plan süreniz uzatıldı.${expiresTr}${reasonTr}`;
        bodyEn = `Your Pro plan duration was extended.${expiresEn}${reasonEn}`;
      } else if (mode === 'pause') {
        titleAz = 'Pro plan dayandırıldı';
        titleTr = 'Pro plan durduruldu';
        titleEn = 'Pro plan paused';
        bodyAz = `Pro planınız müvəqqəti dayandırıldı.${reasonAz}`;
        bodyTr = `Pro planınız geçici olarak durduruldu.${reasonTr}`;
        bodyEn = `Your Pro plan has been paused.${reasonEn}`;
      } else if (mode === 'resume') {
        titleAz = 'Pro plan bərpa edildi';
        titleTr = 'Pro plan devam ettirildi';
        titleEn = 'Pro plan resumed';
        bodyAz = `Pro planınız yenidən aktiv edildi.${expiresAz}${reasonAz}`;
        bodyTr = `Pro planınız yeniden aktif edildi.${expiresTr}${reasonTr}`;
        bodyEn = `Your Pro plan has been resumed.${expiresEn}${reasonEn}`;
      } else if (mode === 'downgrade' || mode === 'revoke') {
        titleAz = 'Hesab Free plana keçirildi';
        titleTr = 'Hesap Free plana düşürüldü';
        titleEn = 'Account downgraded to Free';
        bodyAz = `Pro girişiniz dayandırıldı və hesabınız Free plana keçirildi.${reasonAz}`;
        bodyTr = `Pro erişiminiz sonlandırıldı ve hesabınız Free plana düşürüldü.${reasonTr}`;
        bodyEn = `Your Pro access was revoked and your account was downgraded to Free.${reasonEn}`;
      } else {
        bodyAz += reasonAz;
        bodyTr += reasonTr;
        bodyEn += reasonEn;
      }

      await run(
        'INSERT INTO notifications (user_id, type, title_az, title_tr, title_en, body_az, body_tr, body_en, link_short, event_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          userId,
          'security',
          titleAz,
          titleTr,
          titleEn,
          bodyAz,
          bodyTr,
          bodyEn,
          null,
          `subscription_${mode}_${userId}_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
          nowIso(),
        ],
      );
    } catch {
      // best-effort notification
    }
  }

  function requireAdmin(req, res, next) {
    if (!req.session || !req.session.adminUserId) {
      const n = safeNext(req.originalUrl);
      const q = n ? ('?next=' + encodeURIComponent(n)) : '';
      return res.redirect('/admin/login' + q);
    }
    res.locals.admin = {
      id: req.session.adminUserId,
      email: req.session.adminEmail,
      role: req.session.adminRole,
    };
    return next();
  }

  function requireRole(role) {
    return (req, res, next) => {
      if (!req.session || !req.session.adminUserId) return requireAdmin(req, res, next);
      res.locals.admin = {
        id: req.session.adminUserId,
        email: req.session.adminEmail,
        role: req.session.adminRole,
      };
      if (req.session.adminRole !== role) return res.status(403).render('admin/forbidden');
      return next();
    };
  }

  function safeAdminReturn(url) {
    const n = safeNext(url);
    if (!n) return null;
    if (!n.startsWith('/admin')) return null;
    return n;
  }

  // Strict CSP for /admin only: no inline scripts/styles.
  router.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        connectSrc: ["'self'"],
      },
    },
  }));

  // Avoid stale admin pages after moderation actions.
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
  });

  router.use((req, res, next) => {
    res.locals.csrfToken = res.locals._csrf;
    next();
  });

  const loginLimiterOptions = {
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyGenerator: (req) => buildAdminRateLimitKey(req, 'admin-login'),
    standardHeaders: true,
    legacyHeaders: false,
  };
  if (createRateLimitStore) loginLimiterOptions.store = createRateLimitStore('admin-login');
  const loginLimiter = rateLimit(loginLimiterOptions);

  // DDoS KORUMA: Admin 2FA brute-force koruması (6 haneli TOTP)
  const twoFaVerifyLimiterOptions = {
    windowMs: 15 * 60 * 1000, // 15 dakika
    max: 5, // 15 dakikada max 5 deneme
    message: { error: 'Too many 2FA attempts. Please try again in 15 minutes.' },
    keyGenerator: (req) => buildAdminRateLimitKey(req, 'admin-2fa'),
    standardHeaders: true,
    legacyHeaders: false,
  };
  if (createRateLimitStore) twoFaVerifyLimiterOptions.store = createRateLimitStore('admin-2fa');
  const twoFaVerifyLimiter = rateLimit(twoFaVerifyLimiterOptions);

  // DDoS KORUMA: Admin POST rotaları için genel limiter
  const adminPostLimiterOptions = {
    windowMs: 60 * 1000, // 1 dakika
    max: 60, // Dakikada max 60 POST
    message: { error: 'Too many requests. Please try again in 1 minute.' },
    keyGenerator: (req) => buildAdminRateLimitKey(req, 'admin-post'),
    standardHeaders: true,
    legacyHeaders: false,
  };
  if (createRateLimitStore) adminPostLimiterOptions.store = createRateLimitStore('admin-post');
  const adminPostLimiter = rateLimit(adminPostLimiterOptions);

  const adminGetLimiterOptions = {
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
  };
  if (createRateLimitStore) adminGetLimiterOptions.store = createRateLimitStore('admin-get');
  const adminGetLimiter = rateLimit(adminGetLimiterOptions);
  
  const adminCssFile = path.join(__dirname, '../public/admin/admin.css');
  const adminJsFile = path.join(__dirname, '../public/admin/admin.js');

  router.get('/admin.css', (req, res) => {
    res.setHeader('Content-Type', 'text/css');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(adminCssFile);
  });

  router.get('/admin.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.sendFile(adminJsFile);
  });

  router.use((req, res, next) => {
    if (req.method === 'GET') {
      return adminGetLimiter(req, res, next);
    }
    if (req.method === 'POST' && req.path !== '/login') {
      return adminPostLimiter(req, res, next);
    }
    return next();
  });

  router.get('/', (req, res) => {
    if (req.session && req.session.adminUserId) return res.redirect('/admin/links');
    return res.render('admin/login', {
      csrfToken: res.locals._csrf,
      error: (req.query.msg || '').toString() || null,
      next: '/admin/links',
    });
  });

  router.get('/login', (req, res) => {
    if (req.session && req.session.adminUserId) return res.redirect('/admin/links');
    const nextUrl = safeAdminReturn(req.query.next) || '/admin/links';
    return res.render('admin/login', {
      csrfToken: res.locals._csrf,
      error: (req.query.msg || '').toString() || null,
      next: nextUrl,
    });
  });

  
  function requirePending2FA(req, res, next) {
    if (!req.session || !req.session.pendingAdminUserId) return res.redirect('/admin/login');
    return next();
  }

  router.get('/2fa', requirePending2FA, (req, res) => {
    return res.render('admin/2fa', {
      error: (req.query.msg || '').toString() || null,
      next: safeAdminReturn(req.session.pendingAdminNext) || '/admin/links',
    });
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const email = (req.body.email || '').toString().trim().toLowerCase();
    const password = (req.body.password || '').toString();
    const nextUrl = safeNext(req.body.next) || '/admin/links';

    await logAdminAuthEvent(req, 'ADMIN_LOGIN_ATTEMPT', email);
    await audit(req, 'ADMIN_LOGIN_ATTEMPT', 'admin_user', email || 'unknown', { next: nextUrl });

    if (!email || !password) {
      await logAdminAuthEvent(req, 'ADMIN_LOGIN_FAILURE', email);
      await audit(req, 'ADMIN_LOGIN_FAILURE', 'admin_user', email || 'unknown', { reason: 'missing_credentials' });
      return res.status(400).render('admin/login', { error: 'Email and password are required.', next: nextUrl });
    }

    try {
      const user = await get('SELECT * FROM admin_users WHERE email_hash = ?', [blindIndex(email)]);
      if (user) user.email = decryptAES256GCM(user.email);
      if (user) user.totp_secret = decryptAES256GCM(user.totp_secret);
      const genericErr = 'Invalid login credentials.';

      if (!user) {
        await logAdminAuthEvent(req, 'ADMIN_LOGIN_FAILURE', email);
        await audit(req, 'ADMIN_LOGIN_FAILURE', 'admin_user', email, { reason: 'user_not_found' });
        return res.status(401).render('admin/login', { error: genericErr, next: nextUrl });
      }

      const lockUntil = user.lock_until ? Date.parse(user.lock_until) : 0;
      if (lockUntil && lockUntil > Date.now()) {
        await logAdminAuthEvent(req, 'ADMIN_LOGIN_FAILURE', email);
        await audit(req, 'ADMIN_LOGIN_FAILURE', 'admin_user', email, { reason: 'account_locked', lock_until: user.lock_until || null });
        return res.status(429).render('admin/login', {
          error: 'Too many attempts. Please try again later.',
          next: nextUrl,
        });
      }

      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        const nextFails = (user.failed_login_count || 0) + 1;
        const shouldLock = nextFails >= 5;
        const newLockUntil = shouldLock ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
        await run(
          'UPDATE admin_users SET failed_login_count = ?, lock_until = ?, last_failed_at = ? WHERE id = ?',
          [shouldLock ? 0 : nextFails, newLockUntil, nowIso(), user.id],
        );
        await logAdminAuthEvent(req, 'ADMIN_LOGIN_FAILURE', email);
        await audit(req, 'ADMIN_LOGIN_FAILURE', 'admin_user', email, { reason: 'invalid_password', failed_login_count: nextFails });
        return res.status(401).render('admin/login', { error: genericErr, next: nextUrl });
      }

      await run(
        'UPDATE admin_users SET failed_login_count = 0, lock_until = NULL, last_login_at = ? WHERE id = ?',
        [nowIso(), user.id],
      );

      await logAdminAuthEvent(req, 'ADMIN_LOGIN_SUCCESS', email);
      await audit(req, 'ADMIN_LOGIN_SUCCESS', 'admin_user', String(user.id), { email: user.email, role: user.role, requires_2fa: Number(user.totp_enabled) === 1 });

      // Prevent session fixation
      req.session.regenerate((err) => {
        if (err) {
          console.error('[admin] session regenerate error:', err);
          void audit(req, 'ADMIN_LOGIN_FAILURE', 'admin_user', email || 'unknown', { reason: 'session_regeneration_failed' });
          return res.status(500).render('admin/login', { error: 'Session error.', next: nextUrl });
        }

        const has2FA = Number(user.totp_enabled) === 1 && !!user.totp_secret;
        if (has2FA) {
          req.session.pendingAdminUserId = user.id;
          req.session.pendingAdminEmail = user.email;
          req.session.pendingAdminRole = user.role;
          req.session.pendingAdminNext = safeAdminReturn(nextUrl) || '/admin/links';
          void audit(req, 'ADMIN_2FA_CHALLENGE_REQUIRED', 'admin_user', String(user.id), { email: user.email });
          return req.session.save((saveErr) => {
            if (saveErr) console.error('[admin] 2fa session save error:', saveErr);
            res.redirect('/admin/2fa');
          });
        }

        req.session.adminUserId = user.id;
        req.session.adminEmail = user.email;
        req.session.adminRole = user.role;
        req.session.save((saveErr) => {
          if (saveErr) {
            console.error('[admin] login session save error:', saveErr);
            void audit(req, 'ADMIN_LOGIN_FAILURE', 'admin_user', email || 'unknown', { reason: 'session_save_failed' });
            return res.status(500).render('admin/login', { error: 'Session error.', next: nextUrl });
          }
          res.redirect(nextUrl);
        });
      });
    } catch (e) {
      console.error('[admin] login error:', e);
      await audit(req, 'ADMIN_LOGIN_FAILURE', 'admin_user', email || 'unknown', { reason: 'server_error' });
      return res.status(500).render('admin/login', { error: 'Server error.', next: nextUrl });
    }
  });


  router.post('/2fa/verify', requirePending2FA, twoFaVerifyLimiter, async (req, res) => {
    const token = (req.body.token || '').toString().replace(/\s+/g, '');
    const nextUrl = safeAdminReturn(req.session.pendingAdminNext) || '/admin/links';

    if (!/^\d{6}$/.test(token)) {
      await audit(req, 'ADMIN_2FA_VERIFY_FAILURE', 'admin_user', String(req.session.pendingAdminUserId || ''), { reason: 'invalid_format' });
      return res.status(400).render('admin/2fa', { error: 'Code must be 6 digits.', next: nextUrl });
    }

    try {
      const user = await get('SELECT id, email, role, totp_enabled, totp_secret FROM admin_users WHERE id = ?', [req.session.pendingAdminUserId]);
      if (user) user.email = decryptAES256GCM(user.email);
      if (user) user.totp_secret = decryptAES256GCM(user.totp_secret);
      if (!user || Number(user.totp_enabled) !== 1 || !user.totp_secret) {
        await audit(req, 'ADMIN_2FA_VERIFY_FAILURE', 'admin_user', String(req.session.pendingAdminUserId || ''), { reason: 'setup_missing' });
        return res.status(401).render('admin/2fa', { error: '2FA setup was not found.', next: nextUrl });
      }

      const ok = speakeasy.totp.verify({
        secret: user.totp_secret,
        encoding: 'base32',
        token,
        window: 1,
      });

      if (!ok) {
        await logAdminAuthEvent(req, 'ADMIN_LOGIN_FAILURE', user.email || req.session.pendingAdminEmail || '');
        await audit(req, 'ADMIN_2FA_VERIFY_FAILURE', 'admin_user', String(user.id), { reason: 'invalid_code', email: user.email });
        return res.status(401).render('admin/2fa', { error: 'Invalid code.', next: nextUrl });
      }

      req.session.adminUserId = user.id;
      req.session.adminEmail = user.email;
      req.session.adminRole = user.role;
      delete req.session.pendingAdminUserId;
      delete req.session.pendingAdminEmail;
      delete req.session.pendingAdminRole;
      delete req.session.pendingAdminNext;

      await logAdminAuthEvent(req, 'ADMIN_2FA_VERIFY_SUCCESS', user.email || req.session.pendingAdminEmail || '');
      await audit(req, 'ADMIN_2FA_VERIFY_SUCCESS', 'admin_user', String(user.id), { email: user.email, next: nextUrl });
      return req.session.save(() => res.redirect(nextUrl));
    } catch (e) {
      console.error('[admin] 2fa verify error:', e);
      await audit(req, 'ADMIN_2FA_VERIFY_FAILURE', 'admin_user', String(req.session.pendingAdminUserId || ''), { reason: 'server_error' });
      return res.status(500).render('admin/2fa', { error: 'Server error.', next: nextUrl });
    }
  });
  router.post('/logout', requireAdmin, async (req, res) => {
    await audit(req, 'ADMIN_LOGOUT', 'admin_user', String(req.session.adminUserId || ''), {
      email: req.session.adminEmail || null,
      role: req.session.adminRole || null,
    });
    try { res.clearCookie('connect.sid'); } catch {}
    if (!req.session) return res.redirect('/');
    req.session.destroy(() => {
      return res.redirect('/');
    });
  });

  function buildAuditContext(req, extra) {
    const geoMeta = getGeoMetaForAdminRequest(req);
    const query = {};
    const querySource = (req && req.query && typeof req.query === 'object') ? req.query : {};
    for (const [key, value] of Object.entries(querySource)) {
      if (typeof value === 'string') {
        query[key] = value.slice(0, 200);
      } else if (Array.isArray(value)) {
        query[key] = value.map((v) => String(v).slice(0, 200));
      } else if (value != null) {
        query[key] = String(value).slice(0, 200);
      }
    }

    return {
      country: geoMeta.country || 'Unknown',
      city: geoMeta.city || 'Unknown',
      method: req.method,
      path: req.originalUrl,
      referer: (req.headers.referer || '').toString().slice(0, 300),
      query,
      admin_email: req.session?.adminEmail || req.session?.pendingAdminEmail || null,
      admin_role: req.session?.adminRole || req.session?.pendingAdminRole || null,
      ...extra,
    };
  }

  async function audit(req, action, targetType, targetId, metadata) {
    try {
      const geoMeta = getGeoMetaForAdminRequest(req);
      const auditMetadata = buildAuditContext(req, metadata || {});
      await run(
        'INSERT INTO admin_audit_log (created_at, admin_user_id, action, target_type, target_id, metadata_json, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          nowIso(),
          req.session && req.session.adminUserId ? req.session.adminUserId : null,
          action,
          targetType,
          (targetId || '').toString(),
          JSON.stringify(auditMetadata),
          geoMeta.ip || null,
          (req.headers['user-agent'] || '').toString().slice(0, 512),
        ],
      );
    } catch {
      // best-effort
    }
  }

  async function logSubscriptionAudit(req, userId, action, beforeRow, afterRow, durationSeconds, reason, extraMeta = {}) {
    try {
      await run(
        'INSERT INTO subscription_audit (created_at, admin_user_id, target_user_id, action, old_tier, new_tier, old_status, new_status, old_expires_at, new_expires_at, duration_seconds, reason, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          nowIso(),
          req.session && req.session.adminUserId ? req.session.adminUserId : null,
          userId,
          (action || '').toString().slice(0, 64),
          normalizePlanTier(beforeRow && beforeRow.plan_tier),
          normalizePlanTier(afterRow && afterRow.plan_tier),
          normalizePlanStatus(beforeRow && beforeRow.plan_status),
          normalizePlanStatus(afterRow && afterRow.plan_status),
          beforeRow && beforeRow.pro_expires_at ? beforeRow.pro_expires_at : null,
          afterRow && afterRow.pro_expires_at ? afterRow.pro_expires_at : null,
          Number.isInteger(durationSeconds) ? durationSeconds : null,
          (reason || '').toString().trim().slice(0, 500) || null,
          JSON.stringify(extraMeta || {}),
        ],
      );
    } catch {
      // best effort
    }
  }

  async function logAdminAuthEvent(req, eventType, emailOrUser) {
    const geoMeta = getGeoMetaForAdminRequest(req);
    try {
      await run(
        'INSERT INTO admin_auth_audit (event_type, email_or_username, ip_address, country, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          eventType,
          (emailOrUser || '').toString().slice(0, 255),
          geoMeta.ip || null,
          geoMeta.country || 'Unknown',
          (req.headers['user-agent'] || '').toString().slice(0, 512),
          nowIso(),
        ],
      );
    } catch {
      // Backward-compatibility for instances that have not added admin_auth_audit.country yet.
      try {
        await run(
          'INSERT INTO admin_auth_audit (event_type, email_or_username, ip_address, user_agent, created_at) VALUES (?, ?, ?, ?, ?)',
          [
            eventType,
            (emailOrUser || '').toString().slice(0, 255),
            geoMeta.ip || null,
            (req.headers['user-agent'] || '').toString().slice(0, 512),
            nowIso(),
          ],
        );
      } catch {}
    }
  }


  async function loadLink(short) {
    const safeShort = normalizeShortCode(short);
    if (!safeShort) return null;
    const row = await get(
      'SELECT u.*, usr.email AS owner_email, ' +
      '  (SELECT COUNT(*) FROM clicks c WHERE c.url_id = u.id) AS clicks_count ' +
      'FROM urls u ' +
      'LEFT JOIN users usr ON usr.id = u.user_id ' +
      'WHERE u.short = ?',
      [safeShort],
    );
    if (row && row.owner_email) {
      row.owner_email = decryptAES256GCM(row.owner_email);
    }
    return row;
  }

  async function loadReports(short) {
    const safeShort = normalizeShortCode(short);
    if (!safeShort) return [];
    const rows = await all(
      'SELECT r.*, u.email AS reporter_email ' +
      'FROM reports r ' +
      'LEFT JOIN users u ON u.id = r.user_id ' +
      'WHERE r.short = ? ' +
      'ORDER BY datetime(r.created_at) DESC',
      [safeShort],
    );
    (rows || []).forEach((r) => {
      if (r.reporter_email) {
        r.reporter_email = decryptAES256GCM(r.reporter_email);
      }
    });
    return rows;
  }

  // ==============================
  // Reports (open moderation queue)
  // ==============================
  router.get('/reports', requireAdmin, async (req, res) => {
    const qRaw = (req.query.q || '').toString();
    const q = normalizeSearchQuery(qRaw);

    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const pageSize = 25;
    const offset = (page - 1) * pageSize;

    const where = ['u.reports >= ?'];
    const params = [REPORT_THRESHOLD];

    if (q) {
      where.push('(LOWER(u.short) LIKE ? OR LOWER(u.original) LIKE ?)');
      const like = '%' + q.toLowerCase() + '%';
      params.push(like, like);
    }

    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

    const totalRow = await get('SELECT COUNT(*) AS cnt FROM urls u ' + whereSql, params);
    const rows = await all(
      'SELECT ' +
        'u.short, u.original, u.created_at, u.reports, u.dangerous, u.disabled, u.disabled_reason, ' +
        "CASE WHEN u.link_password IS NOT NULL AND u.link_password != '' THEN 1 ELSE 0 END AS has_password, " +
        '(SELECT MAX(created_at) FROM reports r WHERE r.short = u.short AND r.resolved_at IS NULL) AS last_report_at ' +
      'FROM urls u ' + whereSql + ' ' +
      'ORDER BY u.reports DESC, last_report_at DESC NULLS LAST ' +
      'LIMIT ? OFFSET ?',
      [...params, pageSize, offset],
    );

    return res.render('admin/reports', {
      q: qRaw,
      page,
      pageSize,
      total: totalRow ? totalRow.cnt : 0,
      rows,
    });
  });

  router.get('/reports/:short', requireAdmin, async (req, res) => {
    const short = normalizeShortCode(req.params.short);
    if (!short) return res.status(404).render('admin/not-found');
    const url = await loadLink(short);
    if (!url) return res.status(404).render('admin/not-found');

    const reports = await loadReports(short);
    const domain = parseDomain(url.original || '');

    return res.render('admin/report-detail', {
      active: 'reports',
      url,
      reports,
      domain,
    });
  });

  // ==============================
  // Links (all links)
  // ==============================
  router.get('/links', requireAdmin, async (req, res) => {
    const qRaw = (req.query.q || '').toString();
    const q = normalizeSearchQuery(qRaw);

    const status = (req.query.status || '').toString();
    const sort = (req.query.sort || '').toString();

    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const pageSize = 25;
    const offset = (page - 1) * pageSize;

    const where = [];
    const params = [];

    if (q) {
      where.push('(LOWER(u.short) LIKE ? OR LOWER(u.original) LIKE ? OR usr.email_hash = ? OR LOWER(usr.email) LIKE ?)');
      const like = '%' + q.toLowerCase() + '%';
      params.push(like, like, blindIndex(q), like);
    }

    if (status === 'disabled') where.push('u.disabled = 1');
    if (status === 'dangerous') where.push('u.dangerous = 1');
    if (status === 'reported') where.push('u.reports > 0');
    if (status === 'password') where.push("(u.link_password IS NOT NULL AND u.link_password != '')");

    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

    const orderBy = LINKS_SORT_SQL[sort] || LINKS_SORT_SQL.recent;

    const totalRow = await get(
      'SELECT COUNT(*) AS cnt FROM urls u LEFT JOIN users usr ON usr.id = u.user_id ' + whereSql,
      params,
    );

    const rows = await all(
      'SELECT ' +
        'u.id, u.short, u.original, u.created_at, u.reports, u.dangerous, u.disabled, u.disabled_reason, ' +
        "CASE WHEN u.link_password IS NOT NULL AND u.link_password != '' THEN 1 ELSE 0 END AS has_password, " +
        'usr.email AS owner_email, ' +
        '(SELECT COUNT(*) FROM clicks c WHERE c.url_id = u.id) AS clicks_count ' +
      'FROM urls u ' +
      'LEFT JOIN users usr ON usr.id = u.user_id ' +
      whereSql + ' ' +
      'ORDER BY ' + orderBy + ' ' +
      'LIMIT ? OFFSET ?',
      [...params, pageSize, offset],
    );

    (rows || []).forEach((r) => {
      if (r.owner_email) {
        r.owner_email = decryptAES256GCM(r.owner_email);
      }
    });

    return res.render('admin/links', {
      q: qRaw,
      status,
      sort,
      page,
      pageSize,
      total: totalRow ? totalRow.cnt : 0,
      rows,
    });
  });

  router.get('/links/:short', requireAdmin, async (req, res) => {
    const short = normalizeShortCode(req.params.short);
    if (!short) return res.status(404).render('admin/not-found');
    const url = await loadLink(short);
    if (!url) return res.status(404).render('admin/not-found');

    const reports = await loadReports(short);
    const domain = parseDomain(url.original || '');

    return res.render('admin/report-detail', {
      active: 'links',
      url,
      reports,
      domain,
    });
  });

  // ==============================
  // Moderation actions
  // ==============================

  router.post('/links/:short/mark-safe', requireAdmin, async (req, res) => {
    const short = normalizeShortCode(req.params.short);
    const back = safeAdminReturn(req.body.returnTo) || '/admin/reports';
    if (!short) return res.redirect(back);

    try {
      await run('UPDATE urls SET dangerous = 0, reports = 0 WHERE short = ?', [short]);
      await run(
        'UPDATE reports SET resolved_at = ?, resolved_by_admin_id = ? WHERE short = ? AND resolved_at IS NULL',
        [nowIso(), req.session.adminUserId, short],
      );
      await audit(req, 'MARK_SAFE', 'url', short, {});
    } catch (e) {
      console.error('[admin] mark-safe error:', e);
    }

    return res.redirect(back);
  });

  router.post('/links/:short/disable', requireAdmin, async (req, res) => {
    const short = normalizeShortCode(req.params.short);
    const reason = (req.body.reason || '').toString().trim().slice(0, 500);
    const back = safeAdminReturn(req.body.returnTo) || (short ? ('/admin/reports/' + encodeURIComponent(short)) : '/admin/reports');
    if (!short) return res.redirect(back);

    await run(
      'UPDATE urls SET disabled = 1, disabled_reason = ?, disabled_at = ?, disabled_by_admin_id = ? WHERE short = ?',
      [reason, nowIso(), req.session.adminUserId, short],
    );
    await audit(req, 'DISABLE_LINK', 'url', short, { reason });
    await notifyUserDisabledLink(short, reason);
    return res.redirect(back);
  });

  router.post('/links/:short/enable', requireAdmin, async (req, res) => {
    const short = normalizeShortCode(req.params.short);
    const back = safeAdminReturn(req.body.returnTo) || (short ? ('/admin/reports/' + encodeURIComponent(short)) : '/admin/reports');
    if (!short) return res.redirect(back);

    await run(
      'UPDATE urls SET disabled = 0, disabled_reason = NULL, disabled_at = NULL, disabled_by_admin_id = NULL WHERE short = ?',
      [short],
    );
    await audit(req, 'ENABLE_LINK', 'url', short, {});
    return res.redirect(back);
  });

  router.post('/links/:short/delete', requireRole('admin'), async (req, res) => {
    const short = normalizeShortCode(req.params.short);
    const back = safeAdminReturn(req.body.returnTo) || '/admin/reports';
    if (!short) return res.redirect(back);

    const url = await get('SELECT id, original FROM urls WHERE short = ?', [short]);
    if (!url) return res.redirect(back);

    await run('DELETE FROM clicks WHERE url_id = ?', [url.id]);
    await run('DELETE FROM reports WHERE short = ?', [short]);
    await run('DELETE FROM urls WHERE id = ?', [url.id]);

    await audit(req, 'DELETE_LINK', 'url', short, { original: url.original });
    return res.redirect(back);
  });

  // ==============================
  // Domain blocklist
  // ==============================

  router.get('/domains', requireAdmin, async (req, res) => {
    const rows = await all(
      'SELECT b.*, a.email AS created_by_email ' +
      'FROM blocked_domains b ' +
      'LEFT JOIN admin_users a ON a.id = b.created_by_admin_id ' +
      'ORDER BY datetime(b.created_at) DESC',
      [],
    );
    (rows || []).forEach((r) => {
      if (r.created_by_email) {
        r.created_by_email = decryptAES256GCM(r.created_by_email);
      }
    });
    return res.render('admin/domains', { rows });
  });

  router.post('/domains/block', requireRole('admin'), async (req, res) => {
    const domain = (req.body.domain || '').toString().trim().toLowerCase();
    const note = (req.body.note || '').toString().trim().slice(0, 500);

    if (!isValidBlockDomain(domain)) {
      const rows = await all(
        'SELECT b.*, a.email AS created_by_email ' +
        'FROM blocked_domains b ' +
        'LEFT JOIN admin_users a ON a.id = b.created_by_admin_id ' +
        'ORDER BY datetime(b.created_at) DESC',
        [],
      );
      (rows || []).forEach((r) => {
        if (r.created_by_email) {
          r.created_by_email = decryptAES256GCM(r.created_by_email);
        }
      });
      return res.status(400).render('admin/domains', { rows, error: 'Invalid domain.' });
    }

    await run(
      'INSERT OR IGNORE INTO blocked_domains (domain, created_at, created_by_admin_id, note) VALUES (?, ?, ?, ?)',
      [domain, nowIso(), req.session.adminUserId, note],
    );

    await audit(req, 'BLOCK_DOMAIN', 'domain', domain, { note });
    return res.redirect('/admin/domains');
  });

  router.post('/domains/:id/unblock', requireRole('admin'), async (req, res) => {
    const id = parseInt(req.params.id || '0', 10);
    const row = await get('SELECT * FROM blocked_domains WHERE id = ?', [id]);
    if (row) {
      await run('DELETE FROM blocked_domains WHERE id = ?', [id]);
      await audit(req, 'UNBLOCK_DOMAIN', 'domain', row.domain, {});
    }
    return res.redirect('/admin/domains');
  });

  // ==============================
  // Site users (app users)
  // ==============================

  function isBanActiveRow(u) {
    if (!u) return false;
    if (u.banned != 1) return false;
    if (!u.ban_until) return true;
    const untilMs = Date.parse(u.ban_until);
    if (Number.isNaN(untilMs)) return true;
    return untilMs > Date.now();
  }

  router.get('/site-users', requireAdmin, async (req, res) => {
    const qRaw = (req.query.q || '').toString().trim();
    const q = qRaw.toLowerCase();
    const status = (req.query.status || '').toString();
    const sort = (req.query.sort || 'recent').toString();

    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const pageSize = 25;
    const offset = (page - 1) * pageSize;

    const where = [];
    const params = [];

    if (q) {
      where.push('(u.email_hash = ? OR LOWER(u.email) LIKE ?)');
      params.push(blindIndex(q), '%' + q + '%');
    }

    if (status === 'banned') {
      where.push("u.banned = 1 AND (u.ban_until IS NULL OR datetime(u.ban_until) > datetime('now'))");
    } else if (status === 'active') {
      where.push("(u.banned IS NULL OR u.banned != 1 OR (u.ban_until IS NOT NULL AND datetime(u.ban_until) <= datetime('now'))) ");
    } else if (status === 'unverified') {
      where.push('u.email_verified != 1');
    } else if (status === 'pro') {
      where.push("u.plan_tier = 'pro' AND u.plan_status = 'active' AND u.pro_expires_at IS NOT NULL AND datetime(u.pro_expires_at) > datetime('now')");
    } else if (status === 'free') {
      where.push("(u.plan_tier IS NULL OR u.plan_tier = 'free' OR u.plan_status = 'paused' OR u.pro_expires_at IS NULL OR datetime(u.pro_expires_at) <= datetime('now'))");
    }

    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

    const totalRow = await get('SELECT COUNT(*) AS cnt FROM users u ' + whereSql, params);

    const orderBy = SITE_USERS_SORT_SQL[sort] || SITE_USERS_SORT_SQL.recent;

    const rows = await all(
      'SELECT ' +
        'u.id, u.email, u.email_verified, u.created_at, u.last_login_at, u.banned, u.ban_until, u.ban_reason, u.plan_tier, u.plan_status, u.pro_expires_at, ' +
        'COUNT(ul.id) AS link_count, ' +
        'COALESCE(SUM(ul.reports), 0) AS open_reports, ' +
        'COALESCE(SUM(CASE WHEN ul.dangerous = 1 THEN 1 ELSE 0 END), 0) AS dangerous_links, ' +
        'MAX(ul.created_at) AS last_link_at, ' +
        "CASE WHEN u.banned = 1 AND (u.ban_until IS NULL OR datetime(u.ban_until) > datetime('now')) THEN 1 ELSE 0 END AS ban_active " +
      'FROM users u ' +
      'LEFT JOIN urls ul ON ul.user_id = u.id ' +
      whereSql + ' ' +
      'GROUP BY u.id ' +
      'ORDER BY ' + orderBy + ' ' +
      'LIMIT ? OFFSET ?',
      [...params, pageSize, offset],
    );

    rows.forEach(u => {
      if (u.email) {
        u.email = decryptAES256GCM(u.email);
      }
    });
    return res.render('admin/site-users', {
      active: 'site-users',
      q: qRaw,
      status,
      sort,
      page,
      pageSize,
      total: totalRow ? totalRow.cnt : 0,
      rows,
    });
  });

  router.get('/site-users/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id || '0', 10);
    if (!id) return res.status(404).render('admin/not-found');

    const user = await get(
      'SELECT id, email, email_verified, created_at, last_login_at, banned, ban_until, ban_reason, ban_set_at, ban_set_by_admin_id, plan_tier, plan_status, pro_expires_at, pro_paused_at, pro_updated_at ' +
      'FROM users WHERE id = ?',
      [id],
    );
    if (!user) return res.status(404).render('admin/not-found');
    if (user.email) {
      user.email = decryptAES256GCM(user.email);
    }

    // Aggregate stats
    const summary = await get(
      'SELECT ' +
        'COUNT(*) AS link_count, ' +
        'COALESCE(SUM(reports), 0) AS open_reports, ' +
        'COALESCE(SUM(CASE WHEN dangerous = 1 THEN 1 ELSE 0 END), 0) AS dangerous_links ' +
      'FROM urls WHERE user_id = ?',
      [id],
    );

    const clicksRow = await get(
      'SELECT COUNT(*) AS total_clicks ' +
      'FROM clicks c ' +
      'JOIN urls u ON u.id = c.url_id ' +
      'WHERE u.user_id = ?',
      [id],
    );

    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const pageSize = 25;
    const offset = (page - 1) * pageSize;

    const totalLinksRow = await get('SELECT COUNT(*) AS cnt FROM urls WHERE user_id = ?', [id]);

    const links = await all(
      'SELECT ' +
        'u.id, u.short, u.original, u.created_at, u.reports, u.dangerous, u.disabled, u.disabled_reason, u.link_password, ' +
        "CASE WHEN u.link_password IS NOT NULL AND u.link_password != '' THEN 1 ELSE 0 END AS has_password, " +
        '(SELECT COUNT(*) FROM clicks c WHERE c.url_id = u.id) AS clicks_count ' +
      'FROM urls u ' +
      'WHERE u.user_id = ? ' +
      'ORDER BY datetime(u.created_at) DESC ' +
      'LIMIT ? OFFSET ?',
      [id, pageSize, offset],
    );

    const banActive = isBanActiveRow(user);
    const planActive = isProCurrentlyActiveRow(user);
    const apiKeyStats = await get(
      'SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END), 0) AS active FROM api_keys WHERE user_id = ?',
      [id]
    );
    const webhookStats = await get(
      'SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0) AS active FROM webhooks WHERE user_id = ?',
      [id]
    );
    const recentDeliveries = await all(
      'SELECT id, webhook_id, event_type, status, attempt, http_status, created_at, next_retry_at FROM webhook_deliveries WHERE user_id = ? ORDER BY datetime(created_at) DESC LIMIT 10',
      [id]
    );

    return res.render('admin/site-user-detail', {
      active: 'site-users',
      user,
      banActive,
      planActive,
      summary: {
        link_count: summary ? summary.link_count : 0,
        open_reports: summary ? summary.open_reports : 0,
        dangerous_links: summary ? summary.dangerous_links : 0,
        total_clicks: clicksRow ? clicksRow.total_clicks : 0,
      },
      apiKeyStats: {
        total: apiKeyStats ? Number(apiKeyStats.total || 0) : 0,
        active: apiKeyStats ? Number(apiKeyStats.active || 0) : 0,
      },
      webhookStats: {
        total: webhookStats ? Number(webhookStats.total || 0) : 0,
        active: webhookStats ? Number(webhookStats.active || 0) : 0,
      },
      recentDeliveries: recentDeliveries || [],
      links,
      page,
      pageSize,
      totalLinks: totalLinksRow ? totalLinksRow.cnt : 0,
    });
  });

  router.post('/site-users/:id/ban', requireRole('admin'), async (req, res) => {
    const id = parseInt(req.params.id || '0', 10);
    if (!id) return res.redirect('/admin/site-users');

    const mode = (req.body.mode || '').toString();
    const days = parseInt(req.body.days || '0', 10) || 0;
    const reason = (req.body.reason || '').toString().trim().slice(0, 500);

    let until = null;
    let action = 'BAN_USER';

    if (mode === 'temp') {
      const safeDays = Math.min(365, Math.max(1, days || 7));
      until = new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000).toISOString();
      action = 'TEMP_BAN_USER';
    }

    await run(
      'UPDATE users SET banned = 1, ban_until = ?, ban_reason = ?, ban_set_at = ?, ban_set_by_admin_id = ? WHERE id = ?',
      [until, reason || null, nowIso(), req.session.adminUserId, id],
    );

    await audit(req, action, 'user', id, { until, reason });

    return res.redirect('/admin/site-users/' + encodeURIComponent(id));
  });

  router.post('/site-users/:id/unban', requireRole('admin'), async (req, res) => {
    const id = parseInt(req.params.id || '0', 10);
    if (!id) return res.redirect('/admin/site-users');

    await run(
      'UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?',
      [id],
    );

    await audit(req, 'UNBAN_USER', 'user', id, {});
    return res.redirect('/admin/site-users/' + encodeURIComponent(id));
  });

  router.post('/site-users/:id/subscription', requireRole('admin'), async (req, res) => {
    const id = parseInt(req.params.id || '0', 10);
    if (!id) return res.redirect('/admin/site-users');

    const action = (req.body.action || '').toString().trim().toLowerCase();
    const reason = (req.body.reason || '').toString().trim().slice(0, 500);
    const duration = parseDurationSpec(req.body.duration_value, req.body.duration_unit) || parseDurationSpec(30, 'day');
    const now = new Date();
    const nowIsoValue = now.toISOString();
    const nowMs = now.getTime();

    const user = await get(
      'SELECT id, plan_tier, plan_status, pro_expires_at, pro_paused_at FROM users WHERE id = ?',
      [id]
    );
    if (!user) return res.redirect('/admin/site-users');

    const before = { ...user };
    let nextTier = normalizePlanTier(user.plan_tier);
    let nextStatus = normalizePlanStatus(user.plan_status);
    let nextExpires = user.pro_expires_at || null;
    let nextPausedAt = user.pro_paused_at || null;
    let durationSeconds = duration ? duration.seconds : null;

    if (action === 'activate') {
      nextTier = PLAN_TIERS.PRO;
      nextStatus = PLAN_STATUS.ACTIVE;
      nextPausedAt = null;
      nextExpires = applyDurationToDate(now, duration).toISOString();
    } else if (action === 'extend') {
      const baseMs = parseIsoMs(user.pro_expires_at);
      const baseDate = Number.isFinite(baseMs) && baseMs > nowMs ? new Date(baseMs) : now;
      nextTier = PLAN_TIERS.PRO;
      nextStatus = PLAN_STATUS.ACTIVE;
      nextPausedAt = null;
      nextExpires = applyDurationToDate(baseDate, duration).toISOString();
    } else if (action === 'pause') {
      nextTier = PLAN_TIERS.PRO;
      nextStatus = PLAN_STATUS.PAUSED;
      nextPausedAt = user.pro_paused_at || nowIsoValue;
      durationSeconds = null;
    } else if (action === 'resume') {
      nextTier = PLAN_TIERS.PRO;
      nextStatus = PLAN_STATUS.ACTIVE;
      const pausedMs = parseIsoMs(user.pro_paused_at);
      const expiresMs = parseIsoMs(user.pro_expires_at);
      if (Number.isFinite(pausedMs) && Number.isFinite(expiresMs) && expiresMs > 0) {
        const pauseDurationMs = Math.max(0, nowMs - pausedMs);
        nextExpires = new Date(expiresMs + pauseDurationMs).toISOString();
      }
      nextPausedAt = null;
      durationSeconds = null;
    } else {
      // downgrade / revoke
      nextTier = PLAN_TIERS.FREE;
      nextStatus = PLAN_STATUS.ACTIVE;
      nextExpires = null;
      nextPausedAt = null;
      durationSeconds = null;
    }

    await run(
      'UPDATE users SET plan_tier = ?, plan_status = ?, pro_expires_at = ?, pro_paused_at = ?, pro_updated_at = ? WHERE id = ?',
      [nextTier, nextStatus, nextExpires, nextPausedAt, nowIsoValue, id]
    );

    // If user is no longer active-pro, force-disable privileged access surfaces.
    if (!(nextTier === PLAN_TIERS.PRO && nextStatus === PLAN_STATUS.ACTIVE && nextExpires && Date.parse(nextExpires) > nowMs)) {
      await run('UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ? AND revoked_at IS NULL', [nowIsoValue, id]);
      await run('UPDATE webhooks SET is_active = 0, updated_at = ? WHERE user_id = ? AND is_active = 1', [nowIsoValue, id]);
    }

    const after = await get(
      'SELECT id, plan_tier, plan_status, pro_expires_at, pro_paused_at FROM users WHERE id = ?',
      [id]
    );

    await logSubscriptionAudit(req, id, action || 'downgrade', before, after, durationSeconds, reason, {
      mode: action || 'downgrade',
    });
    await audit(req, 'USER_PLAN_UPDATE', 'user', id, {
      action: action || 'downgrade',
      reason,
      before_tier: before.plan_tier || null,
      after_tier: after && after.plan_tier ? after.plan_tier : null,
      before_status: before.plan_status || null,
      after_status: after && after.plan_status ? after.plan_status : null,
      before_expires_at: before.pro_expires_at || null,
      after_expires_at: after && after.pro_expires_at ? after.pro_expires_at : null,
      duration_seconds: durationSeconds,
    });
    await notifyUserSubscriptionChange(id, action || 'downgrade', after, reason);

    return res.redirect('/admin/site-users/' + encodeURIComponent(id));
  });

  router.post('/site-users/:id/api-keys/revoke-all', requireRole('admin'), async (req, res) => {
    const id = parseInt(req.params.id || '0', 10);
    if (!id) return res.redirect('/admin/site-users');
    const now = nowIso();
    const result = await run(
      'UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ? AND revoked_at IS NULL',
      [now, id]
    );
    await audit(req, 'USER_API_KEYS_REVOKE_ALL', 'user', id, { revoked_count: result && result.changes ? result.changes : 0 });
    return res.redirect('/admin/site-users/' + encodeURIComponent(id));
  });

  router.post('/site-users/:id/webhooks/deactivate-all', requireRole('admin'), async (req, res) => {
    const id = parseInt(req.params.id || '0', 10);
    if (!id) return res.redirect('/admin/site-users');
    const now = nowIso();
    const result = await run(
      'UPDATE webhooks SET is_active = 0, updated_at = ? WHERE user_id = ? AND is_active = 1',
      [now, id]
    );
    await audit(req, 'USER_WEBHOOKS_DISABLE_ALL', 'user', id, { disabled_count: result && result.changes ? result.changes : 0 });
    return res.redirect('/admin/site-users/' + encodeURIComponent(id));
  });
  // ==============================
  // Admin users (RBAC)
  // ==============================

  router.get('/users', requireRole('admin'), async (req, res) => {
    const rows = await all('SELECT id, email, role, created_at, last_login_at FROM admin_users ORDER BY datetime(created_at) DESC');
    rows.forEach(u => { try { u.email = decryptAES256GCM(u.email); } catch { u.email = '(unknown)'; } });
    return res.render('admin/users', { rows });
  });

  router.post('/users/create', requireRole('admin'), async (req, res) => {
    const email = (req.body.email || '').toString().trim().toLowerCase();
    const password = (req.body.password || '').toString();
    const role = (req.body.role || '').toString() === 'moderator' ? 'moderator' : 'admin';

    if (!email || !password || password.length < 10) {
      const rows = await all('SELECT id, email, role, created_at, last_login_at FROM admin_users ORDER BY datetime(created_at) DESC');
      rows.forEach(u => { try { u.email = decryptAES256GCM(u.email); } catch { u.email = '(unknown)'; } });
      return res.status(400).render('admin/users', { rows, error: 'Email and password (min 10 chars) are required.' });
    }

    const hash = await bcrypt.hash(password, 12);

    try {
      await run('INSERT INTO admin_users (email, email_hash, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)', [encryptAES256GCM(email), blindIndex(email), hash, role, nowIso()]);
      await audit(req, 'CREATE_ADMIN_USER', 'admin_user', email, { role });
    } catch {
      const rows = await all('SELECT id, email, role, created_at, last_login_at FROM admin_users ORDER BY datetime(created_at) DESC');
      rows.forEach(u => { try { u.email = decryptAES256GCM(u.email); } catch { u.email = '(unknown)'; } });
      return res.status(400).render('admin/users', { rows, error: 'User could not be created (email may already be in use).' });
    }

    return res.redirect('/admin/users');
  });

  // ==============================
  // Settings
  // ==============================

  async function loadSiteSettings() {
    const settings = {
      maintenance_enabled: '0',
      maintenance_message_az: '',
      maintenance_message_tr: '',
      maintenance_message_en: '',
      announcement_enabled: '0',
      announcement_text_az: '',
      announcement_text_tr: '',
      announcement_text_en: '',
    };
    try {
      const rows = await all('SELECT key, value FROM site_settings');
      (rows || []).forEach((r) => {
        if (r && r.key) settings[r.key] = r.value;
      });
    } catch (err) {
      console.error('[admin] loadSiteSettings failed:', err);
    }
    return settings;
  }

  router.get('/settings', requireRole('admin'), async (req, res) => {
    const settings = await loadSiteSettings();
    const viewData = {
      active: 'settings',
      settings,
      saved: req.query.saved === '1',
      error: null,
    };
    return res.render('admin/settings', viewData, (err, html) => {
      if (err) {
        console.error('[admin] settings render error:', err);
        return res.status(500).send('Server error.');
      }
      return res.send(html);
    });
  });

  router.post('/settings', requireRole('admin'), async (req, res) => {
    const payload = {
      maintenance_enabled: req.body.maintenance_enabled === '1' ? '1' : '0',
      maintenance_message_az: (req.body.maintenance_message_az || '').toString().trim().slice(0, 1000),
      maintenance_message_tr: (req.body.maintenance_message_tr || '').toString().trim().slice(0, 1000),
      maintenance_message_en: (req.body.maintenance_message_en || '').toString().trim().slice(0, 1000),
      announcement_enabled: req.body.announcement_enabled === '1' ? '1' : '0',
      announcement_text_az: (req.body.announcement_text_az || '').toString().trim().slice(0, 1000),
      announcement_text_tr: (req.body.announcement_text_tr || '').toString().trim().slice(0, 1000),
      announcement_text_en: (req.body.announcement_text_en || '').toString().trim().slice(0, 1000),
    };

    try {
      for (const [key, value] of Object.entries(payload)) {
        await run('INSERT OR REPLACE INTO site_settings (key, value) VALUES (?, ?)', [key, value]);
      }

      const target = global.__siteSettings || {};
      Object.assign(target, payload);
      global.__siteSettings = target;

      await audit(req, 'UPDATE_SITE_SETTINGS', 'site_settings', 'global', {
        maintenance_enabled: payload.maintenance_enabled,
        announcement_enabled: payload.announcement_enabled,
      });

      return res.redirect('/admin/settings?saved=1');
    } catch (err) {
      console.error('[admin] settings update failed:', err);
      return res.status(500).render('admin/settings', {
        active: 'settings',
        settings: payload,
        error: 'Settings could not be saved.',
        saved: false,
      });
    }
  });


  router.get('/2fa/setup', requireAdmin, async (req, res) => {
    try {
      const adminRow = await get('SELECT id, totp_enabled FROM admin_users WHERE id = ?', [req.session.adminUserId]);
      if (!adminRow) return res.status(404).render('admin/not-found');

      if (Number(adminRow.totp_enabled) === 1) {
        return res.render('admin/2fa-setup', {
          active: 'settings',
          qrDataUrl: null,
          secret: null,
          error: null,
          success: '2FA is already enabled.',
          enabled: true,
        });
      }

      const secret = speakeasy.generateSecret({ name: 'Ovlink Admin' });
      req.session.pendingTotpSecret = secret.base32;
      const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);

      return res.render('admin/2fa-setup', {
        active: 'settings',
        qrDataUrl,
        secret: secret.base32,
        error: null,
        success: req.query.ok ? '2FA enabled successfully.' : null,
        enabled: false,
      });
    } catch (e) {
      console.error('[admin] 2fa setup get error:', e);
      return res.status(500).render('admin/2fa-setup', {
        active: 'settings',
        qrDataUrl: null,
        secret: null,
        error: '2FA setup could not be opened.',
        success: null,
        enabled: false,
      });
    }
  });

  router.post('/2fa/setup', requireAdmin, async (req, res) => {
    const token = (req.body.token || '').toString().replace(/\s+/g, '');
    const secret = (req.session.pendingTotpSecret || '').toString();

    if (!secret) return res.redirect('/admin/2fa/setup');
    if (!/^\d{6}$/.test(token)) {
      return res.status(400).render('admin/2fa-setup', {
        active: 'settings',
        qrDataUrl: null,
        secret,
        error: 'Code must be 6 digits.',
        success: null,
        enabled: false,
      });
    }

    try {
      const ok = speakeasy.totp.verify({
        secret,
        encoding: 'base32',
        token,
        window: 1,
      });

      if (!ok) {
        return res.status(401).render('admin/2fa-setup', {
          active: 'settings',
          qrDataUrl: null,
          secret,
          error: 'Invalid code.',
          success: null,
          enabled: false,
        });
      }

      await run('UPDATE admin_users SET totp_enabled = 1, totp_secret = ? WHERE id = ?', [encryptAES256GCM(secret), req.session.adminUserId]);
      await audit(req, 'ADMIN_2FA_ENABLED', 'admin_user', String(req.session.adminUserId), {});
      delete req.session.pendingTotpSecret;
      return res.redirect('/admin/2fa/setup?ok=1');
    } catch (e) {
      console.error('[admin] 2fa setup post error:', e);
      return res.status(500).render('admin/2fa-setup', {
        active: 'settings',
        qrDataUrl: null,
        secret,
        error: '2FA could not be saved.',
        success: null,
        enabled: false,
      });
    }
  });
  // ==============================
  // Audit
  // ==============================


  // Polar billing webhook history: every processed event with its outcome.
  router.get('/billing', requireRole('admin'), async (req, res) => {
    try {
      const rows = await all(
        'SELECT id, webhook_id, event_type, product_id, user_id, outcome, detail, created_at FROM polar_events ORDER BY datetime(created_at) DESC, id DESC LIMIT 200'
      );
      return res.render('admin/billing', {
        admin: res.locals.admin,
        csrfToken: res.locals._csrf,
        rows,
        error: null,
      });
    } catch {
      return res.render('admin/billing', {
        admin: res.locals.admin,
        csrfToken: res.locals._csrf,
        rows: [],
        error: 'Could not load billing events.',
      });
    }
  });

  router.get('/auth-logs', requireRole('admin'), async (req, res) => {    try {
      const rowsRaw = await all('SELECT * FROM admin_auth_audit ORDER BY datetime(created_at) DESC LIMIT 200');
      const rows = (rowsRaw || []).map((row) => {
        const explicitCountry = (row && row.country && row.country.toString().trim() === 'Local Dev')
          ? 'Local Dev'
          : normalizeCountryCode(row && row.country);
        return {
          ...row,
          country_display: explicitCountry || getCountryCodeFromIp(row && row.ip_address),
        };
      });
      return res.render('admin/auth-logs', {
        admin: res.locals.admin,
        csrfToken: res.locals._csrf,
        rows,
        error: null,
      });
    } catch {
      return res.status(500).render('admin/auth-logs', {
        admin: res.locals.admin,
        csrfToken: res.locals._csrf,
        rows: [],
        error: 'Server error.'
      });
    }
  });

  router.get('/audit', requireAdmin, async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const pageSize = 50;
    const offset = (page - 1) * pageSize;

    const totalRow = await get('SELECT COUNT(*) AS cnt FROM admin_audit_log');
    const rowsRaw = await all(
      'SELECT l.*, a.email AS admin_email ' +
      'FROM admin_audit_log l ' +
      'LEFT JOIN admin_users a ON a.id = l.admin_user_id ' +
      'ORDER BY datetime(l.created_at) DESC ' +
      'LIMIT ? OFFSET ?',
      [pageSize, offset],
    );
    const rows = (rowsRaw || []).map((row) => {
      let meta = {};
      try {
        meta = JSON.parse(row.metadata_json || '{}') || {};
      } catch {}
      const explicitCountry = (meta && meta.country && meta.country.toString().trim() === 'Local Dev')
        ? 'Local Dev'
        : normalizeCountryCode(meta && meta.country);
      return {
        ...row,
        admin_email: row.admin_email ? decryptAES256GCM(row.admin_email) : '',
        country_display: explicitCountry || getCountryCodeFromIp(row && row.ip),
      };
    });

    return res.render('admin/audit', { rows, page, pageSize, total: totalRow ? totalRow.cnt : 0 });
  });

  // ==============================
  // IP Blacklist Yönetimi (DDoS Koruması)
  // ==============================
  if (blockIpFn && unblockIpFn && getBlockedIpsFn) {
    router.get('/ip-blocklist', requireRole('admin'), (req, res) => {
      const blockedIps = getBlockedIpsFn();
      return res.render('admin/ip-blocklist', {
        admin: res.locals.admin,
        csrfToken: res.locals._csrf,
        rows: Array.isArray(blockedIps) ? blockedIps : [],
        error: null,
      });
    });

    router.post('/ip-blocklist/block', requireRole('admin'), async (req, res) => {
      const ip = (req.body.ip || '').toString().trim();
      const durationMinutes = parseInt(req.body.duration || '0', 10);
      const reason = (req.body.reason || 'abuse').toString().trim().slice(0, 200);

      if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) && !/^[a-fA-F0-9:]+$/.test(ip)) {
        return res.status(400).json({ error: 'Geçersiz IP adresi.' });
      }

      const durationMs = durationMinutes > 0 ? durationMinutes * 60 * 1000 : null;
      blockIpFn(ip, durationMs, reason);
      await audit(req, 'IP_BLOCKED', 'ip', ip, { durationMinutes, reason });

      return res.json({ success: true, ip, durationMinutes, reason });
    });

    router.post('/ip-blocklist/unblock', requireRole('admin'), async (req, res) => {
      const ip = (req.body.ip || '').toString().trim();
      if (!ip) return res.status(400).json({ error: 'IP gerekli.' });

      unblockIpFn(ip);
      await audit(req, 'IP_UNBLOCKED', 'ip', ip, {});

      return res.json({ success: true, ip });
    });

    router.get('/ip-blocklist.json', requireRole('admin'), (req, res) => {
      return res.json({ blocked: getBlockedIpsFn() });
    });
  }

  router.use((req, res) => {
    res.status(404).render('admin/not-found');
  });

  return router;
};
