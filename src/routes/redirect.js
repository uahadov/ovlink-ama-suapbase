const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const tsscmp = require('tsscmp');

const { db } = require('../db/index');
const { dbGetAsync, dbRunAsync } = require('../db/helpers');
const {
  ensureAbsoluteUrl,
  normalizeShortCode,
  buildAbsoluteUrlForHost
} = require('../lib/url-helpers');
const {
  getRedirectConsentModeForRequest,
  clearRedirectConsentSession,
  buildRedirectConsentSignature,
  REDIRECT_CONSENT_MODES,
  normalizeConsentNext,
  getRedirectConsentMode,
  getConsentResumePath,
  clearRedirectConsentMode,
  setRedirectConsentSession,
  setRedirectConsentMode,
  buildRedirectConfirmToken,
  isRedirectConfirmTokenValid
} = require('../lib/consent');
const { recordClickSafe } = require('../lib/analytics');
const { createUserNotification } = require('../lib/notifications');
const { sensitiveActionLimiter } = require('../middleware/rate-limiter');
const { getRequestHostName, getShortHostAccess } = require('../lib/custom-domain');
const { normalizeLang, pickLang } = require('../lib/i18n');
const { buildSeo } = require('../lib/seo');
const { isIsoTimeExpired } = require('../lib/plans');

function isBcryptHash(value) {
  const text = (value || '').toString();
  return /^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(text);
}

async function bcryptHash(password, saltRounds = 12) {
  return new Promise((resolve, reject) => {
    bcrypt.hash(password, saltRounds, (err, hash) => {
      if (err) return reject(err);
      resolve(hash);
    });
  });
}

async function bcryptCompare(password, hashed) {
  return new Promise((resolve, reject) => {
    bcrypt.compare(password, hashed, (err, ok) => {
      if (err) return reject(err);
      resolve(ok);
    });
  });
}

async function hashLinkPassword(plain) {
  return bcryptHash(plain, 12);
}

async function verifyLinkPassword(hashed, plain) {
  if (!hashed || !plain) return false;
  if (!isBcryptHash(hashed)) {
    return tsscmp(String(plain), String(hashed));
  }
  return bcryptCompare(plain, hashed);
}

function getEssentialAnalyticsValue(raw) {
  const v = (raw || '').toString().trim();
  if (!v) return 'Unknown';
  return v;
}

function send404(res) {
  const req = (res && res.req) ? res.req : null;
  const pathValue = req ? ((req.originalUrl || req.path || '/404').toString()) : '/404';
  const seo = req
    ? buildSeo(req, {
      path: pathValue,
      titleAz: 'Link tapılmadı - Ovlink',
      titleTr: 'Link bulunamadı - Ovlink',
      titleEn: 'Link not found - Ovlink',
      descAz: 'Axtardığınız link mövcud deyil, silinib və ya açıq deyil.',
      descTr: 'Aradığınız link mevcut değil, silinmiş ya da erişime kapalı.',
      descEn: 'The link you requested does not exist, was removed, or is unavailable.'
    })
    : {
      lang: 'en',
      title: 'Link not found - Ovlink',
      description: 'The link you requested does not exist, was removed, or is unavailable.',
      canonical: '',
      hreflangEn: '',
      hreflangAz: '',
      hreflangTr: '',
      hreflangXDefault: '',
      jsonLd: ''
    };

  seo.jsonLd = '';
  res.set('X-Robots-Tag', 'noindex,nofollow');
  return res.status(404).render('404', { csrfToken: res.locals._csrf, seo });
}

// Kept as a thin, side-effect-free recorder for call sites/tests that only need
// "a click happened": all attribution lives in src/lib/analytics.js.
function recordClickEvent(req, row, consentMode, resolvedTarget) {
  void recordClickSafe({ row, req, consentMode, context: resolvedTarget });
}

/**
 * Resolves the destination AND tells us which branch served it, so the click can
 * be attributed to the A/B variant. `resolveFinalRedirectUrl` stays as the
 * URL-only wrapper for compatibility.
 */
