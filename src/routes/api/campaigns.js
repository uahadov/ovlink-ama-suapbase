const express = require('express');
const router = express.Router();

const { dbGetAsync, dbRunAsync, withTransaction } = require('../../db/helpers');
const { normalizeShortCode } = require('../../lib/url-helpers');
const campaignLib = require('../../lib/campaigns');
const campaignWizard = require('../../lib/campaign-wizard');
const utmPresets = require('../../lib/utm-presets');
const bulkImport = require('../../lib/bulk-import');
const metricsContract = require('../../lib/metrics-contract');
const decisionAnalytics = require('../../lib/decision-analytics');
const reportProvenance = require('../../lib/report-provenance');
const reportTemplates = require('../../lib/report-templates');
const { getWorkspaceMemberRole } = require('./workspaces');
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

// GET /api/campaigns/:id/export.csv — audited, server-generated report with P24 provenance.
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
    const query = req.query && typeof req.query === 'object' ? req.query : {};
    // Preserve the difference between missing campaign (404) and database
    // failure (503): getCampaignForUser intentionally tolerates DB errors for
    // older UI callers, which is inappropriate for an audited business export.
    const campaign = await campaignLib.getCampaignForActor({ userId, campaignId });
    if (!campaign) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

    const requestedRawPii = reportProvenance.parseBooleanFlag(query.include_raw_pii || query.raw_pii);
    const requestedSurface = reportProvenance.normalizeSurface(query.surface, 'csv');
    if (requestedRawPii) {
      const workspaceRole = campaign.workspace_id
        ? await getWorkspaceMemberRole(userId, campaign.workspace_id).catch(() => null)
        : null;
      const access = reportProvenance.canExportRawPersonalData({
        actorUserId: userId,
        ownerUserId: campaign.user_id,
        workspaceId: campaign.workspace_id,
        workspaceRole,
        isAdmin: Boolean(req.session && req.session.isAdmin),
        surface: requestedSurface,
      });
      if (!access.allowed) {
        await dbRunAsync(
          'INSERT INTO analytics_audit_log (created_at, user_id, url_id, short, action, metadata_json) VALUES (?, ?, NULL, NULL, ?, ?)',
          [new Date().toISOString(), userId, 'campaign.raw_pii_export.denied', JSON.stringify({
            campaign_id: Number(campaign.id),
            surface: requestedSurface,
            reason: access.reason,
          })]
        ).catch(() => {});
        return res.status(403).json({
          error: 'Şəxsi məlumatların (raw PII) ixracına icazəniz yoxdur.',
          code: access.code,
          reason: access.reason,
        });
      }
    }

    const payload = await campaignLib.loadCampaignStats({ campaign, query });
    const staleThresholdSeconds = reportProvenance.parseStaleThresholdSeconds(query.stale_after_minutes);
    const strictFreshness = reportProvenance.parseBooleanFlag(query.strict_freshness);

    const payloadForHash = {
      links_count: payload.links_count,
      clicks: payload.clicks,
      uniques: payload.uniques,
      bots: payload.bots,
      conversions: payload.conversions,
      conversion_rate: payload.conversion_rate,
      clicks_by_day: payload.clicks_by_day,
      top_links: payload.top_links,
      top_sources: payload.top_sources,
      top_goals: payload.top_goals,
    };

    // Fail-closed: persist durable provenance snapshot + linked analytics_audit_log entry.
    const provenance = await reportProvenance.createAndPersistReportSnapshot({
      campaign,
      actorUserId: userId,
      surface: requestedSurface,
      reportType: 'campaign_stats',
      dateRange: payload.range,
      filters: { bots: payload.range.bots },
      metricMethod: payload.metric_method,
      uniqueMethod: payload.unique_method,
      conversionMethod: payload.conversion_method,
      lastDataAt: payload.last_recorded_click_at,
      generatedAt: payload.generated_at,
      payloadForHash,
      summaryData: {
        campaign: { id: payload.campaign.id, name: payload.campaign.name, slug: payload.campaign.slug },
        clicks: payload.clicks,
        uniques: payload.uniques,
        conversions: payload.conversions,
        conversion_rate: payload.conversion_rate,
      },
      auditAction: 'campaign.csv.export',
      staleThresholdSeconds,
      rawPiiRequested: requestedRawPii,
    });

    payload.provenance = provenance;
    const headers = reportProvenance.buildProvenanceHeaders(provenance);

    if (strictFreshness && provenance.freshness && provenance.freshness.is_stale) {
      return res
        .status(503)
        .set(headers)
        .json({
          error: 'Hesabat məlumatı köhnəlib (stale).',
          stale: true,
          provenance,
        });
    }

    const csv = campaignReport.toCsv(payload);
    const filename = campaignReport.filename(payload);

    return res
      .set('Cache-Control', 'private, no-store, max-age=0')
      .set('X-Content-Type-Options', 'nosniff')
      .set(headers)
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

