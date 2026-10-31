const express = require('express');
const router = express.Router();

const { dbGetAsync, dbRunAsync } = require('../../db/helpers');
const { normalizeShortCode } = require('../../lib/url-helpers');
const campaignLib = require('../../lib/campaigns');

const WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL = '(user_id = ? OR workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?))';

const ERROR_MESSAGES = {
  unauthorized: 'Giriş gerekli.',
  invalid_name: 'Kampaniya adı ən az 2 simvol olmalıdır.',
  duplicate: 'Bu adda kampaniya artıq mövcuddur.',
  db_error: 'Kampaniya yaradıla bilmədi.',
  not_found: 'Kampaniya tapılmadı.',
};

function currentUserId(req) {
  if (!req.session || !req.session.userId) return 0;
  const id = Number.parseInt(req.session.userId, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

// GET /api/campaigns?days=30 -> campaigns with aggregated counters
router.get('/api/campaigns', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const query = req.query && typeof req.query === 'object' ? req.query : {};
  const includeArchived = ['1', 'true', 'yes'].includes(String(query.include_archived || '').toLowerCase());

  try {
    const rows = await campaignLib.listCampaigns({ userId, days: query.days, includeArchived });
    return res.json({ campaigns: rows });
  } catch {
    return res.status(500).json({ error: 'Veri alınamadı.' });
  }
});

// POST /api/campaigns { name, goal }
router.post('/api/campaigns', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const name = (req.body && req.body.name) || '';
  const goal = (req.body && req.body.goal) || '';
  const goalClicks = req.body ? req.body.goal_clicks : null;
  const goalConversions = req.body ? req.body.goal_conversions : null;

  try {
    const result = await campaignLib.createCampaign({ userId, name, goal, goalClicks, goalConversions });
    if (result.error) {
      const status = result.error === 'duplicate' ? 409 : (result.error === 'invalid_name' ? 400 : 500);
      return res.status(status).json({ error: ERROR_MESSAGES[result.error] || 'Kampaniya yaradıla bilmədi.' });
    }
    return res.status(201).json({ campaign: result.campaign });
  } catch {
    return res.status(500).json({ error: 'Kampaniya yaradıla bilmədi.' });
  }
});

// GET /api/campaigns/:id?days=&bots= -> aggregated campaign statistics
router.get('/api/campaigns/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const campaign = await campaignLib.getCampaignForUser({ userId, campaignId: req.params.id });
  if (!campaign) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

  try {
    const payload = await campaignLib.loadCampaignStats({
      campaign,
      query: req.query && typeof req.query === 'object' ? req.query : {},
    });
    return res.json(payload);
  } catch {
    return res.status(500).json({ error: 'Veri alınamadı.' });
  }
});

// PATCH /api/campaigns/:id { name?, goal?, archived? }
router.patch('/api/campaigns/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const campaign = await campaignLib.getCampaignForUser({ userId, campaignId: req.params.id });
  if (!campaign) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
  const hasGoal = Object.prototype.hasOwnProperty.call(body, 'goal');
  const hasArchived = Object.prototype.hasOwnProperty.call(body, 'archived');
  const hasGoalClicks = Object.prototype.hasOwnProperty.call(body, 'goal_clicks');
  const hasGoalConversions = Object.prototype.hasOwnProperty.call(body, 'goal_conversions');

  let nextName = campaign.name;
  let nextSlug = campaign.slug;
  let nextGoal = campaign.goal;
  let nextArchivedAt = campaign.archived_at;
  let nextGoalClicks = campaign.goal_clicks === undefined ? null : campaign.goal_clicks;
  let nextGoalConversions = campaign.goal_conversions === undefined ? null : campaign.goal_conversions;

  if (hasName) {
    const cleanName = campaignLib.normalizeCampaignName(body.name);
    if (cleanName.length < 2) return res.status(400).json({ error: ERROR_MESSAGES.invalid_name });
    const slug = campaignLib.slugifyCampaignName(cleanName);
    if (!slug) return res.status(400).json({ error: ERROR_MESSAGES.invalid_name });

    if (slug !== campaign.slug) {
      const clash = await dbGetAsync(
        'SELECT id FROM campaigns WHERE user_id = ? AND slug = ? AND id <> ? LIMIT 1',
        [userId, slug, campaign.id]
      ).catch(() => null);
      if (clash) return res.status(409).json({ error: ERROR_MESSAGES.duplicate });
    }

    nextName = cleanName;
    nextSlug = slug;
  }

  if (hasGoal) nextGoal = campaignLib.normalizeCampaignName(body.goal) || null;

  if (hasGoalClicks) nextGoalClicks = campaignLib.normalizeGoalTarget(body.goal_clicks);
  if (hasGoalConversions) nextGoalConversions = campaignLib.normalizeGoalTarget(body.goal_conversions);

  if (hasArchived) {
    const archive = ['1', 'true', 'yes', 'on'].includes(String(body.archived).toLowerCase());
    nextArchivedAt = archive ? (campaign.archived_at || new Date().toISOString()) : null;
  }

  try {
    await dbRunAsync(
      'UPDATE campaigns SET name = ?, slug = ?, goal = ?, archived_at = ?, goal_clicks = ?, goal_conversions = ? WHERE id = ? AND user_id = ?',
      [nextName, nextSlug, nextGoal, nextArchivedAt, nextGoalClicks, nextGoalConversions, campaign.id, userId]
    );
    return res.json({
      campaign: {
        id: Number(campaign.id),
        name: nextName,
        slug: nextSlug,
        goal: nextGoal || '',
        goal_clicks: nextGoalClicks === null || nextGoalClicks === undefined ? null : Number(nextGoalClicks),
        goal_conversions: nextGoalConversions === null || nextGoalConversions === undefined ? null : Number(nextGoalConversions),
        archived_at: nextArchivedAt,
      },
    });
  } catch {
    return res.status(500).json({ error: 'Kampaniya yenilənmədi.' });
  }
});

