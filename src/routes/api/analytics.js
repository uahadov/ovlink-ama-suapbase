const express = require('express');
const router = express.Router();

const { db } = require('../../db/index');
const { dbGetAsync, dbAllAsync, dbRunAsync } = require('../../db/helpers');
const { normalizeShortCode } = require('../../lib/url-helpers');
const { REDIRECT_CONSENT_MARKER, getRedirectConsentMode } = require('../../lib/consent');
const { getPublicBaseUrl } = require('../../lib/security');
const linkStats = require('../../lib/link-stats');
const anomalyAlerts = require('../../lib/anomaly-alerts');
const funnelLib = require('../../lib/funnel');
const visitorSplit = require('../../lib/visitor-split');
const abSignificance = require('../../lib/ab-significance');
const alertThresholds = require('../../lib/alert-thresholds');
const analyticsAudit = require('../../lib/analytics-audit');
const { recordConversion } = require('../../lib/analytics');
const { statsPageInlineJs } = require('../../lib/stats-page-assets');
const { WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL } = require('../../lib/link-access');
const crypto = require('crypto');

// 1x1 transparent GIF returned by the conversion pixel.
const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const URL_ROW_COLUMNS = 'id, short, original, created_at, max_clicks, disabled, user_id, workspace_id';

async function loadOwnedUrl(req, rawShort) {
  const requested = Array.isArray(rawShort) ? rawShort[0] : rawShort;
  const short = normalizeShortCode(requested);
  if (!short) return { error: 'invalid_short' };

  const url = await dbGetAsync(
    `SELECT ${URL_ROW_COLUMNS} FROM urls WHERE short = ? AND ${WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL}`,
    [short, req.session.userId, req.session.userId]
  ).catch(() => null);

  if (!url) return { error: 'not_found' };
  return { url };
}

function sendExport(res, url, rows, format) {
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    return res.json({
      short: url.short,
      original: url.original,
      exported_at: new Date().toISOString(),
      count: rows.length,
      clicks: rows,
    });
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ovlink-clicks-${url.short}-${stamp}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.send(linkStats.buildClicksCsv(rows));
}

function parseExportFormat(rawFormat) {
  return (rawFormat || '').toString().trim().toLowerCase() === 'json' ? 'json' : 'csv';
}

async function handleStatsRequest(req, res, rawShort) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Giriş gerekli.' });

  const loaded = await loadOwnedUrl(req, rawShort);
  if (loaded.error === 'invalid_short') return res.status(400).json({ error: 'Geçersiz kısa kod.' });
  if (loaded.error) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });

  try {
    const payload = await linkStats.loadLinkStats({
      urlRow: loaded.url,
      query: req.query && typeof req.query === 'object' ? req.query : {},
    });
    analyticsAudit.recordAnalyticsAccess({
      userId: req.session.userId,
      urlId: loaded.url.id,
      short: loaded.url.short,
      action: analyticsAudit.AUDIT_ACTIONS.VIEW,
      req,
    });
    return res.json(payload);
  } catch {
    return res.status(500).json({ error: 'Veri alınamadı.' });
  }
}

// GET /c/:short.gif?goal=signup — conversion pixel for the destination page.
// Always answers 200 with the GIF so probing this path reveals nothing.
router.get(['/c/:short.gif', '/c/:short'], async (req, res) => {
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Robots-Tag', 'noindex,nofollow');

  const short = normalizeShortCode(req.params && req.params.short);
  if (short) {
    try {
      const row = await dbGetAsync('SELECT id FROM urls WHERE short = ? LIMIT 1', [short]);
      if (row && row.id) {
        // Fire-and-forget: the visitor must get the pixel instantly.
        void recordConversion({
          urlId: row.id,
          goal: req.query && req.query.goal,
          step: req.query && req.query.step,
          req,
          consentMode: getRedirectConsentMode(req),
        }).catch(() => {});
      }
    } catch {
      // never surface pixel errors
    }
  }

  return res.status(200).send(TRANSPARENT_GIF);
});

// ---------------------------------------------------------------------------
// Read-only statistics shares (client-facing report links + embeds)
// ---------------------------------------------------------------------------
const SHARE_ALLOWED_DAYS = new Set([7, 30, 90, 365]);

function hashShareToken(rawToken) {
  return crypto.createHash('sha256').update((rawToken || '').toString()).digest('hex');
}

