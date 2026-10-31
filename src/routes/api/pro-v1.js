const express = require('express');
const path = require('path');
const router = express.Router();

const { dbAllAsync } = require('../../db/helpers');
const campaignLib = require('../../lib/campaigns');
const { API_KEY_SCOPES } = require('../../lib/security');
const { authenticateProApiKey, trackProApiUsage, requireApiScope } = require('../../middleware/auth');
const { proReadLimiter } = require('../../middleware/rate-limiter');
const { isoDay, addDays, parseRange } = require('../../lib/link-stats');
const analyticsAudit = require('../../lib/analytics-audit');

/**
 * Pro API v1 - new read endpoints.
 *
 * The three legacy v1 endpoints (account, shorten, links/:short/stats|clicks)
 * stay in links.js; this router only adds the list, campaign and OpenAPI
 * surfaces, and is mounted after ./links so the legacy paths keep winning.
 *
 * Scopes are intentionally reused (account:read): the allowed scope list in
 * lib/security.js is frozen, and adding a new scope is a separate, explicit
 * change.
 */

const LIST_DEFAULT_LIMIT = 25;
const LIST_MAX_LIMIT = 100;

const API_STACK = [
  authenticateProApiKey,
  trackProApiUsage,
  proReadLimiter,
  requireApiScope(API_KEY_SCOPES.ACCOUNT_READ),
];

function encodeCursor(row) {
  if (!row) return null;
  const createdAt = (row.created_at || '').toString();
  const id = Number.parseInt(row.id, 10);
  if (!createdAt || !Number.isInteger(id)) return null;
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

/** Decodes `<created_at>|<id>`; anything malformed yields null (400 for the caller). */
function decodeCursor(raw) {
  const text = (raw || '').toString().trim();
  if (!text || text.length > 200) return null;
  let decoded = '';
  try {
    decoded = Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.lastIndexOf('|');
  if (separator <= 0 || separator === decoded.length - 1) return null;
  const createdAt = decoded.slice(0, separator).trim();
  const id = Number.parseInt(decoded.slice(separator + 1), 10);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(createdAt)) return null;
  if (!Number.isInteger(id) || id <= 0) return null;
  return { createdAt, id };
}

function parseListQuery(query) {
  const q = query && typeof query === 'object' ? query : {};

  const limitInput = Number.parseInt(q.limit, 10);
  const limit = Number.isInteger(limitInput) ? Math.min(LIST_MAX_LIMIT, Math.max(1, limitInput)) : LIST_DEFAULT_LIMIT;

  const rawCursor = (q.cursor || '').toString().trim();
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) return { error: 'invalid_cursor' };

  const range = parseRange(q.days || 30);
  const startDay = range.all ? '1970-01-01' : isoDay(addDays(new Date(), -range.days));

  const campaignId = Number.parseInt(q.campaign_id, 10);
  const status = (q.status || '').toString().trim().toLowerCase();

  return {
    limit,
    cursor,
    startDay,
    campaignId: Number.isInteger(campaignId) && campaignId > 0 ? campaignId : null,
    // Keep the value index-friendly: only allowlist characters, no leading %.
    search: (q.q || '').toString().trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80),
    status: status === 'active' || status === 'disabled' ? status : '',
    days: range.all ? 'all' : range.days,
  };
}