// ===== P17: UTM Standards & Agency Presets =====

router.get('/api/utm-presets', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });
  try {
    const query = req.query && typeof req.query === 'object' ? req.query : {};
    const presets = await utmPresets.listUtmPresets({
      userId,
      workspaceId: query.workspace_id,
      clientId: query.client_id,
    });
    return res.json({ presets });
  } catch {
    return res.status(500).json({ error: 'UTM şablonları alına bilmədi.' });
  }
});

router.post('/api/utm-presets', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });
  try {
    const result = await utmPresets.createUtmPreset({ userId, body: req.body });
    if (result.error) {
      return res.status(result.statusCode || 400).json({
        error: ERROR_MESSAGES[result.error] || 'UTM şablonu yaradıla bilmədi.',
        code: result.error,
      });
    }
    return res.status(201).json({ preset: result.preset });
  } catch {
    return res.status(500).json({ error: 'UTM şablonu yaradıla bilmədi.' });
  }
});

router.patch('/api/utm-presets/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });
  try {
    const result = await utmPresets.updateUtmPreset({ userId, presetId: req.params.id, body: req.body });
    if (result.error) {
      return res.status(result.statusCode || 400).json({
        error: ERROR_MESSAGES[result.error] || 'UTM şablonu yenilənə bilmədi.',
        code: result.error,
      });
    }
    return res.json({ preset: result.preset });
  } catch {
    return res.status(500).json({ error: 'UTM şablonu yenilənə bilmədi.' });
  }
});

router.delete('/api/utm-presets/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });
  try {
    const result = await utmPresets.deleteUtmPreset({ userId, presetId: req.params.id });
    if (result.error) {
      return res.status(result.statusCode || 404).json({ error: 'UTM şablonu tapılmadı.', code: result.error });
    }
    return res.json(result);
  } catch {
    return res.status(500).json({ error: 'UTM şablonu silinmədi.' });
  }
});

router.post('/api/utm-presets/preview', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const baseUrl = String(body.base_url || '').trim();
  if (!/^https?:\/\//i.test(baseUrl)) {
    return res.status(400).json({ error: 'Keçərli http/https URL daxil edin.' });
  }

  let preset = body.preset && typeof body.preset === 'object' ? body.preset : {};
  if (body.preset_id) {
    const saved = await utmPresets.getUtmPresetForActor({ userId, presetId: body.preset_id });
    if (!saved) return res.status(404).json({ error: 'UTM şablonu tapılmadı.' });
    preset = saved;
  }

  const preview = utmPresets.buildChannelUtmPreview({
    baseUrl,
    preset,
    channels: Array.isArray(body.channels) ? body.channels : [],
    campaignSlug: body.campaign_slug || '',
  });
  return res.json(preview);
});

// ===== P18: Bulk Link Dry-Run Preview, Idempotent Execution & Partial-Success Report =====