function normalizeShareDays(rawDays) {
  const value = Number.parseInt(rawDays, 10);
  return SHARE_ALLOWED_DAYS.has(value) ? value : 30;
}

/** Returns the share row joined with its link, or null when unusable. */
async function loadActiveShare(rawToken) {
  const token = (rawToken || '').toString().trim();
  if (!token || token.length < 20 || token.length > 200) return null;

  const row = await dbGetAsync(
    'SELECT s.id, s.url_id, s.days, s.expires_at, s.revoked_at, u.short, u.original, u.created_at, ' +
      'u.max_clicks, u.disabled FROM stats_shares s JOIN urls u ON u.id = s.url_id ' +
      'WHERE s.token_hash = ? LIMIT 1',
    [hashShareToken(token)]
  ).catch(() => null);

  if (!row || row.revoked_at) return null;
  const expiresMs = Date.parse(row.expires_at || '');
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) return null;
  return row;
}

/** The share row carries the share id, so map it onto a url row for the service. */
function shareToUrlRow(share) {
  return {
    id: share.url_id,
    short: share.short,
    original: share.original,
    created_at: share.created_at,
    max_clicks: share.max_clicks,
    disabled: share.disabled,
  };
}

function buildShareUrls(req, short, token) {
  const base = getPublicBaseUrl(req);
  const encodedShort = encodeURIComponent(short);
  const query = `token=${encodeURIComponent(token)}`;
  const pageUrl = `${base}/stats/shared/${encodedShort}?${query}`;
  const embedUrl = `${base}/embed/${encodedShort}?${query}`;
  return {
    url: pageUrl,
    api_url: `${base}/api/stats/shared/${encodedShort}?${query}`,
    embed_url: embedUrl,
    embed_code: `<iframe src="${embedUrl}" width="320" height="150" style="border:0;border-radius:14px;background:transparent" loading="lazy" title="Ovlink stats"></iframe>`,
  };
}

function shareMatchesShort(req, share) {
  const requested = normalizeShortCode(req.params && req.params.short);
  return !!requested && requested === share.short;
}

// POST /api/stats/:short/share { days } -> create an expiring read-only link.
router.post('/api/stats/:short/share', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Giriş gerekli.' });

  const loaded = await loadOwnedUrl(req, req.params.short);
  if (loaded.error === 'invalid_short') return res.status(400).json({ error: 'Geçersiz kısa kod.' });
  if (loaded.error) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });

  try {
    const days = normalizeShareDays(req.body && req.body.days);
    const token = crypto.randomBytes(24).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

    const inserted = await dbRunAsync(
      'INSERT INTO stats_shares (url_id, token_hash, days, expires_at, created_at, created_by_user_id) ' +
        'VALUES (?, ?, ?, ?, ?, ?)',
      [loaded.url.id, hashShareToken(token), days, expiresAt, now.toISOString(), req.session.userId]
    );

    analyticsAudit.recordAnalyticsAccess({
      userId: req.session.userId,
      urlId: loaded.url.id,
      short: loaded.url.short,
      action: analyticsAudit.AUDIT_ACTIONS.SHARE_CREATE,
      req,
      metadata: { days },
    });
    return res.json({
      id: inserted && inserted.lastID ? inserted.lastID : null,
      ...buildShareUrls(req, loaded.url.short, token),
      short: loaded.url.short,
      days,
      expires_at: expiresAt,
    });
  } catch {
    return res.status(500).json({ error: 'Paylaşım linki yaradıla bilmədi.' });
  }
});

// GET /api/stats/:short/shares -> list active/expired shares
router.get('/api/stats/:short/shares', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Giriş gerekli.' });

  const loaded = await loadOwnedUrl(req, req.params.short);
  if (loaded.error === 'invalid_short') return res.status(400).json({ error: 'Geçersiz kısa kod.' });
  if (loaded.error) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });

  const rows = await dbAllAsync(
    'SELECT id, days, created_at, expires_at, revoked_at FROM stats_shares WHERE url_id = ? ORDER BY id DESC LIMIT 50',
    [loaded.url.id]
  ).catch(() => []);

  return res.json({ shares: rows || [] });
});

