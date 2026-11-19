'use strict';

/**
 * P26 — Client Portal v1 (client-portal-v1).
 *
 * Provides revocable, expiring, SHA-256-hashed ClientViewer share links scoped
 * strictly to authorized campaign IDs and metrics, with view-audit logging,
 * zero admin/edit controls, anti-IDOR isolation, and lightweight feedback.
 */

const crypto = require('crypto');
const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../db/helpers');

const CLIENT_PORTAL_CONTRACT_VERSION = 'client-portal-v1';
const ALLOWED_PORTAL_METRICS = ['clicks', 'uniques', 'conversions', 'conversion_rate', 'channels', 'top_links'];
const ALLOWED_SENTIMENTS = new Set(['approved', 'question', 'change_request', 'note']);
const MAX_EXPIRY_DAYS = 365;
const DEFAULT_EXPIRY_DAYS = 30;

let portalTablesReady = false;

function hashShareToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
}

function generateShareToken() {
  return 'ovp_' + crypto.randomBytes(24).toString('base64url');
}

function cleanText(raw, maxLen = 120) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function normalizeCampaignIds(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const id = Number.parseInt(item, 10);
    if (Number.isInteger(id) && id > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function normalizeAllowedMetrics(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return ['clicks', 'uniques', 'conversions', 'conversion_rate'];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const key = String(item || '').trim().toLowerCase();
    if (ALLOWED_PORTAL_METRICS.includes(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out.length > 0 ? out : ['clicks', 'uniques', 'conversions', 'conversion_rate'];
}

function parseExpiryIso(rawExpiresAt, rawDays) {
  if (rawExpiresAt) {
    const d = new Date(rawExpiresAt);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
  const days = Number.parseInt(rawDays, 10);
  const safeDays = Number.isInteger(days) && days > 0 ? Math.min(MAX_EXPIRY_DAYS, days) : DEFAULT_EXPIRY_DAYS;
  return new Date(Date.now() + safeDays * 86400 * 1000).toISOString();
}

function evaluateShareAccess(shareRow, now = new Date()) {
  if (!shareRow) return { allowed: false, status: 404, code: 'portal_share_not_found' };
  if (shareRow.revoked_at) return { allowed: false, status: 410, code: 'portal_share_revoked' };
  if (shareRow.expires_at) {
    const exp = new Date(shareRow.expires_at);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() <= now.getTime()) {
      return { allowed: false, status: 410, code: 'portal_share_expired' };
    }
  }
  return { allowed: true, status: 200, code: null };
}

function parseJsonArray(raw, fallback = []) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function mapShareRow(row) {
  if (!row) return null;
  const access = evaluateShareAccess(row);
  return {
    id: Number(row.id),
    owner_user_id: Number(row.owner_user_id),
    workspace_id: row.workspace_id ? Number(row.workspace_id) : null,
    client_name: row.client_name || '',
    role: 'client_viewer',
    token_prefix: row.token_prefix || '',
    allowed_campaign_ids: parseJsonArray(row.allowed_campaign_ids_json, []),
    allowed_metrics: parseJsonArray(row.allowed_metrics_json, ['clicks', 'uniques', 'conversions', 'conversion_rate']),
    template_id: row.template_id ? Number(row.template_id) : null,
    locale: row.locale || 'az',
    expires_at: row.expires_at || null,
    revoked_at: row.revoked_at || null,
    status: row.revoked_at ? 'revoked' : (access.allowed ? 'active' : 'expired'),
    view_count: Number(row.view_count || 0),
    last_viewed_at: row.last_viewed_at || null,
    created_at: row.created_at,
  };
}

async function ensureClientPortalTables(runFn = dbRunAsync) {
  if (portalTablesReady) return;
  await runFn(`CREATE TABLE IF NOT EXISTS client_portal_shares (
    id SERIAL PRIMARY KEY,
    owner_user_id INTEGER NOT NULL,
    workspace_id INTEGER,
    client_name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    allowed_campaign_ids_json TEXT NOT NULL,
    allowed_metrics_json TEXT NOT NULL,
    template_id INTEGER,
    locale TEXT NOT NULL DEFAULT 'az',
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    view_count INTEGER NOT NULL DEFAULT 0,
    last_viewed_at TEXT,
    created_at TEXT NOT NULL
  )`);
  await runFn('CREATE INDEX IF NOT EXISTS idx_client_portal_owner ON client_portal_shares(owner_user_id, id DESC)').catch(() => {});
  await runFn(`CREATE TABLE IF NOT EXISTS client_portal_feedback (
    id SERIAL PRIMARY KEY,
    share_id INTEGER NOT NULL,
    campaign_id INTEGER,
    author_name TEXT NOT NULL,
    section TEXT,
    sentiment TEXT NOT NULL DEFAULT 'note',
    note TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  await runFn('CREATE INDEX IF NOT EXISTS idx_client_portal_feedback_share ON client_portal_feedback(share_id, id DESC)').catch(() => {});
  portalTablesReady = true;
}

async function createPortalShare({
  ownerUserId,
  workspaceId = null,
  clientName,
  campaignIds = [],
  allowedMetrics = [],
  templateId = null,
  locale = 'az',
  expiresAt = null,
  expiresInDays = DEFAULT_EXPIRY_DAYS,
  dbRun = dbRunAsync,
} = {}) {
  await ensureClientPortalTables(dbRun);
  const cleanClient = cleanText(clientName, 80);
  if (cleanClient.length < 2) {
    return { error: 'invalid_client_name', statusCode: 400, message: 'Müştəri adı ən az 2 simvol olmalıdır.' };
  }
  const normalizedIds = normalizeCampaignIds(campaignIds);
  if (normalizedIds.length === 0) {
    return { error: 'missing_campaigns', statusCode: 400, message: 'Ən azı 1 kampaniya seçilməlidir.' };
  }
  const expiryIso = parseExpiryIso(expiresAt, expiresInDays);
  if (!expiryIso) {
    return { error: 'invalid_expiry', statusCode: 400, message: 'Bitmə tarixi düzgün deyil.' };
  }

  const rawToken = generateShareToken();
  const tokenHash = hashShareToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 10);
  const metrics = normalizeAllowedMetrics(allowedMetrics);
  const nowIso = new Date().toISOString();

  const inserted = await dbRun(
    `INSERT INTO client_portal_shares
       (owner_user_id, workspace_id, client_name, token_hash, token_prefix,
        allowed_campaign_ids_json, allowed_metrics_json, template_id, locale, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(ownerUserId),
      workspaceId ? Number(workspaceId) : null,
      cleanClient,
      tokenHash,
      tokenPrefix,
      JSON.stringify(normalizedIds),
      JSON.stringify(metrics),
      templateId ? Number(templateId) : null,
      ['az', 'tr', 'en'].includes(String(locale).toLowerCase()) ? String(locale).toLowerCase() : 'az',
      expiryIso,
      nowIso,
    ]
  );

  await dbRun(
    'INSERT INTO analytics_audit_log (created_at, user_id, url_id, short, action, metadata_json) VALUES (?, ?, NULL, NULL, ?, ?)',
    [nowIso, Number(ownerUserId), 'client_portal.share.created', JSON.stringify({
      share_id: Number(inserted.lastID),
      client_name: cleanClient,
      campaign_ids: normalizedIds,
      expires_at: expiryIso,
    })]
  ).catch(() => {});

  return {
    share_token: rawToken,
    share: mapShareRow({
      id: inserted.lastID,
      owner_user_id: ownerUserId,
      workspace_id: workspaceId,
      client_name: cleanClient,
      token_prefix: tokenPrefix,
      allowed_campaign_ids_json: JSON.stringify(normalizedIds),
      allowed_metrics_json: JSON.stringify(metrics),
      template_id: templateId,
      locale,
      expires_at: expiryIso,
      revoked_at: null,
      view_count: 0,
      last_viewed_at: null,
      created_at: nowIso,
    }),
  };
}

async function listPortalShares({ ownerUserId, dbAll = dbAllAsync, dbRun = dbRunAsync } = {}) {
  await ensureClientPortalTables(dbRun);
  const rows = await dbAll(
    'SELECT * FROM client_portal_shares WHERE owner_user_id = ? ORDER BY id DESC LIMIT 100',
    [Number(ownerUserId)]
  );
  return (rows || []).map(mapShareRow);
}

async function revokePortalShare({ ownerUserId, shareId, dbRun = dbRunAsync } = {}) {
  await ensureClientPortalTables(dbRun);
  const id = Number.parseInt(shareId, 10);
  if (!Number.isInteger(id) || id <= 0) return { error: 'not_found', statusCode: 404 };
  const nowIso = new Date().toISOString();
  const res = await dbRun(
    'UPDATE client_portal_shares SET revoked_at = ? WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL',
    [nowIso, id, Number(ownerUserId)]
  );
  if (!res || !res.changes) return { error: 'not_found', statusCode: 404 };
  await dbRun(
    'INSERT INTO analytics_audit_log (created_at, user_id, url_id, short, action, metadata_json) VALUES (?, ?, NULL, NULL, ?, ?)',
    [nowIso, Number(ownerUserId), 'client_portal.share.revoked', JSON.stringify({ share_id: id })]
  ).catch(() => {});
  return { revoked: true, id, revoked_at: nowIso };
}

async function resolvePortalShareByToken({ rawToken, dbGet = dbGetAsync, dbRun = dbRunAsync } = {}) {
  await ensureClientPortalTables(dbRun);
  const token = String(rawToken || '').trim();
  if (!/^ovp_[A-Za-z0-9_-]{16,80}$/.test(token)) {
    return { error: 'portal_share_not_found', statusCode: 404 };
  }
  const row = await dbGet(
    'SELECT * FROM client_portal_shares WHERE token_hash = ? LIMIT 1',
    [hashShareToken(token)]
  );
  const access = evaluateShareAccess(row);
  if (!access.allowed) {
    return { error: access.code, statusCode: access.status };
  }
  return { share: mapShareRow(row), row };
}

async function recordPortalView({ share, campaignIdsViewed = [], dbRun = dbRunAsync } = {}) {
  const nowIso = new Date().toISOString();
  await dbRun(
    'UPDATE client_portal_shares SET view_count = COALESCE(view_count, 0) + 1, last_viewed_at = ? WHERE id = ?',
    [nowIso, Number(share.id)]
  );
  await dbRun(
    'INSERT INTO analytics_audit_log (created_at, user_id, url_id, short, action, metadata_json) VALUES (?, ?, NULL, NULL, ?, ?)',
    [nowIso, Number(share.owner_user_id), 'client_portal.viewed', JSON.stringify({
      share_id: Number(share.id),
      client_name: share.client_name,
      campaign_ids: campaignIdsViewed,
    })]
  );
}

async function addPortalFeedback({ share, body = {}, dbRun = dbRunAsync } = {}) {
  await ensureClientPortalTables(dbRun);
  const note = cleanText(body.note, 800);
  if (note.length < 2) {
    return { error: 'invalid_note', statusCode: 400, message: 'Rəy mətni ən az 2 simvol olmalıdır.' };
  }
  const authorName = cleanText(body.author_name || share.client_name, 80) || 'Client Viewer';
  const section = cleanText(body.section, 60) || 'general';
  const sentiment = ALLOWED_SENTIMENTS.has(String(body.sentiment || '').toLowerCase())
    ? String(body.sentiment).toLowerCase()
    : 'note';
  let campaignId = null;
  if (body.campaign_id !== undefined && body.campaign_id !== null && body.campaign_id !== '') {
    const cid = Number.parseInt(body.campaign_id, 10);
    if (!share.allowed_campaign_ids.includes(cid)) {
      return { error: 'campaign_not_in_portal_scope', statusCode: 403, message: 'Bu kampaniya portal icazəsinə daxil deyil.' };
    }
    campaignId = cid;
  }
  const nowIso = new Date().toISOString();
  const inserted = await dbRun(
    'INSERT INTO client_portal_feedback (share_id, campaign_id, author_name, section, sentiment, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [Number(share.id), campaignId, authorName, section, sentiment, note, nowIso]
  );
  return {
    feedback: {
      id: Number(inserted.lastID),
      share_id: Number(share.id),
      campaign_id: campaignId,
      author_name: authorName,
      section,
      sentiment,
      note,
      created_at: nowIso,
    },
  };
}

async function listPortalFeedback({ ownerUserId, shareId, dbGet = dbGetAsync, dbAll = dbAllAsync, dbRun = dbRunAsync } = {}) {
  await ensureClientPortalTables(dbRun);
  const id = Number.parseInt(shareId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const share = await dbGet(
    'SELECT id FROM client_portal_shares WHERE id = ? AND owner_user_id = ? LIMIT 1',
    [id, Number(ownerUserId)]
  );
  if (!share) return null;
  const rows = await dbAll(
    'SELECT id, share_id, campaign_id, author_name, section, sentiment, note, created_at FROM client_portal_feedback WHERE share_id = ? ORDER BY id DESC LIMIT 100',
    [id]
  );
  return (rows || []).map((r) => ({
    id: Number(r.id),
    share_id: Number(r.share_id),
    campaign_id: r.campaign_id ? Number(r.campaign_id) : null,
    author_name: r.author_name,
    section: r.section || 'general',
    sentiment: r.sentiment || 'note',
    note: r.note,
    created_at: r.created_at,
  }));
}

/** Filters campaign metrics strictly to the metrics allowed by the share scope. */
function filterMetricsForPortal(campaignStats, allowedMetrics = []) {
  const allow = new Set(allowedMetrics);
  const metrics = {};
  if (allow.has('clicks')) metrics.clicks = Number(campaignStats.clicks || 0);
  if (allow.has('uniques')) metrics.uniques = Number(campaignStats.uniques || 0);
  if (allow.has('conversions')) metrics.conversions = Number(campaignStats.conversions || 0);
  if (allow.has('conversion_rate')) metrics.conversion_rate = Number(campaignStats.conversion_rate || 0);
  if (allow.has('channels')) metrics.top_sources = campaignStats.top_sources || [];
  if (allow.has('top_links')) metrics.top_links = campaignStats.top_links || [];
  return {
    campaign: {
      id: Number(campaignStats.campaign.id),
      name: campaignStats.campaign.name,
      slug: campaignStats.campaign.slug,
      status: campaignStats.campaign.status,
    },
    range: campaignStats.range,
    metrics,
    generated_at: campaignStats.generated_at,
    last_recorded_click_at: campaignStats.last_recorded_click_at || null,
  };
}

module.exports = {
  CLIENT_PORTAL_CONTRACT_VERSION,
  ALLOWED_PORTAL_METRICS,
  hashShareToken,
  generateShareToken,
  evaluateShareAccess,
  ensureClientPortalTables,
  createPortalShare,
  listPortalShares,
  revokePortalShare,
  resolvePortalShareByToken,
  recordPortalView,
  addPortalFeedback,
  listPortalFeedback,
  filterMetricsForPortal,
};
