const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');

const { db } = require('../../db/index');
const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../../db/helpers');
const {
  normalizeShortCode,
  isReservedShortAlias,
  normalizeCustomDomainInput,
  ensureAbsoluteUrl,
  normalizeHostName,
  getSafeHostHeader,
  buildShortUrl
} = require('../../lib/url-helpers');
const { isSuspiciousOrPhishingUrl } = require('../../lib/url-validator');
const {
  getPublicBaseUrl,
  buildAbsoluteUrl,
  getConfiguredBaseHost,
  hasApiKeyAuthHeader,
  API_KEY_SCOPES,
  DEFAULT_API_KEY_SCOPES,
  normalizeApiKeyScopes,
  logSecurityEvent
} = require('../../lib/security');
const { pickLang, normalizeLang } = require('../../lib/i18n');
const {
  isProAccessActive,
  getEffectivePlanForUser,
  PLAN_TIERS,
  normalizeFutureExpiryInput,
  isIsoTimeExpired
} = require('../../lib/plans');
const { enqueueWebhookEventForUser } = require('../../lib/webhook');
const { createUserNotification } = require('../../lib/notifications');
const { scanUrlAsync } = require('../../lib/safety');
const { redisClient } = require('../../config/redis');
const { ASSET_VERSION, isEnabledEnv } = require('../../config/index');
const {
  shortenLimiter,
  apiLimiter,
  generalLimiter,
  mutationLimiter,
  reportLimiter,
  proReadLimiter,
  proWriteLimiter
} = require('../../middleware/rate-limiter');
const {
  requireSignedIn,
  authenticateProApiKey,
  trackProApiUsage,
  requireApiScope
} = require('../../middleware/auth');
const { siteSettings } = require('../../middleware/maintenance');
const { buildSeo } = require('../../lib/seo');

const guestLimitStore = new Map();

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getGuestKey(req) {
  if (req && req.session) {
    if (!req.session.guestKey) {
      req.session.guestKey = crypto.randomBytes(16).toString('hex');
    }
    return req.session.guestKey;
  }
  return 'guest';
}

function buildGuestDailyLimitStoreKey(req, dayKey) {
  const guestKey = getGuestKey(req);
  const safeDayKey = (dayKey || '').toString().trim();
  return `ovlink:guest-limit:${guestKey}:${safeDayKey}`;
}

function generateSafeShortCode(maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const candidate = crypto.randomBytes(6).toString('base64url');
    if (!isReservedShortAlias(candidate)) return candidate;
  }
  return crypto.randomBytes(6).toString('base64url');
}

function buildBanMessage(uiLang, banUntil, banReason) {
  const lang = normalizeLang(uiLang, 'az');
  let msg = lang === 'tr'
    ? 'Bu hesap engellendi.'
    : (lang === 'en' ? 'This account is blocked.' : 'Bu hesab bloklanıb.');
  return msg;
}

function normalizeFolderName(raw) {
  const text = (raw || '').toString().replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.slice(0, 80);
}