// POST /api/stats/:short/share/revoke { id } -> cut a shared link immediately.
router.post('/api/stats/:short/share/revoke', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Giriş gerekli.' });

  const loaded = await loadOwnedUrl(req, req.params.short);
  if (loaded.error === 'invalid_short') return res.status(400).json({ error: 'Geçersiz kısa kod.' });
  if (loaded.error) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });

  const shareId = Number.parseInt(req.body && req.body.id, 10);
  if (!Number.isInteger(shareId) || shareId <= 0) return res.status(400).json({ error: 'Geçersiz paylaşım ID.' });

  const result = await dbRunAsync(
    'UPDATE stats_shares SET revoked_at = ? WHERE id = ? AND url_id = ? AND revoked_at IS NULL',
    [new Date().toISOString(), shareId, loaded.url.id]
  ).catch(() => null);

  if (!result || !result.changes) return res.status(404).json({ error: 'Paylaşım tapılmadı.' });
  analyticsAudit.recordAnalyticsAccess({
    userId: req.session.userId,
    urlId: loaded.url.id,
    short: loaded.url.short,
    action: analyticsAudit.AUDIT_ACTIONS.SHARE_REVOKE,
    req,
    metadata: { share_id: shareId },
  });
  return res.json({ revoked: true });
});

// GET /api/stats/shared/:short?token=... -> public, read-only payload.
router.get('/api/stats/shared/:short', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  const share = await loadActiveShare(req.query && req.query.token);
  if (!share || !shareMatchesShort(req, share)) {
    return res.status(404).json({ error: 'Bu statistika linki etibarsızdır.' });
  }

  try {
    const payload = await linkStats.loadLinkStats({
      urlRow: shareToUrlRow(share),
      query: { days: share.days, bots: req.query && req.query.bots },
    });
    analyticsAudit.recordAnalyticsAccess({
      urlId: share.url_id,
      short: share.short,
      action: analyticsAudit.AUDIT_ACTIONS.SHARED_VIEW,
      req,
      metadata: { days: share.days, kind: 'api' },
    });
    return res.json(linkStats.toPublicPayload(payload));
  } catch {
    return res.status(500).json({ error: 'Veri alınamadı.' });
  }
});

// GET /stats/shared/:short?token=... -> public report page.
router.get('/stats/shared/:short', async (req, res) => {
  const share = await loadActiveShare(req.query && req.query.token);
  if (!share || !shareMatchesShort(req, share)) {
    return res.status(404).type('text/plain').send('Bu statistika linki etibarsızdır və ya vaxtı bitib.');
  }

  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('X-Robots-Tag', 'noindex,nofollow');

  analyticsAudit.recordAnalyticsAccess({
    urlId: share.url_id,
    short: share.short,
    action: analyticsAudit.AUDIT_ACTIONS.SHARED_VIEW,
    req,
    metadata: { days: share.days, kind: 'page' },
  });

  return res.render('stats-shared', {
    csrfToken: res.locals._csrf,
    nonce: res.locals.nonce,
    assetVersion: res.locals.assetVersion,
    defaultLang: res.locals.defaultLang,
    shortCode: share.short,
    originalUrl: share.original || '',
    token: (req.query && req.query.token) || '',
    days: share.days,
    expiresAt: share.expires_at,
  });
});

// GET /embed/:short?token=... -> server-rendered card that any site can iframe.
router.get('/embed/:short', async (req, res) => {
  const share = await loadActiveShare(req.query && req.query.token);
  if (!share || !shareMatchesShort(req, share)) {
    return res.status(404).type('text/plain').send('expired');
  }

  let payload = null;
  try {
    payload = await linkStats.loadLinkStats({
      urlRow: shareToUrlRow(share),
      query: { days: share.days },
    });
  } catch {
    payload = null;
  }

  // The widget must be embeddable on third-party sites, so relax framing for
  // this route only (helmet already set its own CSP/headers above).
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors *");
  res.set('X-Frame-Options', 'ALLOWALL');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'private, max-age=300');
  res.set('X-Robots-Tag', 'noindex,nofollow');

  analyticsAudit.recordAnalyticsAccess({
    urlId: share.url_id,
    short: share.short,
    action: analyticsAudit.AUDIT_ACTIONS.EMBED_VIEW,
    req,
    metadata: { days: share.days },
  });

  return res.render('embed-stats', {
    shortCode: share.short,
    clicks: payload ? Number(payload.total_clicks || 0) : 0,
    uniques: payload ? Number(payload.unique_visitors || 0) : 0,
    conversions: payload ? Number(payload.conversions_range || 0) : 0,
    rate: payload ? Number(payload.conversion_rate || 0) : 0,
    days: share.days,
  });
});