function resolveFinalRedirectTarget(req, row) {
  if (!row) return null;
  let finalTargetUrl = row.original;
  let variant = null;
  const userAgent = ((req && req.headers && req.headers['user-agent']) || '').toLowerCase();

  // Cihaz Hədəfləmə Öncəliyi
  if (row.ios_url && /iphone|ipad|ipod/.test(userAgent)) {
    finalTargetUrl = row.ios_url;
  } else if (row.android_url && /android/.test(userAgent)) {
    finalTargetUrl = row.android_url;
  } else if (row.original_b) {
    const splitPercent = (row.ab_split_percent !== null && row.ab_split_percent !== undefined && !Number.isNaN(Number(row.ab_split_percent)))
      ? Number(row.ab_split_percent)
      : 50;
    const rand = Math.random() * 100;
    if (rand >= splitPercent) {
      finalTargetUrl = row.original_b;
      variant = 'b';
    } else {
      variant = 'a';
    }
  }

  return { url: ensureAbsoluteUrl(finalTargetUrl), variant };
}

function resolveFinalRedirectUrl(req, row) {
  const resolved = resolveFinalRedirectTarget(req, row);
  return resolved ? resolved.url : null;
}

// ---------------------------------------------------------------------------
// Delivery gates
// Every public entry point that can hand a visitor to the destination
// (/:short, /proceed/:short) must run the exact same checks. Keeping them in
// one place is what prevents per-route bypasses of admin takedowns, expiry,
// click limits and the domain blocklist.
// ---------------------------------------------------------------------------
function getDestinationHostname(rawUrl) {
  const absolute = ensureAbsoluteUrl(rawUrl);
  if (!absolute) return '';
  try {
    return new URL(absolute).hostname.toLowerCase();
  } catch {
    return '';
  }
}

async function isBlockedDestinationHost(hostname) {
  const host = (hostname || '').toString().trim().toLowerCase();
  if (!host) return false;
  const row = await dbGetAsync(
    "SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1",
    [host, host]
  ).catch(() => null);
  return !!(row && row.domain);
}

function buildDangerConfirmUrl(short, pathPrefix = '/') {
  const base = `${pathPrefix}${encodeURIComponent((short || '').toString())}`;
  const token = buildRedirectConfirmToken(short);
  return token ? `${base}?confirm=${encodeURIComponent(token)}` : base;
}

/**
 * Applies every delivery gate for a short link.
 * Returns true when the request has already been answered (blocked or warning
 * page rendered) and false when the link may be delivered.
 */
async function applyDeliveryGates(req, res, row, targetUrl, options = {}) {
  if (row.disabled == 1) {
    res.status(410).render('error-disabled', { csrfToken: res.locals._csrf, reason: row.disabled_reason || '' });
    return true;
  }

  if (isIsoTimeExpired(row.expires_at)) {
    res.status(410).render('error-expired', { csrfToken: res.locals._csrf });
    return true;
  }

  const destinationHost = getDestinationHostname(targetUrl);
  if (destinationHost && await isBlockedDestinationHost(destinationHost)) {
    res.status(451).render('error-blocked', { csrfToken: res.locals._csrf });
    return true;
  }

  if (row.max_clicks && Number(row.max_clicks) > 0) {
    const counted = await dbGetAsync('SELECT COUNT(*) AS count FROM clicks WHERE url_id = ?', [row.id]).catch(() => null);
    if (counted && Number(counted.count) >= Number(row.max_clicks)) {
      if (options.notifyOnLimit && row.user_id) {
        createUserNotification(db, row.user_id, 'limit', {
          titleAz: 'Klik limiti doldu',
          titleTr: 'Tıklama limiti doldu',
          titleEn: 'Click limit reached',
          bodyAz: `Qısa link: ${row.short}. Maksimum klik limiti bitdi.`,
          bodyTr: `Kısa link: ${row.short}. Maksimum tıklama limiti doldu.`,
          bodyEn: `Short link: ${row.short}. Maximum click limit reached.`,
          linkShort: row.short,
          eventKey: `limit_${row.short}`,
        });
      }
      res.status(410).render('error-max-clicks', { csrfToken: res.locals._csrf });
      return true;
    }
  }

  const isDangerous = row.dangerous == 1 || (row.reports && Number(row.reports) >= 4);
  if (isDangerous && !options.skipDangerWarning) {
    const providedToken = req && req.query ? req.query.confirm : '';
    if (!isRedirectConfirmTokenValid(row.short, providedToken)) {
      res.status(200).render('error-warning', {
        csrfToken: res.locals._csrf,
        short: row.short,
        confirmUrl: buildDangerConfirmUrl(row.short, options.confirmPathPrefix || '/'),
      });
      return true;
    }
  }

  return false;
}