function normalizeTagsInput(raw) {
  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    const text = raw.trim();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) items = parsed;
        else items = text.split(',');
      } catch {
        items = text.split(',');
      }
    }
  }
  const clean = [];
  const seen = new Set();
  for (const item of items) {
    const tag = (item || '').toString().replace(/\s+/g, ' ').trim();
    if (!tag) continue;
    const safeTag = tag.slice(0, 32);
    const lower = safeTag.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    clean.push(safeTag);
    if (clean.length >= 8) break;
  }
  return clean.join(',');
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function extractImportUrlCandidate(rawLine) {
  const line = (rawLine || '').toString().trim();
  if (!line) return '';
  const parsed = parseCsvLine(line);
  if (parsed.length) {
    for (const item of parsed) {
      const candidate = (item || '').toString().trim().replace(/^[\s"'<]+|[\s"'>]+$/g, '');
      if (/^https?:\/\//i.test(candidate)) return candidate;
    }
  }
  const match = line.match(/https?:\/\/[^\s"'<>,]+/i);
  return match ? match[0] : '';
}

router.get('/api/pro/v1/account', authenticateProApiKey, trackProApiUsage, proReadLimiter, requireApiScope(API_KEY_SCOPES.ACCOUNT_READ), async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  try {
    const overview = await loadProOverviewPayload(req.apiAuth.userId, req.apiAuth.plan);
    return res.json({
      account: {
        user_id: req.apiAuth.userId,
        plan: req.apiAuth.plan,
        features: req.apiAuth.plan.features,
        api_key_scopes: normalizeApiKeyScopes(req.apiAuth.scopes || '', DEFAULT_API_KEY_SCOPES),
      },
      limits: overview.limits,
    });
  } catch {
    return res.status(500).json({ error: 'Server error.' });
  }
});

router.all('/api/pro/v1/account', (req, res, next) => {
  if (req.method === 'GET') return next();
  res.set('Allow', 'GET');
  return res.status(405).json({ error: 'Method not allowed. Use GET /api/pro/v1/account.' });
});

router.post('/api/pro/v1/shorten', authenticateProApiKey, trackProApiUsage, proWriteLimiter, requireApiScope(API_KEY_SCOPES.SHORTEN_WRITE), async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const originalInput = pickFirstInputValue(
    body.original_url,
    body.originalUrl,
    body.original,
    body.url,
    body.target_url,
    body.targetUrl,
    body.link
  );
  const customAliasInput = pickFirstInputValue(
    body.custom_alias,
    body.customAlias,
    body.customLink,
    body.alias,
    body.short
  );
  const rawCustomDomainInput = pickFirstInputValue(
    body.custom_domain,
    body.customDomain,
    body.domain,
    body.domain_host,
    body.domainHost
  );
  const requestedDomain = normalizeCustomDomainInput(rawCustomDomainInput);
  const expiresAtInput = pickFirstInputValue(
    body.expires_at,
    body.expiresAt,
    body.expiry_at,
    body.expiryAt
  );
  const maxClicksInput = body.max_clicks ?? body.maxClicks;
  const rawIdempotencyKey = (req.get('idempotency-key') || '').toString();
  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
  const hasIdempotencyKey = rawIdempotencyKey.trim().length > 0;
  const ownerId = req.apiAuth && req.apiAuth.userId ? req.apiAuth.userId : 0;

  if (hasIdempotencyKey && !idempotencyKey) {
    return res.status(400).json({ error: 'Invalid Idempotency-Key header.' });
  }

  const originalAbs = ensureAbsoluteUrl(originalInput);
  if (!originalAbs) {
    return res.status(400).json({ error: 'Invalid original_url.' });
  }

  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  if (rawCustomDomainInput && !requestedDomain) {
    return res.status(400).json({ error: 'Invalid custom_domain.' });
  }

  let destinationHostname = '';
  try {
    destinationHostname = normalizeHostName(new URL(originalAbs).hostname || '');
  } catch {
    destinationHostname = '';
  }

  let idempotencyState = null;
  try {
    const userRow = await dbGetAsync(
      'SELECT id, banned, ban_until, ban_reason FROM users WHERE id = ? LIMIT 1',
      [ownerId]
    );
    if (!userRow) return res.status(401).json({ error: 'Unauthorized.' });

    if (userRow.banned == 1 && userRow.ban_until) {
      const untilMs = Date.parse(userRow.ban_until);
      if (!Number.isNaN(untilMs) && untilMs <= Date.now()) {
        await dbRunAsync(
          'UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?',
          [ownerId]
        ).catch(() => {});
        userRow.banned = 0;
        userRow.ban_until = null;
      }
    }

    const banActive = (userRow.banned == 1) && (!userRow.ban_until || (Date.parse(userRow.ban_until) > Date.now()));
    if (banActive) {
      return res.status(403).json({ error: 'Account is temporarily restricted.' });
    }

    if (destinationHostname) {
      const blocked = await dbGetAsync(
        "SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1",
        [destinationHostname, destinationHostname]
      );
      if (blocked && blocked.domain) {
        return res.status(403).json({ error: 'Destination domain is blocked.' });
      }
    }

    let selectedDomainHost = '';
    if (requestedDomain) {
      const domainRow = await dbGetAsync(
        'SELECT id, domain, status FROM custom_domains WHERE user_id = ? AND domain = ? LIMIT 1',
        [ownerId, requestedDomain]
      );
      if (!domainRow) {
        return res.status(400).json({ error: 'Custom domain is not linked to your account.' });
      }
      if ((domainRow.status || '').toString() !== 'active') {
        return res.status(400).json({ error: 'Custom domain is not active.' });
      }
      selectedDomainHost = normalizeHostName(domainRow.domain);
    }

    let short = '';
    if (customAliasInput) {
      if (!SHORT_CODE_RE.test(customAliasInput)) {
        return res.status(400).json({ error: 'Invalid custom_alias format.' });
      }
      if (isReservedShortAlias(customAliasInput)) {
        return res.status(400).json({ error: 'custom_alias is reserved.' });
      }
      short = customAliasInput;
      const exists = await dbGetAsync('SELECT id FROM urls WHERE short = ? LIMIT 1', [short]);
      if (exists && exists.id) {
        return res.status(409).json({ error: 'custom_alias is already in use.' });
      }
    } else {
      short = generateSafeShortCode();
    }

    const expiresValidation = normalizeFutureExpiryInput(expiresAtInput);
    if (expiresValidation.error === 'invalid') {
      return res.status(400).json({ error: 'Invalid expires_at.' });
    }
    if (expiresValidation.error === 'past') {
      return res.status(400).json({ error: 'expires_at must be in the future.' });
    }
    const expiresAtValue = expiresValidation.value;

    let maxClicksValue = null;
    if (maxClicksInput !== undefined && maxClicksInput !== null && `${maxClicksInput}`.trim() !== '') {
      const parsedMax = Number.parseInt(`${maxClicksInput}`, 10);
      if (!Number.isInteger(parsedMax) || parsedMax < 1) {
        return res.status(400).json({ error: 'max_clicks must be an integer >= 1.' });
      }
      maxClicksValue = parsedMax;
    }

    const originalBInput = pickFirstInputValue(body.original_b, body.originalB, body.target_b);
    let splitPercentValue = 50;
    const splitInput = body.ab_split_percent ?? body.abSplitPercent;
    if (splitInput !== undefined && splitInput !== null && `${splitInput}`.trim() !== '') {
      const parsedPercent = Number.parseInt(`${splitInput}`, 10);
      if (Number.isInteger(parsedPercent) && parsedPercent >= 0 && parsedPercent <= 100) {
        splitPercentValue = parsedPercent;
      }
    }
    const originalBAbs = originalBInput ? ensureAbsoluteUrl(originalBInput) : null;

    const iosUrlInput = pickFirstInputValue(body.ios_url, body.iosUrl, body.target_ios);
    const androidUrlInput = pickFirstInputValue(body.android_url, body.androidUrl, body.target_android);
    const iosUrlAbs = iosUrlInput ? ensureAbsoluteUrl(iosUrlInput) : null;
    const androidUrlAbs = androidUrlInput ? ensureAbsoluteUrl(androidUrlInput) : null;

    const createdAt = new Date().toISOString();
    const shortUrl = buildShortUrl(req, short, selectedDomainHost);
    const requestHash = buildShortenIdempotencyRequestHash({
      owner_id: ownerId,
      original_url: originalAbs,
      custom_alias: customAliasInput || '',
      custom_domain: requestedDomain || '',
      expires_at: expiresAtValue || '',
      max_clicks: maxClicksValue == null ? null : maxClicksValue,
    });
    idempotencyState = await reserveApiIdempotencyRecord({
      userId: ownerId,
      apiKeyId: req.apiAuth && req.apiAuth.apiKeyId,
      endpoint: 'pro.v1.shorten',
      rawIdempotencyKey: idempotencyKey,
      requestHash,
    });
    if (idempotencyState && idempotencyState.replayed) {
      res.setHeader('Idempotency-Replayed', 'true');
      return res.status(idempotencyState.statusCode || 200).json(idempotencyState.payload || {});
    }
    if (idempotencyState && idempotencyState.conflict) {
      return res.status(idempotencyState.statusCode || 409).json({ error: idempotencyState.error || 'Idempotency conflict.' });
    }

    const inserted = await dbRunAsync(
      'INSERT INTO urls (original, short, created_at, user_id, link_password, expires_at, max_clicks, domain_host, original_b, ab_split_percent, ios_url, android_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [originalAbs, short, createdAt, ownerId, '', expiresAtValue, maxClicksValue, selectedDomainHost || null, originalBAbs, splitPercentValue, iosUrlAbs, androidUrlAbs]
    ).catch((insertErr) => {
      const msg = (insertErr && insertErr.message ? insertErr.message : '').toLowerCase();
      if (msg.includes('unique') && msg.includes('urls.short')) return null;
      throw insertErr;
    });

    if (!inserted) {
      if (idempotencyState && idempotencyState.recordId) {
        await releaseApiIdempotencyRecord(idempotencyState.recordId);
      }
      return res.status(409).json({ error: 'Generated short code collided. Please retry.' });
    }

    void enqueueWebhookEventForUser(ownerId, 'link.created', {
      short,
      short_url: shortUrl,
      original_url: originalAbs,
      domain: selectedDomainHost || null,
      created_at: createdAt,
    });

    const responsePayload = {
      id: inserted.lastID || null,
      short,
      short_url: shortUrl,
      original_url: originalAbs,
      domain: selectedDomainHost || null,
      expires_at: expiresAtValue,
      max_clicks: maxClicksValue,
      created_at: createdAt,
    };
    if (idempotencyState && idempotencyState.recordId) {
      await finalizeApiIdempotencyRecord(idempotencyState.recordId, 201, responsePayload);
    }
    scanUrlAsync(short, originalAbs, ownerId);
    if (originalBAbs) scanUrlAsync(short, originalBAbs, ownerId);
    if (iosUrlAbs) scanUrlAsync(short, iosUrlAbs, ownerId);
    if (androidUrlAbs) scanUrlAsync(short, androidUrlAbs, ownerId);
    return res.status(201).json(responsePayload);
  } catch (err) {
    if (idempotencyState && idempotencyState.recordId) {
      await releaseApiIdempotencyRecord(idempotencyState.recordId);
    }
    const message = (err && err.message ? err.message : '').toLowerCase();
    if (message.includes('api_idempotency_keys')) {
      return res.status(409).json({ error: 'Idempotency processing conflict. Please retry.' });
    }
    return res.status(500).json({ error: 'Server error.' });
  }
});

router.all('/api/pro/v1/shorten', (req, res, next) => {
  if (req.method === 'POST') return next();
  res.set('Allow', 'POST');
  return res.status(405).json({ error: 'Method not allowed. Use POST /api/pro/v1/shorten.' });
});

router.post('/api/shorten',
  shortenLimiter,
  [
    body('original')
      .isURL().withMessage('Zəhmət olmasa düzgün bir URL daxil edin.')
      .trim(),
    body('customLink')
      .optional({ checkFalsy: true })
      .matches(/^[a-zA-Z0-9_-]+$/).withMessage('Xüsusi link yalnız hərf, rəqəm, tire və alt xətt simvollarından ibarət ola bilər.')
      .isLength({ max: 50 }).withMessage('Xüsusi link ən çox 50 simvoldan ibarət ola bilər.')
      .trim()
      .escape(),
    body('custom_domain')
      .optional({ checkFalsy: true })
      .custom((value) => !!normalizeCustomDomainInput(value)).withMessage('Düzgün domen daxil edin.'),
    body('max_clicks')
      .optional({ checkFalsy: true })
      .isInt({ min: 1 }).withMessage('Maksimum klik sayı 1 və ya daha çox olmalıdır.'),
    body('workspaceId')
      .optional({ checkFalsy: true })
      .isInt({ min: 1 }).withMessage('Yanlış workspace identifikatoru.')
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const uiLang = normalizeLang(req.body && req.body.lang, 'az');
      const err = errors.array()[0] || {};
      let msg = err.msg || pickLang(uiLang, 'Yanlış məlumat daxil edilib.', 'Geçersiz bilgi.', 'Invalid input.');
      if (err.param === 'original') {
        msg = pickLang(uiLang, 'Zəhmət olmasa düzgün bir URL daxil edin.', 'Lütfen geçerli bir URL girin.', 'Please enter a valid URL.');
      } else if (err.param === 'max_clicks') {
        msg = pickLang(uiLang, 'Maksimum klik sayı 1 və ya daha çox olmalıdır.', 'Maksimum tıklama 1 veya daha fazla olmalıdır.', 'Maximum clicks must be 1 or more.');
      } else if (err.param === 'customLink') {
        const raw = (err.msg || '').toString();
        if (raw.includes('50')) {
          msg = pickLang(uiLang, 'Xüsusi link ən çox 50 simvoldan ibarət ola bilər.', 'Özel link en fazla 50 karakter olabilir.', 'Custom link can be at most 50 characters.');
        } else {
          msg = pickLang(uiLang, 'Xüsusi link yalnız hərf, rəqəm, tire və alt xətt simvollarından ibarət ola bilər.', 'Özel link yalnızca harf, rakam, tire ve alt çizgi içerebilir.', 'Custom link can contain only letters, numbers, hyphens and underscores.');
        }
      } else if (err.param === 'custom_domain') {
        msg = pickLang(uiLang, 'Düzgün domen daxil edin.', 'Geçerli bir alan adı girin.', 'Please enter a valid domain.');
      }
      return res.status(400).json({ error: msg });
    }

    const uiLang = normalizeLang(req.body && req.body.lang, 'az');

    const isGuest = !req.session.userId;
    const ownerId = req.session.userId || null;

    const { original, link_password, customLink, custom_domain, expires_at, max_clicks, original_b, ab_split_percent, ios_url, android_url } = req.body;
    const requestedWorkspaceId = Number.parseInt(req.body && req.body.workspaceId, 10) || 0;
    const requestedDomain = normalizeCustomDomainInput(custom_domain);
    const originalAbs = ensureAbsoluteUrl(original);
    if (!originalAbs) {
      return res.status(400).json({ error: pickLang(uiLang, 'Zəhmət olmasa düzgün bir URL daxil edin.', 'Lütfen geçerli bir URL girin.', 'Please enter a valid URL.') });
    }

    const expiresValidation = normalizeFutureExpiryInput(expires_at);
    if (expiresValidation.error === 'invalid') {
      return res.status(400).json({ error: pickLang(uiLang, 'Bitmə tarixi etibarlı deyil.', 'Bitiş tarihi geçersiz.', 'Expiration date is invalid.') });
    }
    if (expiresValidation.error === 'past') {
      return res.status(400).json({ error: pickLang(uiLang, 'Bitmə tarixi gələcəkdə olmalıdır.', 'Bitiş tarihi gelecekte olmalıdır.', 'Expiration date must be in the future.') });
    }
    const expiresAtValue = expiresValidation.value;

    let maxClicksValue = null;
    if (max_clicks !== undefined && max_clicks !== null && `${max_clicks}`.trim() !== '') {
      const parsedMaxClicks = Number.parseInt(`${max_clicks}`, 10);
      if (!Number.isInteger(parsedMaxClicks) || parsedMaxClicks < 1) {
        return res.status(400).json({ error: pickLang(uiLang, 'Maksimum klik sayı 1 və ya daha çox olmalıdır.', 'Maksimum tıklama 1 veya daha fazla olmalıdır.', 'Maximum clicks must be 1 or more.') });
      }
      maxClicksValue = parsedMaxClicks;
    }

    let hostname = '';
    try { hostname = new URL(originalAbs).hostname.toLowerCase(); } catch { hostname = ''; }

    const limitMsg = pickLang(uiLang, 'Gündəlik limit dolub. Giriş etmədən maksimum 2 link yarada bilərsiniz.', 'Günlük limit doldu. Giriş yapmadan en fazla 2 link oluşturabilirsiniz.', 'Daily limit reached. You can create up to 2 links without logging in.');

    const checkGuestLimit = (cb) => {
      if (!isGuest) return cb(null, null);
      const dayKey = getTodayKey();
      const storeKey = buildGuestDailyLimitStoreKey(req, dayKey);

      if (redisClient && redisClient.isOpen) {
        return redisClient.get(storeKey)
          .then((rawCount) => {
            const count = Number.parseInt((rawCount || '0').toString(), 10);
            const safeCount = Number.isFinite(count) && count > 0 ? count : 0;
            if (safeCount >= 2) return cb(limitMsg, null);
            return cb(null, { storeKey, count: safeCount, redis: true });
          })
          .catch(() => {
            const fallbackMeta = guestLimitStore.get(storeKey) || { count: 0 };
            if (fallbackMeta.count >= 2) return cb(limitMsg, null);
            return cb(null, { storeKey, count: fallbackMeta.count, redis: false });
          });
      }

      const meta = guestLimitStore.get(storeKey) || { count: 0 };
      if (meta.count >= 2) return cb(limitMsg, null);
      return cb(null, { storeKey, count: meta.count, redis: false });
    };

    const bumpGuestLimit = (meta) => {
      if (!meta || !meta.storeKey) return;
      if (meta.redis && redisClient && redisClient.isOpen) {
        redisClient.multi()
          .incr(meta.storeKey)
          .expire(meta.storeKey, 2 * 24 * 60 * 60)
          .exec()
          .catch(() => {});
        return;
      }
      const nextCount = (meta.count || 0) + 1;
      guestLimitStore.set(meta.storeKey, { count: nextCount, updated_at: new Date().toISOString() });
      if (guestLimitStore.size > 1000) {
        const oldestKey = guestLimitStore.keys().next().value;
        guestLimitStore.delete(oldestKey);
      }
    };

    // User ban check (prevents link creation while banned)
    const checkUserBan = (cb) => {
      if (isGuest || !ownerId) return cb(null);
      db.get('SELECT email, banned, ban_until, ban_reason, ui_lang, ui_theme, notify_report, notify_limit, notify_disabled FROM users WHERE id = ?', [ownerId], (uErr, uRow) => {
        if (uErr || !uRow) return cb(null);

        // Auto-clear expired temp bans
        if (uRow.banned == 1 && uRow.ban_until) {
          const untilMs = Date.parse(uRow.ban_until);
          if (!Number.isNaN(untilMs) && untilMs <= Date.now()) {
            db.run(
              'UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?',
              [req.session.userId],
              () => {}
            );
            uRow.banned = 0;
          }
        }

        const banActive = (uRow.banned == 1) && (!uRow.ban_until || (Date.parse(uRow.ban_until) > Date.now()));
        if (!banActive) return cb(null);

        const msg = buildBanMessage(uiLang, uRow.ban_until, uRow.ban_reason);
        return cb(msg);
      });
    };
    // Blocked domain check (prevents creating links for blocked destinations)
    const checkBlockedDomain = (cb) => {
      if (!hostname) return cb(null);
      db.get(
        "SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1",
        [hostname, hostname],
        (err, row) => {
          if (err) return cb(null);
          return cb(row ? row.domain : null);
        }
      );
    };


const checkCustomDomain = (cb) => {
  if (!requestedDomain) return cb(null, '');
  if (isGuest || !ownerId) {
    return cb(pickLang(uiLang, 'Xüsusi domen yalnız giriş edən istifadəçilər üçündür.', 'Özel alan adı yalnız giriş yapan kullanıcılar içindir.', 'Custom domain is available only for signed-in users.'), '');
  }

  db.get(
    'SELECT id, domain, status FROM custom_domains WHERE user_id = ? AND domain = ?',
    [ownerId, requestedDomain],
    (domainErr, domainRow) => {
      if (domainErr) {
        return cb(pickLang(uiLang, 'Domen yoxlanışı uğursuz oldu.', 'Alan adı kontrolü başarısız oldu.', 'Domain validation failed.'), '');
      }
      if (!domainRow) {
        return cb(pickLang(uiLang, 'Bu domen hesabınıza bağlı deyil.', 'Bu alan adı hesabınıza bağlı değil.', 'This domain is not linked to your account.'), '');
      }
      if ((domainRow.status || '').toString() !== 'active') {
        return cb(pickLang(uiLang, 'Bu domen hələ aktiv deyil. Əvvəlcə DNS doğrulamasını tamamlayın.', 'Bu alan adı henüz aktif değil. Önce DNS doğrulamasını tamamlayın.', 'This domain is not active yet. Complete DNS verification first.'), '');
      }
      return cb(null, normalizeHostName(domainRow.domain));
    }
  );
};

    checkGuestLimit((limitErr, guestMeta) => {
      if (limitErr) {
        return res.status(429).json({ error: limitErr });
      }

      // Run user ban and blocked domain checks in parallel
      Promise.all([
        new Promise((resolve) => {
          if (isGuest || !ownerId) return resolve({ isGuest: true });
          db.get('SELECT banned, ban_until, ban_reason, plan_tier, plan_status, pro_expires_at FROM users WHERE id = ?', [ownerId], (uErr, uRow) => {
            if (uErr || !uRow) return resolve({ isGuest: true });
            let banActive = false;
            if (uRow.banned == 1 && uRow.ban_until) {
              const untilMs = Date.parse(uRow.ban_until);
              if (!Number.isNaN(untilMs) && untilMs <= Date.now()) {
                db.run('UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?', [req.session.userId], () => {});
                uRow.banned = 0;
              } else {
                banActive = true;
              }
            } else if (uRow.banned == 1) {
              banActive = true;
            }
            if (!banActive) return resolve({ uRow });
            const msg = buildBanMessage(uiLang, uRow.ban_until, uRow.ban_reason);
            resolve({ banError: msg });
          });
        }),
        new Promise((resolve) => {
          if (!hostname) return resolve(null);
          db.get("SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1", [hostname, hostname], (err, row) => {
            resolve(err ? null : (row ? row.domain : null));
          });
        })
      ]).then(([banResult, blockedResult]) => {
        if (banResult && banResult.banError) {
          return res.status(403).json({ error: banResult.banError });
        }
        if ((original_b || ios_url || android_url) && (!banResult || !banResult.uRow || !isProAccessActive(banResult.uRow))) {
          return res.status(403).json({
            error: pickLang(
              uiLang,
              'Bu inkişaf etmiş xüsusiyyətlər (A/B, Cihaz) yalnız PRO istifadəçilər üçündür.',
              'Bu gelişmiş özellikler (A/B, Cihaz) yalnızca PRO kullanıcılar içindir.',
              'These advanced features (A/B, Device Targeting) are only available for PRO users.'
            )
          });
        }
        if (blockedResult) {
          return res.status(403).json({
            error: pickLang(uiLang,'Bu domen bloklanıb. Bu linki qısaltmaq mümkün deyil.','Bu alan adı engellendi. Bu link kısaltılamaz.','This domain is blocked. This link cannot be shortened.')
          });
        }

        // Check custom domain (needs ban and blocked domain to pass first)
        checkCustomDomain((domainErr, selectedDomain) => {
          if (domainErr) {
            return res.status(400).json({ error: domainErr });
          }

          let short = "";
          if (customLink && customLink.trim() !== "") {
            short = customLink.trim();

            if (isReservedShortAlias(short)) {
              return res.status(400).json({
                error: pickLang(
                  uiLang,
                  'Bu xüsusi alias sistem yolları üçün ayrılıb. Başqa alias seçin.',
                  'Bu özel alias sistem yolları için ayrılmış. Lütfen başka bir alias seçin.',
                  'This alias is reserved for system routes. Please choose another alias.'
                )
              });
            }

            // Özel link zaten kullanılmış mı kontrol et
            db.get('SELECT * FROM urls WHERE short = ?', [short], (err, row) => {
              if (row) {
                return res.status(400).json({ error: pickLang(uiLang, 'Bu xüsusi link istifadə olunub', 'Bu özel link zaten kullanılıyor', 'This custom link is already in use.') });
              } else {
                void insertLink(selectedDomain);
              }
            });
          } else {
            short = generateSafeShortCode();
            void insertLink(selectedDomain);
          }

          async function insertLink(selectedDomainHost) {
            // Workspace-scoped creation: the actor must be a member and the
            // workspace owner must keep an active Pro plan.
            let workspaceLinkScopeId = null;
            if (requestedWorkspaceId > 0) {
              if (!ownerId) {
                return res.status(401).json({ error: pickLang(uiLang, 'Workspace linki yaratmaq üçün daxil olun.', 'Workspace linki oluşturmak için giriş yapın.', 'Sign in to create workspace links.') });
              }
              const membershipRole = await getWorkspaceMemberRole(ownerId, requestedWorkspaceId);
              if (!membershipRole) {
                return res.status(403).json({ error: pickLang(uiLang, 'Bu workspace-ə çıxışınız yoxdur.', 'Bu workspace\'e erişiminiz yok.', 'You do not have access to this workspace.') });
              }
              const workspaceRow = await getWorkspaceById(requestedWorkspaceId);
              if (!workspaceRow || !(await isWorkspaceProActive(workspaceRow))) {
                return res.status(403).json({ error: pickLang(uiLang, 'Workspace Pro aboneliyi aktiv deyil.', 'Workspace Pro aboneliği aktif değil.', 'Workspace Pro subscription is not active.') });
              }
              workspaceLinkScopeId = workspaceRow.id;
            }
            const createdAt = new Date().toISOString();
            const linkPasswordRaw = (link_password || '').toString();
            const shortUrl = buildShortUrl(req, short, selectedDomainHost);
            const storedLinkPassword = linkPasswordRaw ? await hashLinkPassword(linkPasswordRaw) : '';
            if (linkPasswordRaw && !storedLinkPassword) {
              return res.status(500).json({ error: pickLang(uiLang, 'Link qısaldıla bilmədi.', 'Link kısaltılamadı.', 'Link could not be shortened.') });
            }
            let splitPercentValue = 50;
            if (ab_split_percent !== undefined && ab_split_percent !== null && `${ab_split_percent}`.trim() !== '') {
              const parsedPercent = Number.parseInt(`${ab_split_percent}`, 10);
              if (Number.isInteger(parsedPercent) && parsedPercent >= 0 && parsedPercent <= 100) {
                splitPercentValue = parsedPercent;
              }
            }
            const originalBAbs = original_b ? ensureAbsoluteUrl(original_b) : null;
            const iosUrlAbs = ios_url ? ensureAbsoluteUrl(ios_url) : null;
            const androidUrlAbs = android_url ? ensureAbsoluteUrl(android_url) : null;

            db.run(
              'INSERT INTO urls (original, short, created_at, user_id, link_password, expires_at, max_clicks, domain_host, original_b, ab_split_percent, ios_url, android_url, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [originalAbs, short, createdAt, ownerId, storedLinkPassword, expiresAtValue, maxClicksValue, selectedDomainHost || null, originalBAbs, splitPercentValue, iosUrlAbs, androidUrlAbs, workspaceLinkScopeId],
              function (err) {
                if (err) return res.status(500).json({ error: pickLang(uiLang, 'Link qısaldıla bilmədi.', 'Link kısaltılamadı.', 'Link could not be shortened.') });

                bumpGuestLimit(guestMeta);

                if (ownerId) {
                  void enqueueWebhookEventForUser(ownerId, 'link.created', {
                    short,
                    short_url: shortUrl,
                    original_url: originalAbs,
                    domain: selectedDomainHost || null,
                    created_at: createdAt,
                  });
                }

                scanUrlAsync(short, originalAbs, ownerId);
                if (originalBAbs) scanUrlAsync(short, originalBAbs, ownerId);
                if (iosUrlAbs) scanUrlAsync(short, iosUrlAbs, ownerId);
                if (androidUrlAbs) scanUrlAsync(short, androidUrlAbs, ownerId);

                return res.json({
                  message: pickLang(uiLang, 'Qısaldılmış link: ' + shortUrl, 'Kısaltılmış link: ' + shortUrl, 'Short link: ' + shortUrl),
                  short: short,
                  shortUrl: shortUrl,
                  domain: selectedDomainHost || null,
                });
              }
            );
          }
      });
    });
  });
});

// 404 Xəta Səhifəsi

router.post('/api/report', reportLimiter, (req, res) => {
  const { short, reason, lang } = req.body || {};
  const uiLang = normalizeLang(lang, 'az');
  const safeShort = normalizeShortCode(short);

  if (!req.session.userId) {
    return res.status(401).json({ error: pickLang(uiLang, 'Şikayət göndərmək üçün giriş etməlisiniz.', 'Rapor göndermek için giriş yapmalısınız.', 'You must be logged in to submit a report.') });
  }

  if (!safeShort) return res.status(400).json({ error: pickLang(uiLang, 'Qısaldılmış link tələb olunur.', 'Kısaltılmış link gerekli.', 'Short link is required.') });

  const createdAt = new Date().toISOString();
  const cleanReason = (reason || '').toString().trim().slice(0, 500);

  db.get('SELECT email, banned, ban_until, ban_reason, ui_lang, ui_theme, notify_report, notify_limit, notify_disabled FROM users WHERE id = ?', [req.session.userId], (uErr, uRow) => {
    if (uErr || !uRow) return res.status(403).json({ error: pickLang(uiLang, 'Səlahiyyət yoxdur.', 'Yetkisiz istek.', 'Unauthorized request.') });

    // Auto-clear expired temp bans
    if (uRow.banned == 1 && uRow.ban_until) {
      const untilMs = Date.parse(uRow.ban_until);
      if (!Number.isNaN(untilMs) && untilMs <= Date.now()) {
        db.run(
          'UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?',
          [req.session.userId],
          () => {}
        );
        uRow.banned = 0;
      }
    }

    const banActive = (uRow.banned == 1) && (!uRow.ban_until || (Date.parse(uRow.ban_until) > Date.now()));
    if (banActive) {
      const msg = buildBanMessage(uiLang, uRow.ban_until, uRow.ban_reason);
      return res.status(403).json({ error: msg });
    }

    db.get(
      'SELECT id FROM reports WHERE short = ? AND user_id = ? AND resolved_at IS NULL',
      [safeShort, req.session.userId],
      (err, reportRow) => {
        if (err) return res.status(500).json({ error: 'Server error.' });

        if (reportRow) {
          return res.status(400).json({ error: pickLang(uiLang, 'Bu linki artıq şikayət etmisiniz.', 'Bu linki zaten raporladınız.', 'You have already reported this link.') });
        }

        db.get('SELECT id, user_id, reports FROM urls WHERE short = ?', [safeShort], (findErr, row) => {
          if (findErr || !row) {
            return res.status(404).json({ error: pickLang(uiLang, 'Link tapılmadı.', 'Link bulunamadı.', 'Link not found.') });
          }

          db.run(
            'INSERT INTO reports (short, created_at, reason, user_id) VALUES (?, ?, ?, ?)',
            [safeShort, createdAt, cleanReason, req.session.userId],
            function (insertErr) {
              if (insertErr) return res.status(500).json({ error: 'Server error.' });

              // Mark as potentially risky once reported.
              db.run('UPDATE urls SET reports = reports + 1, dangerous = CASE WHEN reports + 1 >= 4 THEN 1 ELSE dangerous END WHERE id = ?', [row.id], () => {
                db.get('SELECT reports, user_id FROM urls WHERE id = ?', [row.id], (cntErr, cntRow) => {
                  if (!cntErr && cntRow && cntRow.user_id && cntRow.user_id !== req.session.userId) {
                    if ((cntRow.reports || 0) >= 1) {
                      const reasonText = cleanReason ? (uiLang === 'tr' ? ` Sebep: ${cleanReason}` : (uiLang === 'en' ? ` Reason: ${cleanReason}` : ` Səbəb: ${cleanReason}`)) : '';
                      createUserNotification(db, cntRow.user_id, 'report', {
                        titleAz: 'Linkiniz şikayət edildi',
                        titleTr: 'Linkiniz raporlandı',
                        titleEn: 'Your link was reported',
                        bodyAz: `Qısa link: ${safeShort}.${reasonText}`,
                        bodyTr: `Kısa link: ${safeShort}.${reasonText}`,
                        bodyEn: `Short link: ${safeShort}.${reasonText}`,
                        linkShort: safeShort,
                        eventKey: `report_${safeShort}`,
                      });
                    }
                  }
                });
              });

              return res.json({ message: pickLang(uiLang, 'Şikayətiniz göndərildi.', 'Raporunuz gönderildi.', 'Your report has been submitted.') });
            }
          );
        });
      }
    );
  });
});

function handleStatsApiRequest(req, res, rawShort) {
  if (!req.session.userId) return res.status(401).json({ error: 'Giriş gerekli.' });
  const requestedShort = Array.isArray(rawShort) ? rawShort[0] : rawShort;
  const short = normalizeShortCode(requestedShort);
  if (!short) return res.status(400).json({ error: 'Geçersiz kısa kod.' });

  db.get(`SELECT * FROM urls WHERE short = ? AND ${WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL}`, [short, req.session.userId, req.session.userId], (err, url) => {
    if (err || !url) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });

    db.all('SELECT * FROM clicks WHERE url_id = ?', [url.id], (err, clicks) => {
      if (err) return res.status(500).json({ error: 'Veri alınamadı.' });

      const stats = {
        total_clicks: clicks.length,
        browsers: {},
        os: {},
        countries: {},
        clicks_over_time: {}
      };

      clicks.forEach(click => {
        const browserKey = click.browser === REDIRECT_CONSENT_MARKER ? REDIRECT_CONSENT_MARKER : getEssentialAnalyticsValue(click.browser);
        const osKey = click.os === REDIRECT_CONSENT_MARKER ? REDIRECT_CONSENT_MARKER : getEssentialAnalyticsValue(click.os);
        const countryKey = click.country === REDIRECT_CONSENT_MARKER ? REDIRECT_CONSENT_MARKER : getEssentialAnalyticsValue(click.country);

        // Browser
        stats.browsers[browserKey] = (stats.browsers[browserKey] || 0) + 1;
        // OS
        stats.os[osKey] = (stats.os[osKey] || 0) + 1;
        // Country
        stats.countries[countryKey] = (stats.countries[countryKey] || 0) + 1;
        // Time (hour bucket, UTC key). Client side local saatte gösterilir.
        const clickDate = new Date(click.click_time);
        if (Number.isFinite(clickDate.getTime())) {
          const hourBucketMs = Math.floor(clickDate.getTime() / 3600000) * 3600000;
          const bucketKey = new Date(hourBucketMs).toISOString();
          stats.clicks_over_time[bucketKey] = (stats.clicks_over_time[bucketKey] || 0) + 1;
        }
      });

      // Sort Time Stats chronologically
      const sortedKeys = Object.keys(stats.clicks_over_time)
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
      
      const clicks_by_day = sortedKeys.map(k => ({
        date: k,
        count: stats.clicks_over_time[k]
      }));

      res.json({
        ...stats,
        short: url.short,
        original: url.original,
        created_at: url.created_at,
        clicks_total: stats.total_clicks,
        clicks_by_day: clicks_by_day
      });
    });
  });
}