// GET /api/stats/:short/export?format=csv|json&days=&bots=
// Click-level export for BI tools / spreadsheets.
router.get('/api/stats/:short/export', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Giriş gerekli.' });

  const loaded = await loadOwnedUrl(req, req.params.short);
  if (loaded.error === 'invalid_short') return res.status(400).json({ error: 'Geçersiz kısa kod.' });
  if (loaded.error) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });

  try {
    const rows = await linkStats.loadRawClicks({
      urlId: loaded.url.id,
      query: req.query && typeof req.query === 'object' ? req.query : {},
    });
    const format = parseExportFormat(req.query && req.query.format);
    analyticsAudit.recordAnalyticsAccess({
      userId: req.session.userId,
      urlId: loaded.url.id,
      short: loaded.url.short,
      action: analyticsAudit.AUDIT_ACTIONS.EXPORT,
      req,
      metadata: { format },
    });
    return sendExport(res, loaded.url, rows, format);
  } catch {
    return res.status(500).json({ error: 'Dışa aktarma başarısız.' });
  }
});

// GET /api/stats/:short/anomalies?days=30
// Read-only view of the spike/drop detector plus the last destination health
// probe. The background worker is what actually notifies; this endpoint never
// writes anything.
router.get('/api/stats/:short/anomalies', async (req, res) => {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Giriş gerekli.' });

  const loaded = await loadOwnedUrl(req, req.params.short);
  if (loaded.error === 'invalid_short') return res.status(400).json({ error: 'Geçersiz kısa kod.' });
  if (loaded.error) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });

  try {
    const insights = await anomalyAlerts.loadLinkAnomalyInsights(loaded.url.id, {
      days: req.query && req.query.days,
    });
    const health = await dbGetAsync(
      'SELECT last_health_status, last_health_checked_at, last_health_error FROM urls WHERE id = ?',
      [loaded.url.id]
    ).catch(() => null);

    return res.json({
      ...insights,
      destination: {
        status: health && Number(health.last_health_status) > 0 ? Number(health.last_health_status) : null,
        checked_at: (health && health.last_health_checked_at) || null,
        error: (health && health.last_health_error) || null,
      },
    });
  } catch {
    return res.status(500).json({ error: 'Veri alınamadı.' });
  }
});

// ---------------------------------------------------------------------------
// Analytics v2 insights (funnel, visitors, A/B significance, live feed)
// Each endpoint is read-only and separate from /api/stats so the shared/embed
// payload shape cannot regress.
// ---------------------------------------------------------------------------
function resolveInsightRange(query) {
  const range = linkStats.parseRange(query && (query.days || query.range));
  const now = new Date();
  const days = range.all ? 365 : range.days;
  return {
    range,
    now,
    days,
    startDay: linkStats.isoDay(linkStats.addDays(now, -(days - 1))),
  };
}

function requireSession(res, req) {
  if (!req.session || !req.session.userId) {
    res.status(401).json({ error: 'Giriş gerekli.' });
    return false;
  }
  return true;
}

// GET /api/stats/:short/funnel?days=30
router.get('/api/stats/:short/funnel', async (req, res) => {
  if (!requireSession(res, req)) return;
  const loaded = await loadOwnedUrl(req, req.params.short);
  if (loaded.error === 'invalid_short') return res.status(400).json({ error: 'Geçersiz kısa kod.' });
  if (loaded.error) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });

  const { days, startDay } = resolveInsightRange(req.query);
  try {
    const [counts, split] = await Promise.all([
      funnelLib.loadFunnelCounts({ urlId: loaded.url.id, startDay }),
      visitorSplit.loadVisitorSplit({ urlId: loaded.url.id, startDay }),
    ]);
    // Fall back to step-1 traffic when the link has no visitor hashes (legacy
    // rows or essential-only consent), otherwise every step would read as 0%.
    const base = split.available
      ? split.visitors
      : (counts.length ? Number(counts[0].visitors || 0) : 0);
    const countMap = new Map();
    counts.forEach((row) => countMap.set(row.step, row.visitors));

    return res.json({
      short: loaded.url.short,
      days,
      source: 'pixel',
      available: counts.length > 0,
      visitors_available: split.available,
      base,
      steps: funnelLib.buildFunnelSeries({ baseVisitors: base, counts: countMap }),
      hint: `/c/${loaded.url.short}.gif?goal=signup&step=1`,
    });
  } catch {
    return res.status(500).json({ error: 'Veri alınamadı.' });
  }
});