// Mərkəzləşdirilmiş Yönləndirmə Məntiqi
async function handleRedirection(req, res, row, passwordVerified = false) {
  const short = row.short;
  const consentState = getRedirectConsentModeForRequest(req, short, 'redirect');
  const consentMode = consentState.mode;

  if (!consentMode) {
    return res.redirect(302, `/consent/redirect/${encodeURIComponent(short)}`);
  }

  try {
    const resolvedTarget = resolveFinalRedirectTarget(req, row);
    const targetUrl = resolvedTarget ? resolvedTarget.url : '';

    // 1. Şifrə tələb olunan linklər: əvvəlcə bütün geytlər, sonra şifrə formu.
    if (row.link_password && !passwordVerified) {
      if (!targetUrl) return send404(res);
      if (await applyDeliveryGates(req, res, row, targetUrl, { skipDangerWarning: true, notifyOnLimit: true })) return undefined;
      return res.redirect(`/proceed/${encodeURIComponent(short)}`);
    }

    if (!targetUrl) return send404(res);

    // 2. Moderation / expiry / blocklist / limit / danger warning
    if (await applyDeliveryGates(req, res, row, targetUrl, { notifyOnLimit: true })) return undefined;

    // 3. Tracking (yalnız yönləndirmə həqiqətən baş verəndə qeyd olunur)
    recordClickEvent(req, row, consentMode, resolvedTarget);
    return res.redirect(targetUrl);
  } catch (err) {
    console.error('[redirect] delivery failed:', err && (err.message || err));
    if (!res.headersSent) return res.status(500).send('Server error.');
    return undefined;
  }
}

router.get('/consent/redirect/:short', (req, res) => {
  const short = normalizeShortCode(req.params.short);
  if (!short) return send404(res);

  const nextAction = normalizeConsentNext(req.query.next);
  const consentView = ((req.query.view || '').toString().trim().toLowerCase() === 'declined') ? 'declined' : 'decision';

  const currentMode = getRedirectConsentMode(req);
  if (currentMode && consentView !== 'declined') {
    return res.redirect(303, getConsentResumePath(short, nextAction));
  }

  db.get('SELECT short, original, disabled, disabled_reason, domain_host FROM urls WHERE short = ?', [short], (err, row) => {
    if (err) return res.status(500).send('Server error.');
    if (!row) return send404(res);

    const reqHost = getRequestHostName(req);
    const hostAccess = getShortHostAccess(row, reqHost);
    if (!hostAccess.allowed) {
      if (hostAccess.redirectHost) {
        const query = new URLSearchParams({ next: nextAction });
        if (consentView === 'declined') query.set('view', 'declined');
        const redirectPath = '/consent/redirect/' + encodeURIComponent(short) + '?' + query.toString();
        const redirectUrl = buildAbsoluteUrlForHost(req, hostAccess.redirectHost, redirectPath);
        return res.redirect(302, redirectUrl);
      }
      return send404(res);
    }

    if (row.disabled == 1) {
      return res.status(410).render('error-disabled', { csrfToken: res.locals._csrf, reason: row.disabled_reason || '' });
    }

    const originalAbs = ensureAbsoluteUrl(row.original);
    if (!originalAbs) return send404(res);

    let targetHost = '';
    try {
      targetHost = new URL(originalAbs).hostname || '';
    } catch {
      targetHost = '';
    }

    const readyAt = Date.now() + REDIRECT_CONSENT_COUNTDOWN_MS;
    const readySig = consentView === 'decision'
      ? buildRedirectConsentSignature(short, nextAction, readyAt)
      : '';

    return res.render('redirect-consent', {
      csrfToken: res.locals._csrf,
      shortCode: short,
      nextAction,
      targetHost: targetHost || pickLang(req.defaultLang || 'az', 'naməlum', 'bilinmiyor', 'unknown'),
      consentView,
      tooEarly: req.query.too_early === '1',
      countdownReadyAt: readyAt,
      countdownReadySig: readySig,
      countdownDurationMs: REDIRECT_CONSENT_COUNTDOWN_MS,
    });
  });
});