// DELETE /api/campaigns/:id -> links are kept, only the grouping is removed.
router.delete('/api/campaigns/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const campaign = await campaignLib.getCampaignForUser({ userId, campaignId: req.params.id });
  if (!campaign) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

  try {
    await dbRunAsync('UPDATE urls SET campaign_id = NULL WHERE campaign_id = ?', [campaign.id]);
    const deleted = await dbRunAsync('DELETE FROM campaigns WHERE id = ? AND user_id = ?', [campaign.id, userId]);
    return res.json({ deleted: !!(deleted && deleted.changes) });
  } catch {
    return res.status(500).json({ error: 'Kampaniya silinmədi.' });
  }
});

// GET /api/links/:short/campaign -> campaign assigned to one link
router.get('/api/links/:short/campaign', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const short = normalizeShortCode(req.params.short);
  if (!short) return res.status(400).json({ error: 'Geçersiz kısa kod.' });

  const row = await dbGetAsync(
    'SELECT id, campaign_id FROM urls WHERE short = ? AND ' + WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL,
    [short, userId, userId]
  ).catch(() => null);

  if (!row) return res.status(404).json({ error: 'Link bulunamadı.' });
  if (!row.campaign_id) return res.json({ short, campaign: null });

  const campaign = await campaignLib.getCampaignForUser({ userId, campaignId: row.campaign_id });
  return res.json({
    short,
    campaign: campaign
      ? { id: Number(campaign.id), name: campaign.name, slug: campaign.slug, goal: campaign.goal || '' }
      : null,
  });
});

// POST /api/links/:short/campaign { campaign_id } -> assign (or null to detach)
router.post('/api/links/:short/campaign', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const short = normalizeShortCode(req.params.short);
  if (!short) return res.status(400).json({ error: 'Geçersiz kısa kod.' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const rawCampaignId = body.campaign_id;
  const campaignId = (rawCampaignId === null || rawCampaignId === undefined || rawCampaignId === '')
    ? null
    : Number.parseInt(rawCampaignId, 10);

  if (campaignId !== null && (!Number.isInteger(campaignId) || campaignId <= 0)) {
    return res.status(400).json({ error: 'Geçersiz kampaniya.' });
  }

  if (campaignId !== null) {
    const owned = await campaignLib.getCampaignForUser({ userId, campaignId });
    if (!owned) return res.status(404).json({ error: ERROR_MESSAGES.not_found });
  }

  const result = await dbRunAsync(
    'UPDATE urls SET campaign_id = ? WHERE short = ? AND ' + WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL,
    [campaignId, short, userId, userId]
  ).catch(() => null);

  if (!result || !result.changes) {
    return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });
  }

  return res.json({ short, campaign_id: campaignId });
});

module.exports = router;
module.exports.ERROR_MESSAGES = ERROR_MESSAGES;
module.exports.currentUserId = currentUserId;