// GET /api/stats/:short/visitors?days=30
router.get('/api/stats/:short/visitors', async (req, res) => {
  if (!requireSession(res, req)) return;
  const loaded = await loadOwnedUrl(req, req.params.short);
  if (loaded.error === 'invalid_short') return res.status(400).json({ error: 'Geçersiz kısa kod.' });
  if (loaded.error) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });

  const { days, startDay } = resolveInsightRange(req.query);
  try {
    const split = await visitorSplit.loadVisitorSplit({ urlId: loaded.url.id, startDay });
    return res.json({ short: loaded.url.short, days, ...split });
  } catch {
    return res.status(500).json({ error: 'Veri alınamadı.' });
  }
});

// GET /api/stats/:short/ab-significance?days=30
router.get('/api/stats/:short/ab-significance', async (req, res) => {
  if (!requireSession(res, req)) return;
  const loaded = await loadOwnedUrl(req, req.params.short);
  if (loaded.error === 'invalid_short') return res.status(400).json({ error: 'Geçersiz kısa kod.' });
  if (loaded.error) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });

  const { days, startDay } = resolveInsightRange(req.query);
  // Time-range comparison keeps idx_clicks_url_time usable; SUBSTR() would
  // force a full scan of the link's clicks.
  const rangeStartIso = `${startDay}T00:00:00.000Z`;
  try {
    const [clickRows, conversionRows] = await Promise.all([
      dbAllAsync(
        "SELECT variant AS name, COUNT(*) AS count FROM clicks WHERE url_id = ? " +
          "AND click_time >= ? AND COALESCE(is_bot, 0) = 0 AND variant IN ('a', 'b') GROUP BY variant",
        [loaded.url.id, rangeStartIso]
      ).catch(() => []),
      dbAllAsync(
        "SELECT variant AS name, COUNT(*) AS count FROM link_conversions WHERE url_id = ? " +
          "AND day >= ? AND variant IN ('a', 'b') GROUP BY variant",
        [loaded.url.id, startDay]
      ).catch(() => []),
    ]);

    const toMap = (rows) => {
      const map = {};
      (rows || []).forEach((row) => {
        const key = (row.name || '').toString().toLowerCase();
        if (key === 'a' || key === 'b') map[key] = Number(row.count || 0);
      });
      return map;
    };
    const clicksByVariant = toMap(clickRows);
    const conversionsByVariant = toMap(conversionRows);

    const summary = abSignificance.summarizeAbTest({
      aClicks: clicksByVariant.a || 0,
      bClicks: clicksByVariant.b || 0,
      aConversions: conversionsByVariant.a || 0,
      bConversions: conversionsByVariant.b || 0,
    });

    return res.json({ short: loaded.url.short, days, ...summary });
  } catch {
    return res.status(500).json({ error: 'Veri alınamadı.' });
  }
});

function mapLiveClick(row) {
  const marker = REDIRECT_CONSENT_MARKER;
  const clean = (value, fallback) => {
    if (!value) return fallback;
    return value === marker ? '' : value.toString();
  };
  return {
    id: Number(row.id),
    time: row.click_time || '',
    browser: clean(row.browser, 'Unknown') || 'Unknown',
    os: clean(row.os, 'Unknown') || 'Unknown',
    country: clean(row.country, ''),
    device_type: clean(row.device_type, ''),
    is_bot: Number(row.is_bot || 0) === 1,
  };
}

// GET /api/stats/:short/live?after_id=0&limit=25
// Polling feed: the newest rows after a cursor, never the visitor hash.
router.get('/api/stats/:short/live', async (req, res) => {
  if (!requireSession(res, req)) return;
  const loaded = await loadOwnedUrl(req, req.params.short);
  if (loaded.error === 'invalid_short') return res.status(400).json({ error: 'Geçersiz kısa kod.' });
  if (loaded.error) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });

  const afterId = Number.parseInt(req.query && req.query.after_id, 10);
  const limitInput = Number.parseInt(req.query && req.query.limit, 10);
  const limit = Number.isInteger(limitInput) ? Math.min(100, Math.max(1, limitInput)) : 25;

  try {
    const rows = await dbAllAsync(
      'SELECT id, click_time, browser, os, country, device_type, is_bot FROM clicks ' +
        'WHERE url_id = ? AND id > ? ORDER BY id DESC LIMIT ?',
      [loaded.url.id, Number.isInteger(afterId) && afterId > 0 ? afterId : 0, limit]
    ).catch(() => []);

    const clicks = (rows || []).map(mapLiveClick);
    const nextAfterId = clicks.length ? clicks[0].id : (Number.isInteger(afterId) && afterId > 0 ? afterId : 0);

    return res.json({
      short: loaded.url.short,
      generated_at: new Date().toISOString(),
      clicks,
      next_after_id: nextAfterId,
    });
  } catch {
    return res.status(500).json({ error: 'Veri alınamadı.' });
  }
});