// GET /api/pro/v1/links?limit&cursor&campaign_id&q&status&days
router.get('/api/pro/v1/links', ...API_STACK, async (req, res) => {
  const userId = req.apiAuth && Number.isInteger(req.apiAuth.userId) ? req.apiAuth.userId : 0;
  if (!userId) return res.status(401).json({ error: 'Unauthorized.' });

  const parsed = parseListQuery(req.query);
  if (parsed.error) return res.status(400).json({ error: 'Invalid cursor.' });

  const params = [userId, parsed.startDay, userId];
  let sql =
    'SELECT u.id, u.short, u.original, u.created_at, u.max_clicks, COALESCE(u.disabled, 0) AS disabled, ' +
    'u.campaign_id, COALESCE(st.clicks, 0) AS clicks, COALESCE(st.uniques, 0) AS uniques, ' +
    'COALESCE(st.conversions, 0) AS conversions ' +
    'FROM urls u LEFT JOIN (' +
    'SELECT d.url_id, SUM(d.clicks) AS clicks, SUM(d.uniques) AS uniques, SUM(d.conversions) AS conversions ' +
    'FROM link_stats_daily d JOIN urls du ON du.id = d.url_id ' +
    'WHERE du.user_id = ? AND d.day >= ? GROUP BY d.url_id' +
    ') st ON st.url_id = u.id ' +
    'WHERE u.user_id = ?';

  if (parsed.campaignId) {
    sql += ' AND u.campaign_id = ?';
    params.push(parsed.campaignId);
  }
  if (parsed.search) {
    // `_` and `%` survive the allowlist but are LIKE wildcards: escape them so
    // a prefix search cannot silently broaden.
    const escapedPrefix = parsed.search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    sql += " AND u.short LIKE ? ESCAPE '\\'";
    params.push(`${escapedPrefix}%`);
  }
  if (parsed.status === 'active') sql += ' AND COALESCE(u.disabled, 0) = 0';
  else if (parsed.status === 'disabled') sql += ' AND COALESCE(u.disabled, 0) = 1';

  if (parsed.cursor) {
    sql += ' AND (u.created_at < ? OR (u.created_at = ? AND u.id < ?))';
    params.push(parsed.cursor.createdAt, parsed.cursor.createdAt, parsed.cursor.id);
  }

  sql += ' ORDER BY u.created_at DESC, u.id DESC LIMIT ?';
  params.push(parsed.limit + 1);

  try {
    const rows = await dbAllAsync(sql, params);
    const items = (rows || []).slice(0, parsed.limit).map((row) => ({
      id: Number(row.id),
      short: row.short,
      original: row.original,
      created_at: row.created_at,
      campaign_id: row.campaign_id === null || row.campaign_id === undefined ? null : Number(row.campaign_id),
      disabled: Number(row.disabled || 0) === 1,
      max_clicks: row.max_clicks === null || row.max_clicks === undefined ? null : Number(row.max_clicks),
      stats: {
        days: parsed.days,
        clicks: Number(row.clicks || 0),
        uniques: Number(row.uniques || 0),
        conversions: Number(row.conversions || 0),
      },
    }));

    const hasMore = (rows || []).length > parsed.limit;
    analyticsAudit.recordAnalyticsAccess({
      userId,
      apiKeyId: req.apiAuth && req.apiAuth.apiKeyId,
      action: analyticsAudit.AUDIT_ACTIONS.API_READ,
      req,
      metadata: { endpoint: 'links.list', count: items.length },
    });
    return res.json({
      links: items,
      has_more: hasMore,
      next_cursor: hasMore ? encodeCursor(items[items.length - 1]) : null,
    });
  } catch {
    return res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/pro/v1/campaigns?days=30
router.get('/api/pro/v1/campaigns', ...API_STACK, async (req, res) => {
  const userId = req.apiAuth && Number.isInteger(req.apiAuth.userId) ? req.apiAuth.userId : 0;
  if (!userId) return res.status(401).json({ error: 'Unauthorized.' });

  const includeArchived = ['1', 'true', 'yes'].includes(String((req.query && req.query.include_archived) || '').toLowerCase());
  try {
    const campaigns = await campaignLib.listCampaigns({
      userId,
      days: req.query && req.query.days,
      includeArchived,
    });
    return res.json({ campaigns });
  } catch {
    return res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/pro/v1/campaigns/:id?days=30
router.get('/api/pro/v1/campaigns/:id', ...API_STACK, async (req, res) => {
  const userId = req.apiAuth && Number.isInteger(req.apiAuth.userId) ? req.apiAuth.userId : 0;
  if (!userId) return res.status(401).json({ error: 'Unauthorized.' });

  const campaign = await campaignLib.getCampaignForUser({ userId, campaignId: req.params.id });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });

  try {
    const payload = await campaignLib.loadCampaignStats({
      campaign,
      query: req.query && typeof req.query === 'object' ? req.query : {},
    });
    return res.json(payload);
  } catch {
    return res.status(500).json({ error: 'Server error.' });
  }
});

// GET /api/pro/v1/openapi.json -> versioned description of this namespace
router.get('/api/pro/v1/openapi.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('application/json');
  return res.sendFile(path.join(__dirname, '..', '..', '..', 'public', 'openapi-pro-v1.json'), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'OpenAPI document not found.' });
  });
});

router.all(
  [
    '/api/pro/v1/links',
    '/api/pro/v1/campaigns',
    '/api/pro/v1/campaigns/:id',
    '/api/pro/v1/openapi.json',
  ],
  (req, res) => {
    res.set('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed. Use GET.' });
  }
);

module.exports = router;
module.exports.encodeCursor = encodeCursor;
module.exports.decodeCursor = decodeCursor;
module.exports.parseListQuery = parseListQuery;
