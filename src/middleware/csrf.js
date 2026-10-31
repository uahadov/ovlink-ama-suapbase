const express = require('express');
const lusca = require('lusca');

const crypto = require('crypto');
const tsscmp = require('tsscmp');

// CSRF implementation using HMAC-SHA256(SESSION_SECRET, sessionID)
// Does NOT depend on session data persistence - only needs the session ID.
const csrfImpl = {
  create(req, secretKey) {
    const sid = req.sessionID || '';
    const secret = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'fallback_session_secret')
      .update(sid)
      .digest('base64url');
    const token = secret;
    return { secret, token, validate(req2, tokenCandidate) {
      try {
        if (typeof tokenCandidate !== 'string') return false;
        const sid2 = req2.sessionID || '';
        const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'fallback_session_secret')
          .update(sid2)
          .digest('base64url');
        return tsscmp(tokenCandidate, expected);
      } catch { return false; }
    }};
  }
};

const csrfMiddleware = lusca.csrf({
  header: 'x-csrf-token',
  impl: csrfImpl
});

const csrfRouter = express.Router();

csrfRouter.get('/api/csrf', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  try {
    const token = typeof req.csrfToken === 'function' ? req.csrfToken() : '';
    if (!token) return res.json({ csrfToken: '' });
    // saveUninitialized:false means guest sessions are not auto-saved.
    // We must explicitly mark and save here so the CSRF secret persists across requests.
    if (req.session) req.session.csrfInit = 1;
    req.session.save((err) => {
      if (err) {
        console.error('[csrf] session save error:', err);
      }
      return res.json({ csrfToken: token });
    });
  } catch (err) {
    console.error('[csrf] token error:', err);
    return res.json({ csrfToken: '' });
  }
});

module.exports = { csrfMiddleware, csrfRouter };