// ---------------------------------------------------------------------------
// F3: alert thresholds (user defaults + per-link overrides)
// ---------------------------------------------------------------------------
function buildThresholdPayload(userRow, linkRow) {
  const cfg = anomalyAlerts.buildSettings();
  return {
    baseline_days: cfg.baselineDays,
    settings: alertThresholds.describeThresholds(cfg, userRow, linkRow),
  };
}

router.get('/api/user/alert-thresholds', async (req, res) => {
  if (!requireSession(res, req)) return;
  try {
    const userRow = await alertThresholds.loadUserAlertOverrides(req.session.userId);
    return res.json(buildThresholdPayload(userRow, null));
  } catch {
    return res.status(500).json({ error: 'Ayarlar yüklənmədi.' });
  }
});

router.patch('/api/user/alert-thresholds', async (req, res) => {
  if (!requireSession(res, req)) return;
  const sanitized = alertThresholds.sanitizeThresholds(req.body);
  if (!Object.keys(sanitized.provided).length) {
    return res.status(400).json({ error: 'Heç bir sahə göndərilmədi.' });
  }

  try {
    const current = await alertThresholds.loadUserAlertOverrides(req.session.userId);
    const merged = {};
    for (const [field, definition] of Object.entries(alertThresholds.ALERT_FIELDS)) {
      const columnValue = current ? current[definition.column] : null;
      merged[definition.setting] = sanitized.provided[field]
        ? sanitized.values[field]
        : (columnValue === null || columnValue === undefined ? null : columnValue);
    }
    const saved = await alertThresholds.saveUserAlertOverrides(req.session.userId, merged);
    return res.json({ ...buildThresholdPayload(saved, null), warnings: sanitized.errors });
  } catch {
    return res.status(500).json({ error: 'Ayarlar saxlanmadı.' });
  }
});

router.get('/api/stats/:short/alert-thresholds', async (req, res) => {
  if (!requireSession(res, req)) return;
  const loaded = await loadOwnedUrl(req, req.params.short);
  if (loaded.error === 'invalid_short') return res.status(400).json({ error: 'Geçersiz kısa kod.' });
  if (loaded.error) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });

  try {
    const userRow = await alertThresholds.loadUserAlertOverrides(req.session.userId);
    const linkRow = await alertThresholds.loadLinkAlertOverrides(loaded.url.id);
    return res.json({ short: loaded.url.short, ...buildThresholdPayload(userRow, linkRow) });
  } catch {
    return res.status(500).json({ error: 'Ayarlar yüklənmədi.' });
  }
});

router.patch('/api/stats/:short/alert-thresholds', async (req, res) => {
  if (!requireSession(res, req)) return;
  const loaded = await loadOwnedUrl(req, req.params.short);
  if (loaded.error === 'invalid_short') return res.status(400).json({ error: 'Geçersiz kısa kod.' });
  if (loaded.error) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });
  // Workspace members may read a shared link's thresholds, but only the link
  // owner may change the alerts that fire on their own account.
  if (Number(loaded.url.user_id) !== Number(req.session.userId)) {
    return res.status(403).json({ error: 'Bu ayarı yalnız link sahibi dəyişə bilər.' });
  }

  const sanitized = alertThresholds.sanitizeThresholds(req.body);
  if (!Object.keys(sanitized.provided).length) {
    return res.status(400).json({ error: 'Heç bir sahə göndərilmədi.' });
  }

  try {
    const current = await alertThresholds.loadLinkAlertOverrides(loaded.url.id);
    const values = {};
    for (const [field, definition] of Object.entries(alertThresholds.ALERT_FIELDS)) {
      const columnValue = current ? current[definition.column] : null;
      values[definition.setting] = sanitized.provided[field]
        ? sanitized.values[field]
        : (columnValue === null || columnValue === undefined ? null : columnValue);
    }
    const saved = await alertThresholds.saveLinkAlertOverrides(loaded.url.id, values);
    const userRow = await alertThresholds.loadUserAlertOverrides(req.session.userId);
    return res.json({ short: loaded.url.short, ...buildThresholdPayload(userRow, saved), warnings: sanitized.errors });
  } catch {
    return res.status(500).json({ error: 'Ayarlar saxlanmadı.' });
  }
});