router.post('/api/user/delete', (req, res) => {
  if (!req.session.userId) return res.status(401).send('Giriş yapmalısınız.');
  const safeShort = normalizeShortCode(req.body && req.body.short);
  if (!safeShort) return res.status(400).send('Geçersiz kısa kod.');
  db.get(`SELECT short, original, domain_host FROM urls WHERE short = ? AND ${WORKSPACE_LINK_MUTATION_SQL}`, [safeShort, req.session.userId, req.session.userId], (findErr, foundRow) => {
    if (findErr) return res.status(500).send('Link silinemedi.');
    if (!foundRow) return res.status(404).send('Link tapılmadı və ya səlahiyyətiniz yoxdur.');

    db.run(`DELETE FROM urls WHERE short = ? AND ${WORKSPACE_LINK_MUTATION_SQL}`, [safeShort, req.session.userId, req.session.userId], function (err) {
      if (err) return res.status(500).send('Link silinemedi.');
      if (this.changes === 0) return res.status(404).send('Link tapılmadı və ya səlahiyyətiniz yoxdur.');

      const shortUrl = buildShortUrl(req, foundRow.short || safeShort, foundRow.domain_host || '');
      void enqueueWebhookEventForUser(req.session.userId, 'link.deleted', {
        short: foundRow.short || safeShort,
        short_url: shortUrl,
        original_url: foundRow.original || '',
        domain: normalizeHostName(foundRow.domain_host || '') || null,
        deleted_at: new Date().toISOString(),
      });
      res.redirect('/dashboard');
    });
  });
});