router.post('/api/links/bulk/preview', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    let preset = null;
    if (body.utm_preset_id) {
      preset = await utmPresets.getUtmPresetForActor({ userId, presetId: body.utm_preset_id });
      if (!preset) return res.status(404).json({ error: 'UTM şablonu tapılmadı.' });
    }
    const preview = bulkImport.previewBulkImport({
      rows: body.rows,
      csv: body.csv,
      mapping: body.mapping,
      utmPreset: preset,
      windowLimit: body.window_limit,
    });
    return res.json({
      total_input_rows: preview.total_input_rows,
      processed_rows: preview.processed_rows,
      truncated_input: preview.truncated_input,
      max_rows_allowed: preview.max_rows_allowed,
      valid_count: preview.valid_count,
      invalid_count: preview.invalid_count,
      duplicate_url_count: preview.duplicate_url_count,
      window_limit: preview.window_limit,
      rows: preview.rows_window,
    });
  } catch {
    return res.status(500).json({ error: 'Önbaxış hazırlana bilmədi.' });
  }
});

router.post('/api/links/bulk/execute', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const idempotencyKey = req.get('idempotency-key') || body.idempotency_key || '';

    let campaignId = null;
    if (body.campaign_id !== undefined && body.campaign_id !== null && body.campaign_id !== '') {
      const owned = await campaignLib.getCampaignForActor({ userId, campaignId: body.campaign_id, write: true });
      if (!owned) return res.status(404).json({ error: ERROR_MESSAGES.not_found });
      campaignId = Number(owned.id);
    }

    let preset = null;
    if (body.utm_preset_id) {
      preset = await utmPresets.getUtmPresetForActor({ userId, presetId: body.utm_preset_id });
      if (!preset) return res.status(404).json({ error: 'UTM şablonu tapılmadı.' });
    }

    const userRow = await dbGetAsync('SELECT plan_tier, plan_status FROM users WHERE id = ?', [userId]);
    const isPro = Boolean(userRow && String(userRow.plan_tier || '').toLowerCase() === 'pro' && String(userRow.plan_status || '').toLowerCase() === 'active');

    const result = await bulkImport.executeBulkImport({
      userId,
      rows: body.rows,
      csv: body.csv,
      mapping: body.mapping,
      idempotencyKey,
      campaignId,
      utmPreset: preset,
      isPro,
    });

    if (result.error) {
      return res.status(result.statusCode || 400).json({ error: result.message || result.error, code: result.error });
    }
    return res.status(result.statusCode || 201).json(result.body);
  } catch {
    return res.status(500).json({ error: 'Toplu import icra edilə bilmədi.' });
  }
});

