const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');

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
  normalizeConsentMode,
  buildRedirectConsentSignature,
  REDIRECT_CONSENT_MODES,
  REDIRECT_CONSENT_MARKER
} = require('../lib/consent');
const { getRequestGeoMeta } = require('../lib/geo');
const { createUserNotification } = require('../lib/notifications');
const { enqueueWebhookEventForUser } = require('../lib/webhook');
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
  if (!hashed) return false;
  return bcryptCompare(plain, hashed);
}

function getEssentialAnalyticsValue(raw) {
  const v = (raw || '').toString().trim();
  if (!v) return 'Unknown';
  return v;
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

function recordClickEvent(req, row, consentMode) {
  const clickTime = new Date().toISOString();
  const mode = normalizeConsentMode(consentMode);

  if (mode === REDIRECT_CONSENT_MODES.ESSENTIAL) {
    db.run(
      'INSERT INTO clicks (url_id, click_time, browser, os, country) VALUES (?, ?, ?, ?, ?)',
      [row.id, clickTime, REDIRECT_CONSENT_MARKER, REDIRECT_CONSENT_MARKER, REDIRECT_CONSENT_MARKER]
    );
    return;
  }

  const geoMeta = getRequestGeoMeta(req);
  const agent = parseUserAgentInfo(req.headers['user-agent']);
  const osDisplay = agent.os;

  db.run(
    'INSERT INTO clicks (url_id, click_time, browser, os, country) VALUES (?, ?, ?, ?, ?)',
    [row.id, clickTime, getEssentialAnalyticsValue(agent.browser), getEssentialAnalyticsValue(osDisplay), getEssentialAnalyticsValue(geoMeta.country)]
  );
}

function resolveFinalRedirectUrl(req, row) {
  if (!row) return null;
  let finalTargetUrl = row.original;
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
    }
  }
  return ensureAbsoluteUrl(finalTargetUrl);
}

// Mərkəzləşdirilmiş Yönləndirmə Məntiqi
function handleRedirection(req, res, row, passwordVerified = false) {
  const short = row.short;
  const consentState = getRedirectConsentModeForRequest(req, short, 'redirect');
  const consentMode = consentState.mode;

  if (!consentMode) {
    return res.redirect(302, `/consent/redirect/${encodeURIComponent(short)}`);
  }

  // 1. Bitmə Tarixi Kontrolü
  if (isIsoTimeExpired(row.expires_at)) {
    return res.status(410).render('error-expired', { csrfToken: res.locals._csrf });
  }

  // 2. Maksimum Klik Kontrolü
  db.get('SELECT COUNT(*) as count FROM clicks WHERE url_id = ?', [row.id], (err, result) => {
    if (result && row.max_clicks && result.count >= row.max_clicks) {
      if (row.user_id) {
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
      return res.status(410).render('error-max-clicks', { csrfToken: res.locals._csrf });
    }

    // 3. Şifrə Kontrolü
    if (row.link_password && !passwordVerified) {
      return res.redirect(`/proceed/${encodeURIComponent(short)}`);
    }

    // 4. Abuse / Təhlükə Xəbərdarlığı Kontrolü
    if (row.abuse_score >= 4 && !req.query.confirm) {
      const currentLang = normalizeLang(req.query.lang || (req.session && req.session.lang), 'az');
      const announcementHtml = buildAnnouncementBannerMarkup(currentLang);
      const assetQuery = getAssetVersionQuery();
      return res.send(`
        <!DOCTYPE html>
        <html lang="${escapeHtml(currentLang)}">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Xəbərdarlıq - Ovlink</title>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.0/css/bootstrap.min.css">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            <link rel="stylesheet" href="/style.css${assetQuery}">
          </head>
          <body class="home-page app-page">
${announcementHtml}
            <main class="container mt-5 text-center">
              <div class="card shadow-sm border-0 mx-auto p-4" style="max-width: 520px;">
                <i class="fa-solid fa-triangle-exclamation fa-4x text-warning mb-3"></i>
                <h2 class="fw-bold mb-2" data-i18n="danger_title">Xəbərdarlıq</h2>
                <p class="text-muted" data-i18n="danger_msg">Bu link çox sayda şikayət alıb. Davam etmək istəyirsiniz?</p>
                <div class="d-flex justify-content-center gap-2 mt-3">
                  <a href="/${short}?confirm=true" class="btn btn-warning" data-i18n="danger_continue">Davam et</a>
                  <a href="/" class="btn btn-outline-secondary" data-i18n="danger_back">Geri qayıt</a>
                </div>
              </div>
            </main>
            <script src="/lang.js${assetQuery}"></script>
            <script src="/script.js${assetQuery}"></script>
          </body>
        </html>
      `);
    }

    // 5. Tracking (Klik qeydiyyatı)
    recordClickEvent(req, row, consentMode);

    // 6. Final Yönlendirmə (Cihaz Hedefleme ve A/B Testi)
    const targetUrl = resolveFinalRedirectUrl(req, row);
    if (!targetUrl) return send404(res);
    res.redirect(targetUrl);
  });
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
router.get('/:short', (req, res, next) => {
  const rawShort = (req.params.short || '').toString();
  // These app pages live below this resolver in route order; pass them through.
  if (rawShort === 'dashboard' || rawShort === 'workspaces')
    return next();

  const short = normalizeShortCode(rawShort);
  if (!short) return send404(res);

  db.get('SELECT * FROM urls WHERE short = ?', [short], (err, row) => {
    if (err) return res.status(500).send('Server error.');
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

    // Admin moderation controls: disabled links + blocked destination domains
    if (row.disabled == 1) {
      return res.status(410).render('error-disabled', { csrfToken: res.locals._csrf, reason: row.disabled_reason || '' });
    }

    const originalAbs = ensureAbsoluteUrl(row.original);
    if (!originalAbs) return send404(res);
    let hostname = '';
    try { hostname = new URL(originalAbs).hostname.toLowerCase(); } catch { hostname = ''; }

    if (!hostname) return handleRedirection(req, res, row);

    db.get("SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1", [hostname, hostname], (blockErr, blockedRow) => {
      if (blockedRow) {
        return res.status(451).render('error-blocked', { csrfToken: res.locals._csrf });
      }
      return handleRedirection(req, res, row);
    });
  });
});

// Şifre korumalı linkler için (GET /proceed/:short)
router.get('/proceed/:short', (req, res) => {
  const short = normalizeShortCode(req.params.short);
  if (!short) return send404(res);
  db.get('SELECT * FROM urls WHERE short = ?', [short], (err, row) => {
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

    if (row.link_password) {
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
    } else {
      recordClickEvent(req, row, consentMode);
      if (consentState.source === 'session') {
        clearRedirectConsentSession(req);
      }
      const targetUrl = resolveFinalRedirectUrl(req, row);
      if (!targetUrl) return send404(res);
      res.redirect(targetUrl);
    }
  });
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

    const targetUrl = resolveFinalRedirectUrl(req, row);
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
          recordClickEvent(req, row, consentMode);

          return res.json({ success: true, redirect: targetUrl });
        }

        return res.status(401).json({ error: pickLang(uiLang, 'Yanlış şifrə.', 'Yanlış şifre.', 'Incorrect password.') });
      });
    });
  });
});

module.exports = router;