router.post('/consent/redirect/:short', sensitiveActionLimiter, (req, res) => {
  const short = normalizeShortCode(req.params.short);
  if (!short) return send404(res);

  const nextAction = normalizeConsentNext(req.body && req.body.next);
  const decision = ((req.body && req.body.decision) || '').toString().trim().toLowerCase();

  if (decision === 'no') {
    clearRedirectConsentSession(req);
    clearRedirectConsentMode(res);
    const q = new URLSearchParams({ next: nextAction, view: 'declined' }).toString();
    const target = `/consent/redirect/${encodeURIComponent(short)}?${q}`;
    if (req.session) {
      return req.session.save(() => res.redirect(303, target));
    }
    return res.redirect(303, target);
  }

  if (decision !== 'continue') {
    const q = new URLSearchParams({ next: nextAction }).toString();
    const target = `/consent/redirect/${encodeURIComponent(short)}?${q}`;
    if (req.session) {
      return req.session.save(() => res.redirect(303, target));
    }
    return res.redirect(303, target);
  }

  // Countdown removed — no timestamp/signature validation needed

  db.get('SELECT id, domain_host FROM urls WHERE short = ?', [short], (err, row) => {
    if (err) return res.status(500).send('Server error.');
    if (!row) return send404(res);

    const reqHost = getRequestHostName(req);
    const hostAccess = getShortHostAccess(row, reqHost);
    if (!hostAccess.allowed) {
      if (hostAccess.redirectHost) {
        const redirectPath = '/consent/redirect/' + encodeURIComponent(short) + '?' + new URLSearchParams({ next: nextAction }).toString();
        const redirectUrl = buildAbsoluteUrlForHost(req, hostAccess.redirectHost, redirectPath);
        return res.redirect(302, redirectUrl);
      }
      return send404(res);
    }

    setRedirectConsentSession(req, short, nextAction, REDIRECT_CONSENT_MODES.ANALYTICS);
    setRedirectConsentMode(res, REDIRECT_CONSENT_MODES.ANALYTICS);
    
    const target = getConsentResumePath(short, nextAction);
    if (req.session) {
      return req.session.save(() => res.redirect(303, target));
    }
    return res.redirect(303, target);
  });
});

router.get(/^\/AGENTS(\.md)?$/i, (_req, res) => {
  return res.status(404).type('text/plain').send('Not found.');
});

// Yönlendirme (GET /:short)
router.get('/:short', async (req, res, next) => {
  const rawShort = (req.params.short || '').toString();
  // These app pages live below this resolver in route order; pass them through.
  if (rawShort === 'dashboard' || rawShort === 'workspaces')
    return next();

  const short = normalizeShortCode(rawShort);
  if (!short) return send404(res);

  let row;
  try {
    row = await dbGetAsync('SELECT * FROM urls WHERE short = ?', [short]);
  } catch {
    return res.status(500).send('Server error.');
  }
  if (!row) return send404(res);

  const reqHost = getRequestHostName(req);
  const hostAccess = getShortHostAccess(row, reqHost);
  if (!hostAccess.allowed) {
    if (hostAccess.redirectHost) {
      const redirectUrl = buildAbsoluteUrlForHost(req, hostAccess.redirectHost, '/' + encodeURIComponent(short));
      return res.redirect(302, redirectUrl);
    }
    return send404(res);
  }

  // All moderation/expiry/blocklist/limit checks happen inside handleRedirection
  // so that no entry point can skip them.
  return handleRedirection(req, res, row);
});