// KULLANICI TOPLU LINK SİLME (POST /api/user/delete-bulk)
router.post('/api/user/delete-bulk',
  shortenLimiter,
  (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Giriş yapmalısınız.' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  let shorts = req.body && req.body.shorts;
  if (typeof shorts === 'string') shorts = [shorts];
  if (!Array.isArray(shorts)) shorts = [];

  shorts = shorts.map(s => (s || '').toString().trim()).filter(Boolean);
  shorts = Array.from(new Set(shorts));
  const valid = shorts.filter(s => SHORT_CODE_RE.test(s));

  if (!valid.length) {
    return res.status(400).json({
      error: pickLang(uiLang, 'Silmək üçün link seçin.', 'Silmek için link seçin.', 'Select a link to delete.')
    });
  }

  const MAX_DELETE_SHORTS = 100;
  if (valid.length > MAX_DELETE_SHORTS) {
    return res.status(400).json({
      error: pickLang(uiLang, `Bir dəfəyə maksimum ${MAX_DELETE_SHORTS} link silinə bilər.`, `Bir seferde en fazla ${MAX_DELETE_SHORTS} link silinebilir.`, `Maximum ${MAX_DELETE_SHORTS} links can be deleted at once.`)
    });
  }

  const placeholders = valid.map(() => '?').join(',');
  db.all(
    `SELECT short, original, domain_host FROM urls WHERE ${WORKSPACE_LINK_MUTATION_SQL} AND short IN (${placeholders})`,
    [req.session.userId, req.session.userId, ...valid],
    (findErr, foundRows) => {
      if (findErr) return res.status(500).json({ error: 'Server error.' });

      db.run(
        `DELETE FROM urls WHERE ${WORKSPACE_LINK_MUTATION_SQL} AND short IN (${placeholders})`,
        [req.session.userId, req.session.userId, ...valid],
        function (err) {
          if (err) return res.status(500).json({ error: 'Server error.' });

          const deletedRows = Array.isArray(foundRows) ? foundRows : [];
          deletedRows.forEach((row) => {
            const shortCode = (row && row.short) ? row.short : '';
            if (!shortCode) return;
            const shortUrl = buildShortUrl(req, shortCode, row.domain_host || '');
            void enqueueWebhookEventForUser(req.session.userId, 'link.deleted', {
              short: shortCode,
              short_url: shortUrl,
              original_url: row.original || '',
              domain: normalizeHostName(row.domain_host || '') || null,
              deleted_at: new Date().toISOString(),
            });
          });

          return res.json({ deleted: this.changes || 0 });
        }
      );
    }
  );
});


