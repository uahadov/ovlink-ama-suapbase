const express = require('express');
const router = express.Router();

const { dbGetAsync, dbRunAsync, withTransaction } = require('../../db/helpers');
const { normalizeShortCode } = require('../../lib/url-helpers');
const campaignLib = require('../../lib/campaigns');
const campaignWizard = require('../../lib/campaign-wizard');
const {
  normalizeCampaignStatus,
  resolveEffectiveStatus,
  evaluateStatusTransition,
  validateUtcInterval,
  normalizeBudget,
  recordCampaignAudit,
} = require('../../lib/campaign-model');
const campaignReport = require('../../../public/campaign-report');

const {
  WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL,
  WORKSPACE_LINK_MUTATION_SQL,
} = require('../../lib/link-access');

// Campaigns belong to individual accounts. A team member may read a shared
// link, but cannot assign their private campaign to somebody else's link.
// This check is part of the UPDATE (rather than a preflight SELECT) so the
// owner relationship remains valid even with concurrent workspace activity.
const CAMPAIGN_ASSIGNMENT_SQL =
  'UPDATE urls SET campaign_id = ? WHERE short = ? AND ' + WORKSPACE_LINK_MUTATION_SQL +
  ' AND (?::integer IS NULL OR EXISTS (SELECT 1 FROM campaigns c WHERE c.id = ? AND (' +
  ' (c.workspace_id IS NULL AND c.user_id = urls.user_id) OR ' +
  ' (c.workspace_id IS NOT NULL AND c.workspace_id = urls.workspace_id))))';

const ERROR_MESSAGES = {
  unauthorized: 'Giriş gerekli.',
  invalid_name: 'Kampaniya adı ən az 2 simvol olmalıdır.',
  duplicate: 'Bu adda kampaniya artıq mövcuddur.',
  db_error: 'Kampaniya yaradıla bilmədi.',
  not_found: 'Kampaniya tapılmadı.',
  workspace_forbidden: 'Workspace-də bu əməliyyata icazəniz yoxdur.',
  workspace_inactive: 'Workspace üçün aktiv Pro tələb olunur.',
  invalid_workspace: 'Yanlış workspace ID.',
  workspace_not_found: 'Workspace tapılmadı.',
  invalid_status: 'Kampaniya statusu düzgün deyil (draft, active, paused, completed, archived).',
  invalid_status_transition: 'Bu status keçidinə icazə verilmir.',
  invalid_datetime: 'Tarix formatı düzgün deyil (ISO UTC tələb olunur).',
  invalid_interval: 'Bitiş tarixi başlanğıc tarixindən əvvəl ola bilməz.',
  invalid_budget: 'Büdcə məbləği 0 və ya müsbət real rəqəm olmalıdır.',
  invalid_currency: 'Büdcə valyutası dəstəklənmir (AZN, USD, EUR, TRY, GBP).',
};

function currentUserId(req) {
  if (!req.session || !req.session.userId) return 0;
  const id = Number.parseInt(req.session.userId, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

// GET /api/campaigns?days=30&status= -> campaigns with aggregated counters
router.get('/api/campaigns', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const query = req.query && typeof req.query === 'object' ? req.query : {};
  const includeArchived = ['1', 'true', 'yes'].includes(String(query.include_archived || '').toLowerCase());
  const rawStatus = query.status;
  let statusFilter = null;
  if (rawStatus !== undefined && rawStatus !== '') {
    statusFilter = normalizeCampaignStatus(rawStatus);
    if (!statusFilter) return res.status(400).json({ error: ERROR_MESSAGES.invalid_status });
  }

  try {
    const rows = await campaignLib.listCampaigns({
      userId,
      days: query.days,
      includeArchived,
      status: statusFilter,
    });
    return res.json({ campaigns: rows });
  } catch {
    return res.status(500).json({ error: 'Veri alınamadı.' });
  }
});

// POST /api/campaigns { name, goal, status?, starts_at?, ends_at?, budget_amount?, budget_currency? }
router.post('/api/campaigns', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = body.name || '';
  const goal = body.goal || '';
  const goalClicks = body.goal_clicks;
  const goalConversions = body.goal_conversions;
  const workspaceId = body.workspace_id;
  const status = body.status;
  const startsAt = body.starts_at;
  const endsAt = body.ends_at;
  const budgetAmount = body.budget_amount;
  const budgetCurrency = body.budget_currency;

  try {
    const result = await campaignLib.createCampaign({
      userId,
      name,
      goal,
      goalClicks,
      goalConversions,
      workspaceId,
      status,
      startsAt,
      endsAt,
      budgetAmount,
      budgetCurrency,
    });
    if (result.error) {
      const badRequestErrors = [
        'invalid_name',
        'invalid_workspace',
        'invalid_status',
        'invalid_datetime',
        'invalid_interval',
        'invalid_budget',
        'invalid_currency',
      ];
      const statusCode = result.error === 'duplicate' ? 409 :
        (badRequestErrors.includes(result.error) ? 400 :
        (result.error === 'workspace_forbidden' ? 403 : (result.error === 'workspace_not_found' ? 404 :
        (result.error === 'workspace_inactive' ? 403 : 500))));
      return res.status(statusCode).json({ error: ERROR_MESSAGES[result.error] || 'Kampaniya yaradıla bilmədi.' });
    }
    return res.status(201).json({ campaign: result.campaign });
  } catch {
    return res.status(500).json({ error: 'Kampaniya yaradıla bilmədi.' });
  }
});