// Şifre korumalı linkler için (GET /proceed/:short)
router.get('/proceed/:short', async (req, res) => {
  const short = normalizeShortCode(req.params.short);
  if (!short) return send404(res);

  let row;
  try {
    row = await dbGetAsync('SELECT * FROM urls WHERE short = ?', [short]);
  } catch {
    return res.status(500).send('Server error.');
  }
  if (!row) return send404(res);

  const reqHost = getRequestHostName(req);
  const hostAccess = getShortHostAccess(row, reqHost);
  if (!hostAccess.allowed) {
    if (hostAccess.redirectHost) {
      const redirectUrl = buildAbsoluteUrlForHost(req, hostAccess.redirectHost, '/proceed/' + encodeURIComponent(short));
      return res.redirect(302, redirectUrl);
    }
    return send404(res);
  }

  const consentState = getRedirectConsentModeForRequest(req, short, 'proceed');
  const consentMode = consentState.mode;
  if (!consentMode) {
    const q = new URLSearchParams({ next: 'proceed' }).toString();
    return res.redirect(303, `/consent/redirect/${encodeURIComponent(short)}?${q}`);
  }

  const requiresPassword = !!row.link_password;
  const resolvedTarget = resolveFinalRedirectTarget(req, row);
  const targetUrl = resolvedTarget ? resolvedTarget.url : '';
  if (!targetUrl) return send404(res);

  // Same gates as GET /:short — disabled, expiry, blocked destination, click
  // limit and the dangerous-link interstitial can no longer be skipped by
  // calling /proceed directly.
  if (await applyDeliveryGates(req, res, row, targetUrl, {
    skipDangerWarning: requiresPassword,
    confirmPathPrefix: '/proceed/',
    notifyOnLimit: true,
  })) return undefined;

  if (requiresPassword) {
    const seo = buildSeo(req, {
      path: `/proceed/${encodeURIComponent(short)}`,
      titleAz: 'Şifrə tələb olunur - Ovlink',
      titleTr: 'Şifre gerekli - Ovlink',
      titleEn: 'Password required - Ovlink',
      descAz: 'Bu qısa link şifrə ilə qorunur. Davam etmək üçün şifrəni daxil edin.',
      descTr: 'Bu kısa link şifre ile korunuyor. Devam etmek için şifre girin.',
      descEn: 'This short link is password-protected. Enter the password to continue.'
    });
    seo.jsonLd = '';
    return res.render('proceed', {
      csrfToken: res.locals._csrf,
      shortPath: encodeURIComponent((short || '').toString()),
      seo,
    });
  }

  recordClickEvent(req, row, consentMode, resolvedTarget);
  if (consentState.source === 'session') {
    clearRedirectConsentSession(req);
  }
  return res.redirect(targetUrl);
});