// KULLANICI LINK HEDEFİ GÜNCELLEME (POST /api/user/link/update)
router.post('/api/user/link/update', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const short = normalizeShortCode(req.body && req.body.short);
  const originalAbs = ensureAbsoluteUrl(req.body && req.body.original);

  if (!short || !originalAbs) {
    return res.status(400).json({
      error: pickLang(uiLang, 'Düzgün qısa kod və URL daxil edin.', 'Geçerli kısa kod ve URL girin.', 'Enter a valid short code and URL.')
    });
  }

  db.get(`SELECT short, original, domain_host FROM urls WHERE short = ? AND ${WORKSPACE_LINK_MUTATION_SQL}`, [short, req.session.userId, req.session.userId], (findErr, currentRow) => {
    if (findErr) return res.status(500).json({ error: 'Server error.' });
    if (!currentRow) {
      return res.status(404).json({ error: pickLang(uiLang, 'Link tapılmadı.', 'Link bulunamadı.', 'Link not found.') });
    }

    let hostname = '';
    try { hostname = new URL(originalAbs).hostname.toLowerCase(); } catch { hostname = ''; }

    const updateRow = () => {
      db.run(
        `UPDATE urls SET original = ? WHERE short = ? AND ${WORKSPACE_LINK_MUTATION_SQL}`,
        [originalAbs, short, req.session.userId, req.session.userId],
        function (err) {
          if (err) {
            return res.status(500).json({ error: pickLang(uiLang, 'Link yenilənə bilmədi.', 'Link güncellenemedi.', 'Link could not be updated.') });
          }
          if ((this.changes || 0) === 0) {
            return res.status(404).json({ error: pickLang(uiLang, 'Link tapılmadı.', 'Link bulunamadı.', 'Link not found.') });
          }

          const shortUrl = buildShortUrl(req, short, currentRow.domain_host || '');
          void enqueueWebhookEventForUser(req.session.userId, 'link.updated', {
            short,
            short_url: shortUrl,
            original_url: originalAbs,
            previous_original_url: currentRow.original || '',
            domain: normalizeHostName(currentRow.domain_host || '') || null,
            updated_at: new Date().toISOString(),
          });

          scanUrlAsync(short, originalAbs, req.session.userId);

          return res.json({ message: pickLang(uiLang, 'Link hədəfi yeniləndi.', 'Link hedefi güncellendi.', 'Link destination updated.') });
        }
      );
    };

    if (!hostname) return updateRow();

    db.get(
      "SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1",
      [hostname, hostname],
      (err, row) => {
        if (err) return res.status(500).json({ error: 'Server error.' });
        if (row) {
          return res.status(403).json({
            error: pickLang(uiLang, 'Bu domen bloklanıb.', 'Bu alan adı engellendi.', 'This domain is blocked.')
          });
        }
        return updateRow();
      }
    );
  });
});