router.get('/api/links/bulk/jobs/:id/report.csv', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });
  try {
    const report = await bulkImport.getBulkJobReportCsv({ userId, jobId: req.params.id });
    if (!report) return res.status(404).json({ error: 'Import hesabatı tapılmadı.' });
    return res
      .set('Cache-Control', 'private, no-store, max-age=0')
      .set('X-Content-Type-Options', 'nosniff')
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="ovlink-bulk-report-${report.id}.csv"`)
      .send(report.csv);
  } catch {
    return res.status(500).json({ error: 'Hesabat endirilə bilmədi.' });
  }
});

// ===== P19: Analytics Data Contract v1 & Reconciliation =====

router.get('/api/analytics/methodology', (_req, res) => {
  return res.json(metricsContract.getFullAnalyticsContract());
});

router.get('/api/campaigns/:id/reconcile', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const campaign = await campaignLib.getCampaignForActor({ userId, campaignId: req.params.id });
  if (!campaign) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

  try {
    const report = await campaignLib.reconcileCampaignMetrics({ campaign, query: req.query || {} });
    return res.json(report);
  } catch {
    return res.status(500).json({ error: 'Metrika yoxlaması alınmadı.' });
  }
});

// ===== P23 + P24: Decision Analytics & Report Provenance =====

router.get('/api/campaigns/:id/decision', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const campaign = await campaignLib.getCampaignForActor({ userId, campaignId: req.params.id });
  if (!campaign) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

  try {
    const query = req.query && typeof req.query === 'object' ? req.query : {};
    const report = await decisionAnalytics.loadCampaignDecisionAnalytics({ campaign, query });
    const staleThresholdSeconds = reportProvenance.parseStaleThresholdSeconds(query.stale_after_minutes);
    const strictFreshness = reportProvenance.parseBooleanFlag(query.strict_freshness);
    const persist = reportProvenance.parseBooleanFlag(query.persist);
    const surface = reportProvenance.normalizeSurface(query.surface, 'json');
    const lastDataAt = report.badges && report.badges.freshness ? report.badges.freshness.last_recorded_click_at : null;
    const payloadForHash = {
      core_kpis: report.core_kpis,
      channel_comparison: report.channel_comparison,
      goal_breakdown: report.goal_breakdown,
      revenue_by_currency: report.revenue_by_currency,
    };

    const provenance = persist
      ? await reportProvenance.createAndPersistReportSnapshot({
          campaign,
          actorUserId: userId,
          surface,
          reportType: 'campaign_decision',
          dateRange: report.range,
          filters: {
            bots: report.badges.bot_filter,
            window_days: report.badges.attribution_window_days,
            model: report.badges.attribution_model,
          },
          metricMethod: report.badges.source_method,
          dataSources: ['clicks', 'conversion_events', 'link_conversions'],
          lastDataAt,
          generatedAt: report.range.generated_at,
          payloadForHash,
          summaryData: {
            campaign: report.campaign,
            core_kpis: report.core_kpis,
            decision_summary: report.decision_summary,
          },
          auditAction: 'campaign.decision.snapshot',
          staleThresholdSeconds,
        })
      : reportProvenance.buildReportProvenance({
          campaign,
          actorUserId: userId,
          surface,
          reportType: 'campaign_decision',
          dateRange: report.range,
          filters: {
            bots: report.badges.bot_filter,
            window_days: report.badges.attribution_window_days,
            model: report.badges.attribution_model,
          },
          metricMethod: report.badges.source_method,
          dataSources: ['clicks', 'conversion_events', 'link_conversions'],
          lastDataAt,
          generatedAt: report.range.generated_at,
          payloadForHash,
          staleThresholdSeconds,
        });

    report.provenance = provenance;
    const headers = reportProvenance.buildProvenanceHeaders(provenance);
    if (strictFreshness && provenance.freshness && provenance.freshness.is_stale) {
      return res.status(503).set(headers).json({
        error: 'Hesabat məlumatı köhnəlib (stale).',
        stale: true,
        provenance,
      });
    }
    return res.set(headers).json(report);
  } catch {
    return res.status(503).json({ error: 'Qərar analitikası hazır deyil. Yenidən cəhd edin.' });
  }
});

router.get('/api/campaigns/:id/decision.csv', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const campaign = await campaignLib.getCampaignForActor({ userId, campaignId: req.params.id });
  if (!campaign) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

  try {
    const query = req.query && typeof req.query === 'object' ? req.query : {};
    const requestedRawPii = reportProvenance.parseBooleanFlag(query.include_raw_pii || query.raw_pii);
    const requestedSurface = reportProvenance.normalizeSurface(query.surface, 'csv');
    if (requestedRawPii) {
      const workspaceRole = campaign.workspace_id
        ? await getWorkspaceMemberRole(userId, campaign.workspace_id).catch(() => null)
        : null;
      const access = reportProvenance.canExportRawPersonalData({
        actorUserId: userId,
        ownerUserId: campaign.user_id,
        workspaceId: campaign.workspace_id,
        workspaceRole,
        isAdmin: Boolean(req.session && req.session.isAdmin),
        surface: requestedSurface,
      });
      if (!access.allowed) {
        return res.status(403).json({
          error: 'Şəxsi məlumatların (raw PII) ixracına icazəniz yoxdur.',
          code: access.code,
          reason: access.reason,
        });
      }
    }

    const report = await decisionAnalytics.loadCampaignDecisionAnalytics({ campaign, query });
    const staleThresholdSeconds = reportProvenance.parseStaleThresholdSeconds(query.stale_after_minutes);
    const strictFreshness = reportProvenance.parseBooleanFlag(query.strict_freshness);
    const lastDataAt = report.badges && report.badges.freshness ? report.badges.freshness.last_recorded_click_at : null;
    const payloadForHash = {
      core_kpis: report.core_kpis,
      channel_comparison: report.channel_comparison,
      goal_breakdown: report.goal_breakdown,
      revenue_by_currency: report.revenue_by_currency,
    };

    const provenance = await reportProvenance.createAndPersistReportSnapshot({
      campaign,
      actorUserId: userId,
      surface: requestedSurface,
      reportType: 'campaign_decision',
      dateRange: report.range,
      filters: {
        bots: report.badges.bot_filter,
        window_days: report.badges.attribution_window_days,
        model: report.badges.attribution_model,
      },
      metricMethod: report.badges.source_method,
      dataSources: ['clicks', 'conversion_events', 'link_conversions'],
      lastDataAt,
      generatedAt: report.range.generated_at,
      payloadForHash,
      summaryData: {
        campaign: report.campaign,
        core_kpis: report.core_kpis,
        decision_summary: report.decision_summary,
      },
      auditAction: 'campaign.decision.csv.export',
      staleThresholdSeconds,
      rawPiiRequested: requestedRawPii,
    });

    report.provenance = provenance;
    const headers = reportProvenance.buildProvenanceHeaders(provenance);
    if (strictFreshness && provenance.freshness && provenance.freshness.is_stale) {
      return res.status(503).set(headers).json({
        error: 'Hesabat məlumatı köhnəlib (stale).',
        stale: true,
        provenance,
      });
    }

    const csv = decisionAnalytics.buildDecisionCsv(report);
    const safeSlug = String(campaign.slug || campaign.id).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
    return res
      .set('Cache-Control', 'private, no-store, max-age=0')
      .set('X-Content-Type-Options', 'nosniff')
      .set(headers)
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="ovlink-decision-${safeSlug}.csv"`)
      .send(csv);
  } catch {
    return res.status(503).json({ error: 'CSV hesabatı hazır deyil. Yenidən cəhd edin.' });
  }
});

