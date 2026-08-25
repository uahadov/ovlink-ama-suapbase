const { db } = require('../db/index');
const { getEffectivePlanForUser, PLAN_TIERS, PLAN_STATUS } = require('../lib/plans');
const { logSecurityEvent } = require('../lib/security');

function normalizeSessionToken(tokenRaw) {
  const t = (tokenRaw || '').toString().trim();
  return (t.length > 0 && t.length <= 512) ? t : null;
}

function requireSignedIn(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = normalizeSessionToken(req.session.userSessionToken);
  if (token) {
    db.get('SELECT is_revoked FROM user_sessions WHERE session_token = ? AND user_id = ?', [token, req.session.userId], (err, row) => {
      if (!err && row && row.is_revoked === 1) {
        try { req.session.destroy(() => {}); } catch {}
        res.clearCookie('connect.sid');
        return res.status(401).json({ error: 'Session has been revoked.' });
      }
      return next();
    });
    return;
  }
  return next();
}

function requireProAccess(feature) {
  return async (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const plan = await getEffectivePlanForUser(req.session.userId);
      if (!plan.is_active || plan.tier !== PLAN_TIERS.PRO || plan.status !== PLAN_STATUS.ACTIVE) {
        logSecurityEvent(req, 'pro.access.denied', 'blocked', { feature: (feature || '').toString().slice(0, 64) });
        return res.status(403).json({ error: 'Pro plan required.' });
      }
      req.proPlan = plan;
      return next();
    } catch {
      return res.status(500).json({ error: 'Server error.' });
    }
  };
}

// Ensure res.locals context is populated correctly for authenticated users
function authContextMiddleware(req, res, next) {
  const accept = (req.get('accept') || '').toLowerCase();
  const wantsHtml = accept.includes('text/html');
  if (!wantsHtml && !req.path.startsWith('/admin')) return next();

  const hasUserSession = !!(req.session && (req.session.userId || req.session.adminUserId));
  const isPrivateUiRoute = req.path.startsWith('/dashboard')
    || req.path.startsWith('/account')
    || req.path.startsWith('/notifications')
    || req.path.startsWith('/admin');

  if (hasUserSession || isPrivateUiRoute) {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
  } else {
    res.set('Cache-Control', 'no-cache, max-age=0, must-revalidate');
  }

  next();
}

function authLocalsMiddleware(req, res, next) {
  res.locals.user = req.session && req.session.userId ? {
    id: req.session.userId,
    email: req.session.username || '',
    isAdmin: !!req.session.adminUserId
  } : null;
  res.locals.unreadNotifCount = 0;

  if (!req.session || !req.session.userId) {
    return next();
  }

  db.get(
    'SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND read_at IS NULL',
    [req.session.userId],
    (err, row) => {
      if (!err && row && Number.isFinite(row.cnt)) {
        res.locals.unreadNotifCount = row.cnt;
      }
      next();
    }
  );
}


function requireApiScope(requiredScope) {
  return (req, res, next) => {
    const scopes = req.apiScopes;
    if (!scopes || !scopes.has(requiredScope)) {
      return res.status(403).json({ error: 'Missing required API scope: ' + requiredScope });
    }
    next();
  };
}

function trackProApiUsage(req, res, next) {
  if (res.locals && res.locals._proApiUsageTracked) return next();
  if (res.locals) res.locals._proApiUsageTracked = true;

  res.on('finish', () => {
    try {
      const auth = req.apiAuth || {};
      const userId = Number.parseInt(auth.userId, 10);
      const apiKeyId = Number.parseInt(auth.apiKeyId, 10);
      if (!Number.isInteger(userId) || userId <= 0) return;
      if (!Number.isInteger(apiKeyId) || apiKeyId <= 0) return;

      const method = ((req.method || 'GET').toString().trim().toUpperCase() || 'GET').slice(0, 16);
      const endpoint = ((req.path || req.originalUrl || '/api/pro/v1') + '').split('?')[0].slice(0, 180);
      const statusCode = Number.parseInt(res.statusCode, 10) || 0;
      const errorType = classifyApiUsageErrorType(statusCode);
      const nowIso = new Date().toISOString();

      insertApiUsageLogRow({
        user_id: userId,
        api_key_id: apiKeyId,
        endpoint,
        method,
        status_code: statusCode,
        error_type: errorType,
        created_at: nowIso,
      });
    } catch {}
  });

  return next();
}

async function authenticateProApiKey(req, res, next) {
  const rawKey = getApiKeyFromRequest(req);
  if (!rawKey || !/^ovk_[A-Za-z0-9_-]{20,200}$/.test(rawKey)) {
    logSecurityEvent(req, 'api.key.auth', 'failure', { reason: 'missing_or_bad_format' });
    return res.status(401).json({ error: 'Invalid API key.' });
  }

  const keyHashV2 = hashApiKeyValueV2(rawKey);
  const keyHashLegacy = hashApiKeyValueLegacy(rawKey);
  try {
    const row = await dbGetAsync(
      'SELECT k.id AS key_id, k.user_id, k.key_hash, k.scopes, COALESCE(k.hash_version, 1) AS hash_version, u.plan_tier, u.plan_status, u.pro_expires_at, u.pro_paused_at ' +
      'FROM api_keys k JOIN users u ON u.id = k.user_id ' +
      'WHERE (k.key_hash = ? OR k.key_hash = ?) AND k.revoked_at IS NULL LIMIT 1',
      [keyHashV2, keyHashLegacy]
    );

    if (!row) {
      logSecurityEvent(req, 'api.key.auth', 'failure', { reason: 'not_found' });
      return res.status(401).json({ error: 'Invalid API key.' });
    }

    const effectivePlan = await getEffectivePlanForUser(row.user_id);
    if (!effectivePlan || !effectivePlan.is_active || effectivePlan.tier !== PLAN_TIERS.PRO) {
      logSecurityEvent(req, 'api.key.auth', 'blocked', { reason: 'plan_not_active', user_id: row.user_id, api_key_id: row.key_id });
      return res.status(403).json({ error: 'Pro plan required.' });
    }

    const now = new Date().toISOString();
    if (row.key_hash === keyHashLegacy && keyHashLegacy !== keyHashV2) {
      await dbRunAsync('UPDATE api_keys SET key_hash = ?, hash_version = 2 WHERE id = ? AND key_hash = ?', [keyHashV2, row.key_id, keyHashLegacy]).catch(() => {});
    }
    await dbRunAsync('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now, row.key_id]).catch(() => {});
    req.apiAuth = {
      userId: row.user_id,
      apiKeyId: row.key_id,
      scopes: normalizeApiKeyScopes(row.scopes || '', DEFAULT_API_KEY_SCOPES),
      plan: effectivePlan,
    };
    logSecurityEvent(req, 'api.key.auth', 'success', { user_id: row.user_id, api_key_id: row.key_id });
    return next();
  } catch {
    return res.status(500).json({ error: 'Server error.' });
  }
}
module.exports = {
  trackProApiUsage,
  authenticateProApiKey,
  requireApiScope,
  requireSignedIn,
  requireProAccess,
  authContextMiddleware,
  authLocalsMiddleware
};