// KULLANICI LINK METADATA GÜNCELLEME (POST /api/user/link/meta)
router.post('/api/user/link/meta', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const short = normalizeShortCode(req.body && req.body.short);
  if (!short) {
    return res.status(400).json({
      error: pickLang(uiLang, 'Yanlış qısa kod.', 'Geçersiz kısa kod.', 'Invalid short code.')
    });
  }

  const folderName = normalizeFolderName(req.body && req.body.folder_name);
  const tags = normalizeTagsInput(req.body && req.body.tags);
  const tagsJson = tags.length ? JSON.stringify(tags) : null;

  db.get(
    `SELECT short, original, domain_host, folder_name, tags_json FROM urls WHERE short = ? AND ${WORKSPACE_LINK_MUTATION_SQL}`,
    [short, req.session.userId, req.session.userId],
    (findErr, currentRow) => {
      if (findErr) {
        return res.status(500).json({ error: pickLang(uiLang, 'Metadata yenilənmədi.', 'Metadata güncellenemedi.', 'Metadata could not be updated.') });
      }
      if (!currentRow) {
        return res.status(404).json({ error: pickLang(uiLang, 'Link tapılmadı.', 'Link bulunamadı.', 'Link not found.') });
      }

      db.run(
        `UPDATE urls SET folder_name = ?, tags_json = ? WHERE short = ? AND ${WORKSPACE_LINK_MUTATION_SQL}`,
        [folderName || null, tagsJson, short, req.session.userId, req.session.userId],
        function (err) {
          if (err) {
            return res.status(500).json({ error: pickLang(uiLang, 'Metadata yenilənmədi.', 'Metadata güncellenemedi.', 'Metadata could not be updated.') });
          }
          if ((this.changes || 0) === 0) {
            return res.status(404).json({ error: pickLang(uiLang, 'Link tapılmadı.', 'Link bulunamadı.', 'Link not found.') });
          }

          const shortUrl = buildShortUrl(req, short, currentRow.domain_host || '');
          let previousTagsRaw = [];
          try {
            previousTagsRaw = currentRow.tags_json ? JSON.parse(currentRow.tags_json) : [];
          } catch {
            previousTagsRaw = [];
          }
          void enqueueWebhookEventForUser(req.session.userId, 'link.updated', {
            short,
            short_url: shortUrl,
            original_url: currentRow.original || '',
            domain: normalizeHostName(currentRow.domain_host || '') || null,
            folder_name: folderName || null,
            tags,
            previous_folder_name: currentRow.folder_name || null,
            previous_tags: normalizeTagsInput(previousTagsRaw),
            updated_at: new Date().toISOString(),
            update_kind: 'metadata',
          });

          return res.json({
            message: pickLang(uiLang, 'Link məlumatları yeniləndi.', 'Link bilgileri güncellendi.', 'Link metadata updated.'),
            folder_name: folderName,
            tags,
          });
        }
      );
    }
  );
});