router.delete('/api/stats/:short/alert-thresholds', async (req, res) => {
  if (!requireSession(res, req)) return;
  const loaded = await loadOwnedUrl(req, req.params.short);
  if (loaded.error === 'invalid_short') return res.status(400).json({ error: 'Geçersiz kısa kod.' });
  if (loaded.error) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });
  if (Number(loaded.url.user_id) !== Number(req.session.userId)) {
    return res.status(403).json({ error: 'Bu ayarı yalnız link sahibi sıfırlaya bilər.' });
  }

  try {
    await alertThresholds.clearLinkAlertOverrides(loaded.url.id);
    const userRow = await alertThresholds.loadUserAlertOverrides(req.session.userId);
    return res.json({ short: loaded.url.short, ...buildThresholdPayload(userRow, null) });
  } catch {
    return res.status(500).json({ error: 'Ayarlar sıfırlanmadı.' });
  }
});

// GET /api/stats/:short/audit?limit=50 - who looked at this report
router.get('/api/stats/:short/audit', async (req, res) => {
  if (!requireSession(res, req)) return;
  const loaded = await loadOwnedUrl(req, req.params.short);
  if (loaded.error === 'invalid_short') return res.status(400).json({ error: 'Geçersiz kısa kod.' });
  if (loaded.error) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });

  try {
    const entries = await analyticsAudit.listAuditEntries({
      urlId: loaded.url.id,
      limit: req.query && req.query.limit,
    });
    return res.json({ short: loaded.url.short, entries });
  } catch {
    return res.status(500).json({ error: 'Audit yüklənmədi.' });
  }
});

// GET /api/stats/:short (canonical) and GET /api/stats?short=... (legacy)
router.get('/api/stats/:short', (req, res) => {
  handleStatsRequest(req, res, req.params.short).catch(() => {
    if (!res.headersSent) res.status(500).json({ error: 'Veri alınamadı.' });
  });
});

router.get('/api/stats', (req, res) => {
  handleStatsRequest(req, res, req.query && req.query.short).catch(() => {
    if (!res.headersSent) res.status(500).json({ error: 'Veri alınamadı.' });
  });
});

// İstatistik Sayfası (GET /stats-page/:short)
router.get('/stats-page/:short', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  const short = normalizeShortCode(req.params.short);
  if (!short) return res.status(404).send('Link bulunamadı.');

  db.get(
    `SELECT user_id, workspace_id, original FROM urls WHERE short = ? AND ${WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL}`,
    [short, req.session.userId, req.session.userId],
    (err, row) => {
      if (err || !row) return res.status(404).send('Link bulunamadı.');
      if (row.user_id !== req.session.userId && !row.workspace_id) {
        return res.status(403).render('error-unauthorized', {
          csrfToken: res.locals._csrf,
          shortCode: short
        });
      }

      res.render('stats-page', {
        csrfToken: res.locals._csrf,
        shortCode: short,
        originalUrl: row.original || '',
        consentMarker: REDIRECT_CONSENT_MARKER,
        // null unless STATS_PAGE_INLINE_JS=1 (W4.4 rollback lever).
        statsPageInlineJs: statsPageInlineJs({
          shortCode: short,
          essentialMarker: REDIRECT_CONSENT_MARKER
        })
      });
    }
  );
});

module.exports = router;
module.exports.handleStatsRequest = handleStatsRequest;
module.exports.loadOwnedUrl = loadOwnedUrl;
module.exports.parseExportFormat = parseExportFormat;
module.exports.sendExport = sendExport;
// Backwards-compatible helpers (previously defined in this module).
module.exports.parseRange = linkStats.parseRange;
module.exports.parseBotsFilter = linkStats.parseBotsFilter;
module.exports.buildDaySeries = linkStats.buildDaySeries;