// GET /api/campaigns/:id/snapshots — list historical report snapshots for provenance verification
router.get('/api/campaigns/:id/snapshots', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const campaign = await campaignLib.getCampaignForActor({ userId, campaignId: req.params.id });
  if (!campaign) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

  try {
    const snapshots = await reportProvenance.listCampaignReportSnapshots({
      campaignId: campaign.id,
      limit: req.query && req.query.limit,
    });
    return res.json({
      campaign_id: Number(campaign.id),
      contract_version: reportProvenance.PROVENANCE_CONTRACT_VERSION,
      snapshots,
    });
  } catch {
    return res.status(503).json({ error: 'Hesabat arxivinə çıxış müvəqqəti əlçatan deyil.' });
  }
});

// GET /api/campaigns/:id/snapshots/:snapshotId — retrieve a previous snapshot document (same contract for JSON/CSV/PDF/Portal)
router.get('/api/campaigns/:id/snapshots/:snapshotId', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const campaign = await campaignLib.getCampaignForActor({ userId, campaignId: req.params.id });
  if (!campaign) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

  try {
    const targetSurface = req.query && req.query.surface ? req.query.surface : null;
    const snapshot = await reportProvenance.getCampaignReportSnapshot({
      campaignId: campaign.id,
      snapshotId: req.params.snapshotId,
      targetSurface,
    });
    if (!snapshot) return res.status(404).json({ error: 'Hesabat snapshot-u tapılmadı.' });
    return res.set(reportProvenance.buildProvenanceHeaders(snapshot.provenance)).json(snapshot);
  } catch {
    return res.status(503).json({ error: 'Hesabat snapshot-u yüklənmədi.' });
  }
});

// ===== P25: Reusable Agency Report Templates =====

router.get('/api/report-templates', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });
  try {
    const templates = await reportTemplates.listReportTemplates({
      userId,
      clientId: req.query && req.query.client_id,
    });
    return res.json({ contract_version: reportTemplates.REPORT_TEMPLATE_CONTRACT_VERSION, templates });
  } catch {
    return res.status(500).json({ error: 'Hesabat şablonları alına bilmədi.' });
  }
});