// POST /api/campaigns/wizard-preview -> validate draft & preview UTM-tagged links without writes
router.post('/api/campaigns/wizard-preview', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const preview = campaignWizard.validateWizardDraft(req.body);
  return res.json(preview);
});

// POST /api/campaigns/launch -> 5-step Campaign Launch Wizard orchestrator with partial-failure tracking
router.post('/api/campaigns/launch', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  try {
    const result = await campaignWizard.launchCampaignWizard({ userId, payload: req.body });
    if (result.error) {
      return res.status(result.statusCode || 400).json({
        error: ERROR_MESSAGES[result.error] || 'Kampaniya yaradıla bilmədi.',
        code: result.error,
      });
    }
    return res.status(result.statusCode || 201).json(result.body);
  } catch {
    return res.status(500).json({ error: 'Kampaniya yaradıla bilmədi.' });
  }
});

// GET /api/campaigns/:id/assets -> unified links, QR codes, and client assets for a campaign
router.get('/api/campaigns/:id/assets', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const campaign = await campaignLib.getCampaignForActor({ userId, campaignId: req.params.id });
  if (!campaign) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

  try {
    const payload = await campaignLib.loadCampaignAssets({ campaign });
    return res.json(payload);
  } catch {
    return res.status(500).json({ error: 'Veri alınamadı.' });
  }
});

// GET /api/campaigns/:id?days=&bots= -> aggregated campaign statistics
router.get('/api/campaigns/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const campaign = await campaignLib.getCampaignForActor({ userId, campaignId: req.params.id });
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

// GET /api/campaigns/:id/export.csv — audited, server-generated report.
// The same aggregate model powers both the dashboard and the export, avoiding
// client/browser-dependent report generation for business workflows.
router.get('/api/campaigns/:id/export.csv', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  try {
    const campaignId = Number(req.params.id);
    if (!Number.isSafeInteger(campaignId) || campaignId <= 0) {
      return res.status(404).json({ error: ERROR_MESSAGES.not_found });
    }
    // Preserve the difference between missing campaign (404) and database
    // failure (503): getCampaignForUser intentionally tolerates DB errors for
    // older UI callers, which is inappropriate for an audited business export.
    const campaign = await campaignLib.getCampaignForActor({ userId, campaignId });
    if (!campaign) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

    const payload = await campaignLib.loadCampaignStats({
      campaign,
      query: req.query && typeof req.query === 'object' ? req.query : {},
    });
    const csv = campaignReport.toCsv(payload);
    const filename = campaignReport.filename(payload);

    // Keep a durable, low-PII export receipt. If audit persistence fails,
    // fail closed rather than silently delivering an untraceable report.
    await dbRunAsync(
      'INSERT INTO analytics_audit_log (created_at, user_id, url_id, short, action, metadata_json) VALUES (?, ?, NULL, NULL, ?, ?)',
      [new Date().toISOString(), userId, 'campaign.csv.export', JSON.stringify({
        campaign_id: Number(campaign.id),
        days: payload.range.days,
        bots: payload.range.bots,
      })]
    );

    return res
      .set('Cache-Control', 'private, no-store, max-age=0')
      .set('X-Content-Type-Options', 'nosniff')
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${filename}"`)
      .send(csv);
  } catch (error) {
    return res.status(503).json({ error: 'Hesabat hazır deyil. Yenidən cəhd edin.' });
  }
});