// KULLANICI LINK EXPORT (GET /api/user/export?format=csv)
router.get('/api/user/export', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  db.all(
    `SELECT
      u.id,
      u.short,
      u.original,
      u.created_at,
      u.reports,
      u.link_password,
      u.expires_at,
      u.max_clicks,
      u.domain_host,
      u.folder_name,
      u.tags_json,
      COUNT(c.id) AS total_clicks
     FROM urls u
     LEFT JOIN clicks c ON c.url_id = u.id
     WHERE u.user_id = ?
     GROUP BY u.id
     ORDER BY u.created_at DESC`,
    [req.session.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Export failed.' });

      const exportRows = (rows || []).map((row) => {
        const tags = parseTagsJson(row.tags_json).join(', ');
        return {
          short_code: row.short || '',
          short_url: buildShortUrl(req, row.short || '', row.domain_host || ''),
          original_url: row.original || '',
          folder: row.folder_name || '',
          tags,
          reports: Number(row.reports || 0),
          total_clicks: Number(row.total_clicks || 0),
          max_clicks: row.max_clicks == null ? '' : Number(row.max_clicks),
          expires_at: row.expires_at || '',
          has_password: row.link_password ? 'yes' : 'no',
          custom_domain: row.domain_host || '',
          created_at: row.created_at || '',
        };
      });

      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const baseFile = `ovlink-links-${stamp}`;

      const columns = [
        'short_code',
        'short_url',
        'original_url',
        'folder',
        'tags',
        'reports',
        'total_clicks',
        'max_clicks',
        'expires_at',
        'has_password',
        'custom_domain',
        'created_at',
      ];

      const lines = [columns.map(escapeCsvCell).join(',')];
      exportRows.forEach((row) => {
        lines.push(columns.map((col) => escapeCsvCell(row[col])).join(','));
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${baseFile}.csv"`);
      return res.send('\uFEFF' + lines.join('\n'));
    }
  );
});

// KULLANICI TOPLU LINK IMPORT (POST /api/user/import)
router.post('/api/user/import',
  shortenLimiter,
  (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const rawRows = (req.body && req.body.rows || '').toString();
  const lines = rawRows.split(/\r?\n/).map(v => v.trim()).filter(Boolean);

  if (!lines.length) {
    return res.status(400).json({
      error: pickLang(uiLang, 'Import üçün ən az bir URL daxil edin.', 'İçe aktarma için en az bir URL girin.', 'Enter at least one URL to import.')
    });
  }

  const candidates = lines.map(extractImportUrlCandidate).filter(Boolean);
  const urls = Array.from(new Set(candidates));

  if (!urls.length) {
    return res.status(400).json({
      error: pickLang(uiLang, 'Etibarlı URL tapılmadı.', 'Geçerli URL bulunamadı.', 'No valid URL found.')
    });
  }

  db.get('SELECT plan_tier, plan_status, pro_expires_at FROM users WHERE id = ?', [req.session.userId], (uErr, userRow) => {
    const isPro = isProAccessActive(userRow);
    const maxBulk = isPro ? 50 : 5;
    const dailyLimit = isPro ? 500 : 50;

    if (urls.length > maxBulk) {
      return res.status(400).json({
        error: pickLang(
          uiLang,
          `Bir dəfəyə maksimum ${maxBulk} URL idxal edə bilərsiniz.${!isPro ? ' (Pro plana keçərək 50-yə qaldırın)' : ''}`,
          `Bir seferde en fazla ${maxBulk} URL içe aktarabilirsiniz.${!isPro ? ' (Pro plana geçerek 50\'ye yükseltin)' : ''}`,
          `You can import at most ${maxBulk} URLs at once.${!isPro ? ' (Upgrade to Pro for 50)' : ''}`
        )
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    db.get('SELECT COUNT(*) as count FROM urls WHERE user_id = ? AND created_at >= ?', [req.session.userId, today], (dErr, dRow) => {
      const todayCount = Number(dRow && dRow.count || 0);
      if (todayCount + urls.length > dailyLimit) {
        return res.status(400).json({
          error: pickLang(
            uiLang,
            `Gündəlik limitiniz (${dailyLimit} link) dolmaq üzrədir. Bu gün istifadə edilən: ${todayCount}/${dailyLimit}.`,
            `Günlük limitiniz (${dailyLimit} link) dolmak üzere. Bugün kullanılan: ${todayCount}/${dailyLimit}.`,
            `Daily limit (${dailyLimit} links) reached. Used today: ${todayCount}/${dailyLimit}.`
          )
        });
      }

      let created = 0;
      let blocked = 0;
      let skipped = 0;
      const createdLinks = [];

      const createAndInsert = (originalAbs, done, retry = 0) => {
        if (retry > 7) {
          skipped += 1;
          return done();
        }

        const short = generateSafeShortCode();
        const createdAt = new Date().toISOString();

        db.run(
          'INSERT INTO urls (original, short, created_at, user_id, link_password, expires_at, max_clicks, domain_host) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [originalAbs, short, createdAt, req.session.userId, '', null, null, null],
          function (err) {
            if (!err) {
              created += 1;
              createdLinks.push({
                short,
                shortUrl: buildShortUrl(req, short, ''),
                original: originalAbs,
              });
              return done();
            }
            const msg = (err && err.message || '').toLowerCase();
            if (msg.includes('unique') && msg.includes('urls.short')) {
              return createAndInsert(originalAbs, done, retry + 1);
            }
            skipped += 1;
            return done();
          }
        );
      };

      const processAt = (index) => {
        if (index >= urls.length) {
          return res.json({
            created,
            blocked,
            skipped,
            total: urls.length,
            created_links: createdLinks,
            message: pickLang(
              uiLang,
              `Import tamamlandı. Yaradıldı: ${created}, bloklandı: ${blocked}, keçildi: ${skipped}.`,
              `İçe aktarma tamamlandı. Oluşturulan: ${created}, engellenen: ${blocked}, atlanan: ${skipped}.`,
              `Import completed. Created: ${created}, blocked: ${blocked}, skipped: ${skipped}.`
            )
          });
        }

        const originalAbs = urls[index];
        let hostname = '';
        try { hostname = new URL(originalAbs).hostname.toLowerCase(); } catch { hostname = ''; }

        if (!hostname) {
          skipped += 1;
          return processAt(index + 1);
        }

        db.get(
          'SELECT 1 FROM blocked_domains WHERE domain = ? OR domain = ?',
          [hostname, `.${hostname}`],
          (bErr, bRow) => {
            if (bRow) {
              blocked += 1;
              return processAt(index + 1);
            }

            createAndInsert(originalAbs, () => processAt(index + 1));
          }
        );
      };

      processAt(0);
    });
  });
});


// Kullanıcı Dashboard (GET /dashboard)
/* =========================================================
   WORKSPACE (PRO) — pages, API and SAML SSO endpoints
   ========================================================= */

module.exports = router;