router.post('/api/report-templates', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });
  try {
    const result = await reportTemplates.createReportTemplate({ userId, body: req.body });
    if (result.error) {
      return res.status(result.statusCode || 400).json({ error: result.message || result.error, code: result.error });
    }
    return res.status(201).json({ template: result.template });
  } catch {
    return res.status(500).json({ error: 'Hesabat şablonu yaradıla bilmədi.' });
  }
});

router.patch('/api/report-templates/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });
  try {
    const result = await reportTemplates.updateReportTemplate({ userId, templateId: req.params.id, body: req.body });
    if (result.error) {
      return res.status(result.statusCode || 400).json({ error: result.message || result.error, code: result.error });
    }
    return res.json({ template: result.template });
  } catch {
    return res.status(500).json({ error: 'Hesabat şablonu yenilənə bilmədi.' });
  }
});

router.delete('/api/report-templates/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });
  try {
    const result = await reportTemplates.deleteReportTemplate({ userId, templateId: req.params.id });
    if (result.error) return res.status(result.statusCode || 404).json({ error: 'Şablon tapılmadı.', code: result.error });
    return res.json(result);
  } catch {
    return res.status(500).json({ error: 'Hesabat şablonu silinmədi.' });
  }
});

router.get('/api/campaigns/:id/template-report', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const campaign = await campaignLib.getCampaignForActor({ userId, campaignId: req.params.id });
  if (!campaign) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

  try {
    const query = req.query && typeof req.query === 'object' ? req.query : {};
    let template = null;
    if (query.template_id) {
      template = await reportTemplates.getReportTemplateForActor({ userId, templateId: query.template_id });
      if (!template) return res.status(404).json({ error: 'Hesabat şablonu tapılmadı.' });
    }
    const effectiveQuery = {
      ...query,
      days: query.days || (template && template.default_period_days) || 30,
    };
    const [campaignStats, decisionReport] = await Promise.all([
      campaignLib.loadCampaignStats({ campaign, query: effectiveQuery }),
      decisionAnalytics.loadCampaignDecisionAnalytics({ campaign, query: effectiveQuery }).catch(() => null),
    ]);
    const provenance = reportProvenance.buildReportProvenance({
      campaign,
      actorUserId: userId,
      surface: query.format === 'html' ? 'pdf' : 'json',
      reportType: 'campaign_template_report',
      dateRange: campaignStats.range,
      filters: { bots: campaignStats.range.bots },
      lastDataAt: campaignStats.last_recorded_click_at,
      generatedAt: campaignStats.generated_at,
      payloadForHash: {
        clicks: campaignStats.clicks,
        uniques: campaignStats.uniques,
        conversions: campaignStats.conversions,
        conversion_rate: campaignStats.conversion_rate,
      },
    });

    const rendered = reportTemplates.renderCampaignReportFromTemplate({
      template,
      campaignStats,
      decisionReport,
      provenance,
      clientOverride: query.client_name ? { name: query.client_name, logo_url: query.logo_url } : null,
      lang: query.lang,
    });

    if (String(query.format || '').toLowerCase() === 'html') {
      return res
        .set('Cache-Control', 'private, no-store, max-age=0')
        .set('X-Content-Type-Options', 'nosniff')
        .set(reportProvenance.buildProvenanceHeaders(provenance))
        .set('Content-Type', 'text/html; charset=utf-8')
        .send(reportTemplates.renderTemplatePrintHtml(rendered));
    }
    return res.set(reportProvenance.buildProvenanceHeaders(provenance)).json(rendered);
  } catch {
    return res.status(503).json({ error: 'Şablon hesabatı hazırlana bilmədi.' });
  }
});

module.exports = router;
module.exports.ERROR_MESSAGES = ERROR_MESSAGES;
module.exports.currentUserId = currentUserId;
module.exports.CAMPAIGN_ASSIGNMENT_SQL = CAMPAIGN_ASSIGNMENT_SQL;