// Şifre doğrulama (POST /verify/:short)
router.post('/verify/:short', sensitiveActionLimiter, (req, res) => {
  const short = normalizeShortCode(req.params.short);
  const password = (req.body.password || '').toString();
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  if (!short) return res.status(400).json({ error: pickLang(uiLang, 'Yanlış qısa kod.', 'Geçersiz kısa kod.', 'Invalid short code.') });

  db.get('SELECT * FROM urls WHERE short = ?', [short], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: pickLang(uiLang, 'Link tapılmadı.', 'Link bulunamadı.', 'Link not found.') });
    }

    const reqHost = getRequestHostName(req);
    const hostAccess = getShortHostAccess(row, reqHost);
    if (!hostAccess.allowed) {
      return res.status(403).json({
        error: pickLang(uiLang, 'Bu link bu domen üzərindən açıla bilməz.', 'Bu link bu alan adı üzerinden açılamaz.', 'This link cannot be opened on this domain.')
      });
    }

    // Enforce admin moderation here too (avoid bypass via /proceed + /verify)
    if (row.disabled == 1) {
      return res.status(410).json({ error: pickLang(uiLang, 'Link deaktiv edilib.', 'Link devre dışı.', 'Link disabled.') });
    }

    const resolvedTarget = resolveFinalRedirectTarget(req, row);
    const targetUrl = resolvedTarget ? resolvedTarget.url : '';
    if (!targetUrl) {
      return res.status(400).json({ error: pickLang(uiLang, 'Yanlış link.', 'Geçersiz link.', 'Invalid link.') });
    }
    let hostname = '';
    try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { hostname = ''; }

    const checkBlockedDomain = (cb) => {
      if (!hostname) return cb(false);
      db.get(
        "SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1",
        [hostname, hostname],
        (blockErr, blockedRow) => cb(!!blockedRow)
      );
    };

    checkBlockedDomain((isBlocked) => {
      if (isBlocked) {
        return res.status(451).json({
          error: pickLang(uiLang, 'Bu domen bloklanıb.', 'Bu alan adı engellenmiştir.', 'This domain is blocked.')
        });
      }

      // Expiry check
      if (isIsoTimeExpired(row.expires_at)) {
        return res.status(410).json({
          error: pickLang(uiLang, 'Bu linkin vaxtı bitib.', 'Bu linkin süresi doldu.', 'This link has expired.')
        });
      }

      // Max clicks check
      db.get('SELECT COUNT(*) as count FROM clicks WHERE url_id = ?', [row.id], async (countErr, result) => {
        const current = result ? (result.count || 0) : 0;
        if (row.max_clicks && current >= row.max_clicks) {
          return res.status(410).json({
            error: pickLang(uiLang, 'Bu link limitə çatıb.', 'Bu link maksimum tıklama limitine ulaştı.', 'This link has reached its click limit.')
          });
        }

        if (await verifyLinkPassword(row.link_password, password)) {
          if (!isBcryptHash(row.link_password)) {
            const migratedHash = await hashLinkPassword(password);
            if (migratedHash) {
              db.run('UPDATE urls SET link_password = ? WHERE id = ?', [migratedHash, row.id], () => {});
            }
          }
          // Tıklama kaydı ekle
          const consentState = getRedirectConsentModeForRequest(req, short, 'verify');
          recordClickEvent(req, row, consentState.mode || 'essential', resolvedTarget);

          return res.json({ success: true, redirect: targetUrl });
        }

        return res.status(401).json({ error: pickLang(uiLang, 'Yanlış şifrə.', 'Yanlış şifre.', 'Incorrect password.') });
      });
    });
  });
});

router.resolveFinalRedirectUrl = resolveFinalRedirectUrl;
router.resolveFinalRedirectTarget = resolveFinalRedirectTarget;
router.recordClickEvent = recordClickEvent;
router.hashLinkPassword = hashLinkPassword;
router.verifyLinkPassword = verifyLinkPassword;
router.getEssentialAnalyticsValue = getEssentialAnalyticsValue;
router.applyDeliveryGates = applyDeliveryGates;
router.isBlockedDestinationHost = isBlockedDestinationHost;
router.getDestinationHostname = getDestinationHostname;
router.buildDangerConfirmUrl = buildDangerConfirmUrl;

module.exports = router;
module.exports.resolveFinalRedirectUrl = resolveFinalRedirectUrl;
module.exports.resolveFinalRedirectTarget = resolveFinalRedirectTarget;
module.exports.recordClickEvent = recordClickEvent;
module.exports.hashLinkPassword = hashLinkPassword;
module.exports.verifyLinkPassword = verifyLinkPassword;
module.exports.getEssentialAnalyticsValue = getEssentialAnalyticsValue;
module.exports.applyDeliveryGates = applyDeliveryGates;
module.exports.isBlockedDestinationHost = isBlockedDestinationHost;
module.exports.getDestinationHostname = getDestinationHostname;
module.exports.buildDangerConfirmUrl = buildDangerConfirmUrl;