// PATCH /api/campaigns/:id { name?, goal?, archived?, status?, starts_at?, ends_at?, budget_amount?, budget_currency? }
router.patch('/api/campaigns/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const campaign = await campaignLib.getCampaignForActor({ userId, campaignId: req.params.id, write: true });
  if (!campaign) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
  const hasGoal = Object.prototype.hasOwnProperty.call(body, 'goal');
  const hasArchived = Object.prototype.hasOwnProperty.call(body, 'archived');
  const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status');
  const hasStartsAt = Object.prototype.hasOwnProperty.call(body, 'starts_at');
  const hasEndsAt = Object.prototype.hasOwnProperty.call(body, 'ends_at');
  const hasBudgetAmount = Object.prototype.hasOwnProperty.call(body, 'budget_amount');
  const hasBudgetCurrency = Object.prototype.hasOwnProperty.call(body, 'budget_currency');
  const hasGoalClicks = Object.prototype.hasOwnProperty.call(body, 'goal_clicks');
  const hasGoalConversions = Object.prototype.hasOwnProperty.call(body, 'goal_conversions');

  const currentStatus = resolveEffectiveStatus(campaign);
  let nextName = campaign.name;
  let nextSlug = campaign.slug;
  let nextGoal = campaign.goal;
  let nextStatus = currentStatus;
  let nextArchivedAt = campaign.archived_at;
  let nextStartsAt = campaign.starts_at || null;
  let nextEndsAt = campaign.ends_at || null;
  let nextBudgetAmount = campaign.budget_amount === undefined || campaign.budget_amount === null ? null : Number(campaign.budget_amount);
  let nextBudgetCurrency = nextBudgetAmount === null ? null : (campaign.budget_currency || 'AZN');
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
        [campaign.user_id, slug, campaign.id]
      ).catch(() => null);
      if (clash) return res.status(409).json({ error: ERROR_MESSAGES.duplicate });
    }

    nextName = cleanName;
    nextSlug = slug;
  }

  if (hasGoal) nextGoal = campaignLib.normalizeCampaignName(body.goal) || null;
  if (hasGoalClicks) nextGoalClicks = campaignLib.normalizeGoalTarget(body.goal_clicks);
  if (hasGoalConversions) nextGoalConversions = campaignLib.normalizeGoalTarget(body.goal_conversions);

  if (hasStartsAt || hasEndsAt) {
    const interval = validateUtcInterval(
      hasStartsAt ? body.starts_at : nextStartsAt,
      hasEndsAt ? body.ends_at : nextEndsAt
    );
    if (interval.error) {
      return res.status(400).json({ error: ERROR_MESSAGES[interval.error] || ERROR_MESSAGES.invalid_interval });
    }
    nextStartsAt = interval.starts_at;
    nextEndsAt = interval.ends_at;
  }

  if (hasBudgetAmount || hasBudgetCurrency) {
    const budget = normalizeBudget(
      hasBudgetAmount ? body.budget_amount : nextBudgetAmount,
      hasBudgetCurrency ? body.budget_currency : nextBudgetCurrency
    );
    if (budget.error) {
      return res.status(400).json({ error: ERROR_MESSAGES[budget.error] || ERROR_MESSAGES.invalid_budget });
    }
    nextBudgetAmount = budget.budget_amount;
    nextBudgetCurrency = budget.budget_currency;
  }

  let statusChanged = false;
  if (hasStatus) {
    const transition = evaluateStatusTransition(currentStatus, body.status);
    if (!transition.allowed) {
      const statusCode = transition.code === 'invalid_status' ? 400 : 409;
      return res.status(statusCode).json({
        error: ERROR_MESSAGES[transition.code] || ERROR_MESSAGES.invalid_status_transition,
        code: transition.code,
        from: transition.from,
        allowed_next: transition.allowed_next,
      });
    }
    nextStatus = transition.status;
    statusChanged = transition.changed;
    nextArchivedAt = nextStatus === 'archived' ? (campaign.archived_at || new Date().toISOString()) : null;
  } else if (hasArchived) {
    const archive = ['1', 'true', 'yes', 'on'].includes(String(body.archived).toLowerCase());
    nextArchivedAt = archive ? (campaign.archived_at || new Date().toISOString()) : null;
    nextStatus = archive ? 'archived' : (currentStatus === 'archived' ? 'active' : currentStatus);
    statusChanged = nextStatus !== currentStatus;
  }

  try {
    const updated = await dbRunAsync(
      'UPDATE campaigns SET name = ?, slug = ?, goal = ?, status = ?, archived_at = ?, starts_at = ?, ends_at = ?, budget_amount = ?, budget_currency = ?, goal_clicks = ?, goal_conversions = ? WHERE id = ? AND (' +
      ' (workspace_id IS NULL AND user_id = ?) OR ' +
      " (workspace_id IS NOT NULL AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = campaigns.workspace_id AND wm.user_id = ? AND wm.role IN ('owner','admin'))))",
      [
        nextName,
        nextSlug,
        nextGoal,
        nextStatus,
        nextArchivedAt,
        nextStartsAt,
        nextEndsAt,
        nextBudgetAmount,
        nextBudgetCurrency,
        nextGoalClicks,
        nextGoalConversions,
        campaign.id,
        userId,
        userId,
      ]
    );
    if (!updated || !updated.changes) {
      return res.status(409).json({ error: 'Kampaniya yenilənə bilmədi. İcazəni və vəziyyəti yeniləyin.' });
    }

    await recordCampaignAudit(dbRunAsync, {
      userId,
      action: statusChanged ? 'campaign.status_changed' : 'campaign.updated',
      campaignId: campaign.id,
      metadata: {
        event_id: campaign.event_id || null,
        from_status: currentStatus,
        to_status: nextStatus,
        budget_amount: nextBudgetAmount,
        budget_currency: nextBudgetCurrency,
      },
    });

    return res.json({
      campaign: {
        id: Number(campaign.id),
        name: nextName,
        slug: nextSlug,
        status: nextStatus,
        event_id: campaign.event_id || null,
        starts_at: nextStartsAt,
        ends_at: nextEndsAt,
        budget_amount: nextBudgetAmount,
        budget_currency: nextBudgetCurrency,
        goal: nextGoal || '',
        goal_clicks: nextGoalClicks === null || nextGoalClicks === undefined ? null : Number(nextGoalClicks),
        goal_conversions: nextGoalConversions === null || nextGoalConversions === undefined ? null : Number(nextGoalConversions),
        archived_at: nextArchivedAt,
        workspace_id: campaign.workspace_id ? Number(campaign.workspace_id) : null,
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

  const campaign = await campaignLib.getCampaignForActor({ userId, campaignId: req.params.id, write: true });
  if (!campaign) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

  try {
    // Campaign deletion must be atomic: a failing DELETE must not silently
    // detach links, because those assignments affect business reporting.
    const deleted = await withTransaction(async (tx) => {
      await tx.run('UPDATE urls SET campaign_id = NULL WHERE campaign_id = ?', [campaign.id]);
      const result = await tx.run('DELETE FROM campaigns WHERE id = ? AND (' +
        ' (workspace_id IS NULL AND user_id = ?) OR ' +
        " (workspace_id IS NOT NULL AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = campaigns.workspace_id AND wm.user_id = ? AND wm.role IN ('owner','admin'))))",
        [campaign.id, userId, userId]);
      if (!result || !result.changes) throw new Error('Campaign changed during deletion');
      return result;
    });
    await recordCampaignAudit(dbRunAsync, {
      userId,
      action: 'campaign.deleted',
      campaignId: campaign.id,
      metadata: {
        event_id: campaign.event_id || null,
        previous_status: resolveEffectiveStatus(campaign),
      },
    });
    return res.json({ deleted: !!deleted.changes });
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

  const campaign = await campaignLib.getCampaignForActor({ userId, campaignId: row.campaign_id });
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
    const owned = await campaignLib.getCampaignForActor({ userId, campaignId, write: true });
    if (!owned) return res.status(404).json({ error: ERROR_MESSAGES.not_found });
  }

  // Detaching is also a mutation: ordinary workspace members can view the
  // existing campaign assignment, but only owner/admin roles may modify it.
  const result = await dbRunAsync(
    CAMPAIGN_ASSIGNMENT_SQL,
    [campaignId, short, userId, userId, campaignId, campaignId]
  ).catch(() => null);

  if (!result || !result.changes) {
    return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });
  }

  return res.json({ short, campaign_id: campaignId });
});

module.exports = router;
module.exports.ERROR_MESSAGES = ERROR_MESSAGES;
module.exports.currentUserId = currentUserId;
module.exports.CAMPAIGN_ASSIGNMENT_SQL = CAMPAIGN_ASSIGNMENT_SQL;
