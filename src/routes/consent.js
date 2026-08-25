const express = require('express');
const { db } = require('../db/index');
const { ensureAbsoluteUrl, normalizeShortCode, buildAbsoluteUrlForHost } = require('../lib/url-helpers');
const {
  getRedirectConsentMode,
  clearRedirectConsentSession,
  setRedirectConsentSession,
  setRedirectConsentMode,
  clearRedirectConsentMode,
  getConsentResumePath,
  normalizeConsentNext,
  buildRedirectConsentSignature,
  REDIRECT_CONSENT_MODES,
  REDIRECT_CONSENT_COUNTDOWN_MS
} = require('../lib/consent');
const { pickLang } = require('../lib/i18n');
const { sensitiveActionLimiter } = require('../middleware/rate-limiter');
const { getRequestHostName, getShortHostAccess } = require('../lib/custom-domain');

const router = express.Router();

function send404(res) {
  res.set('X-Robots-Tag', 'noindex,nofollow');
  return res.status(404).render('404', { seo: {} });
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

module.exports = router;