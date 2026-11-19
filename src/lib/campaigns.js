'use strict';

/**
 * Campaigns: a named group of short links (client / channel / launch) with
 * aggregated statistics. Links are never destroyed when a campaign is removed.
 */

const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../db/helpers');
const { REDIRECT_CONSENT_MARKER } = require('./consent');
const { getWorkspaceMemberRole, isWorkspaceProActive, getWorkspaceById } = require('../routes/api/workspaces');
const { canWorkspaceRole } = require('./link-access');
const {
  buildMetricsContractMeta,
  reconcileRawVsRollup,
} = require('./metrics-contract');
const {
  CAMPAIGN_STATUSES,
  generateCampaignEventId,
  normalizeCampaignStatus,
  resolveEffectiveStatus,
  evaluateStatusTransition,
  validateUtcInterval,
  normalizeBudget,
  ensureCampaignModelColumns,
  recordCampaignAudit,
} = require('./campaign-model');
const {
  parseRange,
  parseBotsFilter,
  buildDaySeries,
  rowsToCountMap,
  topEntries,
  addDays,
  isoDay,
  normalizeBucketName,
  toInt,
} = require('./link-stats');

const CAMPAIGN_NAME_MAX = 60;
const CAMPAIGN_SLUG_MAX = 40;
const CAMPAIGN_LIST_LIMIT = 200;
const TOP_LINKS_LIMIT = 20;
const MAX_GOAL_TARGET = 1000000000;

/** Integer >= 0 or null (no goal). */
function normalizeGoalTarget(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) return null;
  return Math.min(MAX_GOAL_TARGET, value);
}

/**
 * Progress of an actual value against an optional target. `percent` is the raw
 * ratio (can exceed 100) while `bar_percent` is clamped for the progress bar.
 */
function computeGoalProgress({ actual, target } = {}) {
  const actualValue = Math.max(0, Number(actual) || 0);
  const targetValue = normalizeGoalTarget(target);
  if (!targetValue) {
    return { target: targetValue, actual: actualValue, percent: null, bar_percent: 0, remaining: null, achieved: false };
  }
  const percent = Math.round((actualValue / targetValue) * 1000) / 10;
  return {
    target: targetValue,
    actual: actualValue,
    percent,
    bar_percent: Math.min(100, percent),
    remaining: Math.max(0, targetValue - actualValue),
    achieved: actualValue >= targetValue,
  };
}

function normalizeCampaignName(raw) {
  const value = (raw === null || raw === undefined ? '' : raw)
    .toString()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return '';
  return value.slice(0, CAMPAIGN_NAME_MAX);
}

// Azerbaijani/Turkish letters do not decompose under NFKD, so transliterate them
// explicitly to keep slugs readable ("Yay Satışı" -> "yay-satisi").
const SLUG_CHAR_MAP = {
  '\u0259': 'e',
  '\u0131': 'i',
  '\u0130': 'i',
  '\u011f': 'g',
  '\u011e': 'g',
  '\u015f': 's',
  '\u015e': 's',
  '\u00e7': 'c',
  '\u00c7': 'c',
  '\u00f6': 'o',
  '\u00d6': 'o',
  '\u00fc': 'u',
  '\u00dc': 'u',
};

function slugifyCampaignName(raw) {
  const value = normalizeCampaignName(raw)
    .toLowerCase()
    .replace(/[\u0259\u0131\u0130\u011f\u011e\u015f\u015e\u00e7\u00c7\u00f6\u00d6\u00fc\u00dc]/g, (ch) => SLUG_CHAR_MAP[ch] || ch)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return value.slice(0, CAMPAIGN_SLUG_MAX);
}

function mapCampaignRow(row) {
  if (!row) return null;
  const goalClicks = normalizeGoalTarget(row.goal_clicks);
  const goalConversions = normalizeGoalTarget(row.goal_conversions);
  const clicks = Number(row.clicks || 0);
  const conversions = Number(row.conversions || 0);
  const budgetAmount = row.budget_amount === null || row.budget_amount === undefined
    ? null
    : Number(row.budget_amount);
  return {
    id: Number(row.id),
    name: row.name || '',
    slug: row.slug || '',
    status: resolveEffectiveStatus(row),
    event_id: row.event_id || null,
    starts_at: row.starts_at || null,
    ends_at: row.ends_at || null,
    budget_amount: Number.isFinite(budgetAmount) ? budgetAmount : null,
    budget_currency: Number.isFinite(budgetAmount) ? (row.budget_currency || 'AZN') : null,
    workspace_id: row.workspace_id ? Number(row.workspace_id) : null,
    can_manage: row.can_manage === undefined ? true : !!Number(row.can_manage),
    goal: row.goal || '',
    goal_clicks: goalClicks,
    goal_conversions: goalConversions,
    goal_progress: {
      clicks: computeGoalProgress({ actual: clicks, target: goalClicks }),
      conversions: computeGoalProgress({ actual: conversions, target: goalConversions }),
    },
    created_at: row.created_at || null,
    archived_at: row.archived_at || null,
    links_count: Number(row.links_count || 0),
    clicks,
    uniques: Number(row.uniques || 0),
    bots: Number(row.bots || 0),
    conversions,
  };
}

/** Creates a campaign, returning `{ error }` for validation/duplicate cases. */
async function createCampaign({
  userId,
  name,
  goal,
  goalClicks,
  goalConversions,
  workspaceId = null,
  status = 'active',
  startsAt = null,
  endsAt = null,
  budgetAmount = null,
  budgetCurrency = null,
}) {
  const ownerId = Number.parseInt(userId, 10);
  if (!Number.isInteger(ownerId) || ownerId <= 0) return { error: 'unauthorized' };

  await ensureCampaignModelColumns(dbRunAsync, dbGetAsync);

  const initialStatus = status === undefined || status === null || status === ''
    ? 'active'
    : normalizeCampaignStatus(status);
  if (!initialStatus || !['draft', 'active'].includes(initialStatus)) {
    return { error: 'invalid_status' };
  }

  const interval = validateUtcInterval(startsAt, endsAt);
  if (interval.error) return { error: interval.error };

  const budget = normalizeBudget(budgetAmount, budgetCurrency);
  if (budget.error) return { error: budget.error };

  let ownerIdForCampaign = ownerId;
  let scopedWorkspaceId = null;
  if (workspaceId !== null && workspaceId !== undefined && workspaceId !== '') {
    const requestedWorkspace = Number(workspaceId);
    if (!Number.isSafeInteger(requestedWorkspace) || requestedWorkspace <= 0) return { error: 'invalid_workspace' };
    const workspace = await getWorkspaceById(requestedWorkspace);
    if (!workspace) return { error: 'workspace_not_found' };
    const role = await getWorkspaceMemberRole(ownerId, requestedWorkspace);
    if (!canWorkspaceRole(role, 'campaign.create')) return { error: 'workspace_forbidden' };
    if (!await isWorkspaceProActive(workspace)) return { error: 'workspace_inactive' };
    ownerIdForCampaign = Number(workspace.owner_user_id);
    scopedWorkspaceId = requestedWorkspace;
  }

  const cleanName = normalizeCampaignName(name);
  if (cleanName.length < 2) return { error: 'invalid_name' };

  const slug = slugifyCampaignName(cleanName);
  if (!slug) return { error: 'invalid_name' };

  const existing = await dbGetAsync(
    'SELECT id FROM campaigns WHERE user_id = ? AND slug = ? LIMIT 1',
    [ownerIdForCampaign, slug]
  ).catch(() => null);
  if (existing) return { error: 'duplicate' };

  const targetClicks = normalizeGoalTarget(goalClicks);
  const targetConversions = normalizeGoalTarget(goalConversions);
  const eventId = generateCampaignEventId();
  const createdAt = new Date().toISOString();

  const inserted = await dbRunAsync(
    `INSERT INTO campaigns
       (user_id, workspace_id, name, slug, goal, goal_clicks, goal_conversions, status, starts_at, ends_at, budget_amount, budget_currency, event_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ownerIdForCampaign,
      scopedWorkspaceId,
      cleanName,
      slug,
      normalizeCampaignName(goal) || null,
      targetClicks,
      targetConversions,
      initialStatus,
      interval.starts_at,
      interval.ends_at,
      budget.budget_amount,
      budget.budget_currency,
      eventId,
      createdAt,
    ]
  ).catch(() => null);

  if (!inserted) return { error: 'db_error' };
  const campaignId = Number(inserted.lastID);
  await recordCampaignAudit(dbRunAsync, {
    userId: ownerId,
    action: 'campaign.created',
    campaignId,
    metadata: {
      event_id: eventId,
      status: initialStatus,
      workspace_id: scopedWorkspaceId,
      budget_amount: budget.budget_amount,
      budget_currency: budget.budget_currency,
    },
  });

  return {
    campaign: {
      id: campaignId,
      workspace_id: scopedWorkspaceId,
      name: cleanName,
      slug,
      status: initialStatus,
      event_id: eventId,
      starts_at: interval.starts_at,
      ends_at: interval.ends_at,
      budget_amount: budget.budget_amount,
      budget_currency: budget.budget_currency,
      goal: normalizeCampaignName(goal) || '',
      goal_clicks: targetClicks,
      goal_conversions: targetConversions,
      created_at: createdAt,
      archived_at: null,
    },
  };
}

async function getCampaignForUser({ userId, campaignId }) {
  const ownerId = Number.parseInt(userId, 10);
  const id = Number.parseInt(campaignId, 10);
  if (!Number.isInteger(ownerId) || ownerId <= 0 || !Number.isInteger(id) || id <= 0) return null;
  return dbGetAsync('SELECT * FROM campaigns WHERE id = ? AND user_id = ? LIMIT 1', [id, ownerId]).catch(() => null);
}

async function getCampaignForActor({ userId, campaignId, write = false }) {
  const uid = Number(userId);
  const id = Number(campaignId);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(id) || id <= 0) return null;
  await ensureCampaignModelColumns(dbRunAsync, dbGetAsync);
  const roles = write ? " AND wm.role IN ('owner', 'admin')" : '';
  return dbGetAsync(
    'SELECT c.*, CASE WHEN c.workspace_id IS NULL THEN 1 WHEN EXISTS ' +
    "(SELECT 1 FROM workspace_members wm2 WHERE wm2.workspace_id = c.workspace_id AND wm2.user_id = ? AND wm2.role IN ('owner','admin')) THEN 1 ELSE 0 END AS can_manage " +
    'FROM campaigns c WHERE c.id = ? AND (' +
    ' (c.workspace_id IS NULL AND c.user_id = ?) OR ' +
    ' (c.workspace_id IS NOT NULL AND EXISTS (SELECT 1 FROM workspace_members wm ' +
    ' WHERE wm.workspace_id = c.workspace_id AND wm.user_id = ?' + roles + '))' +
    ') LIMIT 1',
    [uid, id, uid, uid]
  );
}

async function listCampaigns({ userId, days, includeArchived = false, status = null } = {}) {
  const ownerId = Number.parseInt(userId, 10);
  if (!Number.isInteger(ownerId) || ownerId <= 0) return [];

  await ensureCampaignModelColumns(dbRunAsync, dbGetAsync);

  const normalizedStatus = normalizeCampaignStatus(status);
  const range = parseRange(days);
  const dayClause = range.all ? '' : ' AND d.day >= ?';
  const params = [ownerId];
  if (!range.all) params.push(isoDay(addDays(new Date(), -range.days)));
  params.push(ownerId, ownerId);

  let statusClause = '';
  if (normalizedStatus === 'archived') {
    statusClause = " AND (c.archived_at IS NOT NULL OR c.status = 'archived')";
  } else if (normalizedStatus) {
    statusClause = " AND c.archived_at IS NULL AND COALESCE(c.status, 'active') = ?";
    params.push(normalizedStatus);
  } else if (!includeArchived) {
    statusClause = ' AND c.archived_at IS NULL';
  }

  const sql =
    'SELECT c.id, c.name, c.slug, c.goal, c.goal_clicks, c.goal_conversions, ' +
    'c.status, c.starts_at, c.ends_at, c.budget_amount, c.budget_currency, c.event_id, ' +
    'c.created_at, c.archived_at, c.workspace_id, ' +
    'CASE WHEN c.workspace_id IS NULL THEN 1 WHEN EXISTS ' +
    "(SELECT 1 FROM workspace_members wm2 WHERE wm2.workspace_id = c.workspace_id AND wm2.user_id = ? AND wm2.role IN ('owner','admin')) THEN 1 ELSE 0 END AS can_manage, " +
    'COUNT(DISTINCT u.id) AS links_count, ' +
    'COALESCE(SUM(d.clicks), 0) AS clicks, ' +
    'COALESCE(SUM(d.uniques), 0) AS uniques, ' +
    'COALESCE(SUM(d.bots), 0) AS bots, ' +
    'COALESCE(SUM(d.conversions), 0) AS conversions ' +
    'FROM campaigns c ' +
    'LEFT JOIN urls u ON u.campaign_id = c.id ' +
    'LEFT JOIN link_stats_daily d ON d.url_id = u.id' + dayClause + ' ' +
    'WHERE ((c.workspace_id IS NULL AND c.user_id = ?) OR ' +
    ' (c.workspace_id IS NOT NULL AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = c.workspace_id AND wm.user_id = ?)))' +
    statusClause + ' ' +
    'GROUP BY c.id, c.name, c.slug, c.goal, c.goal_clicks, c.goal_conversions, c.status, c.starts_at, c.ends_at, c.budget_amount, c.budget_currency, c.event_id, c.created_at, c.archived_at, c.workspace_id ' +
    'ORDER BY clicks DESC, c.id DESC ' +
    `LIMIT ${CAMPAIGN_LIST_LIMIT}`;

  // A database outage must not look like a genuinely empty campaign portfolio.
  const rows = await dbAllAsync(sql, params);
  return (rows || []).map(mapCampaignRow);
}

/** Human-only analytics is intentionally computed from raw events; the daily
 * rollup has no human-only uniques/conversions. Conversion attribution requires
 * a preceding non-bot click by the same hashed visitor on the same link.
 * Unmatched conversions are excluded and explicitly described in the payload.
 */
async function loadHumanCampaignStats({ campaign, range, now, rangeStartIso, rangeStartDay, endDay }) {
  const campaignId = Number(campaign.id);
  const clickPeriod = rangeStartIso ? ' AND c.click_time >= ?' : '';
  const convPeriod = rangeStartIso ? ' AND v.created_at >= ?' : '';
  const clickArgs = rangeStartIso ? [campaignId, rangeStartIso] : [campaignId];
  const convArgs = rangeStartIso ? [campaignId, rangeStartIso] : [campaignId];
  const humans = ' AND COALESCE(c.is_bot, 0) = 0';
  const uniqueByVisit = "COUNT(DISTINCT (c.url_id, LEFT(c.click_time, 10), c.ip_hash)) FILTER (WHERE c.ip_hash IS NOT NULL AND c.ip_hash <> '')";
  const verifiedConversion =
    ' AND EXISTS (SELECT 1 FROM clicks c WHERE c.url_id = v.url_id AND c.ip_hash = v.ip_hash ' +
    ' AND c.click_time <= v.created_at AND COALESCE(c.is_bot, 0) = 0)';
  const [totals, links, daily, sources, conversionGroups, linkCount] = await Promise.all([
    dbGetAsync('SELECT COUNT(c.id) AS clicks, ' + uniqueByVisit + ' AS uniques, ' +
      'COUNT(c.id) FILTER (WHERE c.browser = ?) AS essential_clicks, ' +
      'MAX(c.click_time) AS last_click_at ' +
      'FROM clicks c JOIN urls u ON u.id=c.url_id WHERE u.campaign_id = ?' + clickPeriod + humans,
      [REDIRECT_CONSENT_MARKER, ...clickArgs]),
    dbAllAsync('SELECT u.id, u.short, u.original, u.created_at, COUNT(c.id) AS clicks, ' +
      uniqueByVisit + ' AS uniques FROM urls u LEFT JOIN clicks c ON c.url_id=u.id' +
      (rangeStartIso ? ' AND c.click_time >= ?' : '') + humans +
      ' WHERE u.campaign_id = ? GROUP BY u.id, u.short, u.original, u.created_at ' +
      `ORDER BY clicks DESC, u.id DESC LIMIT ${TOP_LINKS_LIMIT}`,
      rangeStartIso ? [rangeStartIso, campaignId] : [campaignId]),
    dbAllAsync("SELECT LEFT(c.click_time, 10) AS name, COUNT(*) AS clicks FROM clicks c JOIN urls u ON u.id=c.url_id " +
      'WHERE u.campaign_id = ?' + clickPeriod + humans + ' GROUP BY LEFT(c.click_time, 10)', clickArgs),
    dbAllAsync("SELECT COALESCE(NULLIF(c.referrer_host,''),'direct') AS name, COUNT(*) AS count " +
      'FROM clicks c JOIN urls u ON u.id=c.url_id WHERE u.campaign_id = ?' + clickPeriod + humans +
      " GROUP BY COALESCE(NULLIF(c.referrer_host,''),'direct') ORDER BY count DESC LIMIT 12", clickArgs),
    dbAllAsync('SELECT v.url_id, v.goal, COUNT(*) AS count FROM link_conversions v ' +
      'JOIN urls u ON u.id=v.url_id WHERE u.campaign_id = ?' + convPeriod + verifiedConversion +
      ' GROUP BY v.url_id, v.goal', convArgs),
    dbGetAsync('SELECT COUNT(*) AS count FROM urls WHERE campaign_id = ?', [campaignId]),
  ]);
  const perLink = new Map();
  const perGoal = new Map();
  let conversionCount = 0;
  for (const row of conversionGroups || []) {
    const count = Number(row.count || 0);
    conversionCount += count;
    perLink.set(Number(row.url_id), (perLink.get(Number(row.url_id)) || 0) + count);
    const key = normalizeBucketName(row.goal);
    perGoal.set(key, (perGoal.get(key) || 0) + count);
  }
  const goals = [...perGoal].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count).slice(0, 12);
  const totalsRow = { ...totals, bots: 0, conversions: conversionCount };
  const linksRow = (links || []).map(row => ({ ...row, conversions: perLink.get(Number(row.id)) || 0 }));
  return formatCampaignStats({ campaign, range, includeBots: false, now, rangeStartIso,
    rangeStartDay, endDay, totalsRow, linksRow, dailyRow: daily, sourcesRow: sources,
    goalsRow: goals, linksCountRow: linkCount });
}

function formatCampaignStats({ campaign, range, includeBots, now, rangeStartIso, rangeStartDay,
  endDay, totalsRow, linksRow, dailyRow, sourcesRow, goalsRow, linksCountRow }) {
  const campaignId = Number(campaign.id);
  const clicks = totalsRow ? Number(totalsRow.clicks || 0) : 0;
  const uniques = totalsRow ? Number(totalsRow.uniques || 0) : 0;
  const bots = totalsRow ? Number(totalsRow.bots || 0) : 0;
  const conversions = totalsRow ? Number(totalsRow.conversions || 0) : 0;

  const dayCounts = {};
  (dailyRow || []).forEach((row) => {
    const day = normalizeBucketName(row.name);
    if (day === 'Unknown') return;
    dayCounts[day] = (dayCounts[day] || 0) + Number(row.clicks || 0);
  });
  const seriesStart = rangeStartDay || Object.keys(dayCounts).sort()[0] || endDay;

  const budgetAmount = campaign.budget_amount === null || campaign.budget_amount === undefined
    ? null
    : Number(campaign.budget_amount);

  return {
    campaign: {
      id: campaignId,
      workspace_id: campaign.workspace_id ? Number(campaign.workspace_id) : null,
      can_manage: campaign.can_manage === undefined ? true : !!Number(campaign.can_manage),
      name: campaign.name || '',
      slug: campaign.slug || '',
      status: resolveEffectiveStatus(campaign),
      event_id: campaign.event_id || null,
      starts_at: campaign.starts_at || null,
      ends_at: campaign.ends_at || null,
      budget_amount: Number.isFinite(budgetAmount) ? budgetAmount : null,
      budget_currency: Number.isFinite(budgetAmount) ? (campaign.budget_currency || 'AZN') : null,
      goal: campaign.goal || '',
      goal_clicks: normalizeGoalTarget(campaign.goal_clicks),
      goal_conversions: normalizeGoalTarget(campaign.goal_conversions),
      created_at: campaign.created_at || null,
      archived_at: campaign.archived_at || null,
    },
    range: {
      days: range.all ? 'all' : range.days,
      from: rangeStartIso,
      to: now.toISOString(),
      bots: includeBots ? 'include' : 'exclude',
    },
    links_count: linksCountRow ? Number(linksCountRow.count || 0) : 0,
    clicks,
    uniques,
    bots,
    conversions,
    goal_progress: {
      clicks: computeGoalProgress({ actual: clicks, target: normalizeGoalTarget(campaign.goal_clicks) }),
      conversions: computeGoalProgress({ actual: conversions, target: normalizeGoalTarget(campaign.goal_conversions) }),
    },
    conversion_rate: clicks > 0 ? Math.round((conversions / clicks) * 1000) / 10 : 0,
    clicks_by_day: buildDaySeries(seriesStart, endDay, dayCounts),
    top_links: (linksRow || []).map((row) => ({
      short: row.short,
      original: row.original,
      created_at: row.created_at || null,
      clicks: Number(row.clicks || 0),
      uniques: Number(row.uniques || 0),
      conversions: Number(row.conversions || 0),
    })),
    sources: rowsToCountMap(sourcesRow),
    top_sources: topEntries(sourcesRow),
    goals: rowsToCountMap(goalsRow),
    top_goals: topEntries(goalsRow),
    generated_at: now.toISOString(),
    last_recorded_click_at: totalsRow && totalsRow.last_click_at || null,
    metric_method: includeBots ? 'daily_rollup' : 'raw_nonbot_events',
    unique_method: includeBots ? 'daily_unique_rollup' : 'per_link_per_day_hashed_visitor',
    conversion_method: includeBots ? 'all_recorded_conversions' : 'conversions_with_prior_nonbot_click_match',
    data_contract: buildMetricsContractMeta({
      includeBots,
      conversionsCount: conversions,
      revenueAvailable: false,
      essentialClicksCount: includeBots
        ? null
        : (totalsRow && totalsRow.essential_clicks !== undefined ? Number(totalsRow.essential_clicks || 0) : 0),
    }),
  };
}

/**
 * Aggregated campaign statistics across every link assigned to it.
 */
async function loadCampaignStats({ campaign, query } = {}) {
  if (!campaign || !campaign.id) throw new Error('loadCampaignStats requires a campaign row');

  const q = query && typeof query === 'object' ? query : {};
  const range = parseRange(q.days || q.range);
  const includeBots = parseBotsFilter(q.bots);
  const now = new Date();
  const endDay = isoDay(now);
  const rangeStart = range.all ? null : addDays(now, -range.days);
  const rangeStartDay = rangeStart ? isoDay(rangeStart) : null;
  const rangeStartIso = rangeStart ? rangeStart.toISOString() : null;
  const campaignId = Number(campaign.id);
  if (!includeBots) {
    return loadHumanCampaignStats({ campaign, range, now, rangeStartIso, rangeStartDay, endDay });
  }

  const dayClause = rangeStartDay ? ' AND d.day >= ?' : '';
  const dayParams = rangeStartDay ? [rangeStartDay] : [];
  const clickClause = rangeStartIso ? ' AND c.click_time >= ?' : '';
  const clickParams = rangeStartIso ? [rangeStartIso] : [];
  const conversionClause = rangeStartIso ? ' AND v.created_at >= ?' : '';
  const conversionParams = rangeStartIso ? [rangeStartIso] : [];
  const botClause = includeBots ? '' : ' AND COALESCE(c.is_bot, 0) = 0';

  const [totalsRow, linksRow, dailyRow, sourcesRow, goalsRow, linksCountRow] = await Promise.all([
    dbGetAsync(
      'SELECT COALESCE(SUM(d.clicks), 0) AS clicks, COALESCE(SUM(d.uniques), 0) AS uniques, ' +
        'COALESCE(SUM(d.bots), 0) AS bots, COALESCE(SUM(d.conversions), 0) AS conversions, MAX(d.last_click_at) AS last_click_at ' +
        'FROM link_stats_daily d JOIN urls u ON u.id = d.url_id ' +
        'WHERE u.campaign_id = ?' + dayClause,
      [campaignId, ...dayParams]
    ),
    dbAllAsync(
      'SELECT u.short, u.original, u.created_at, COALESCE(SUM(d.clicks), 0) AS clicks, ' +
        'COALESCE(SUM(d.uniques), 0) AS uniques, COALESCE(SUM(d.conversions), 0) AS conversions ' +
        'FROM urls u LEFT JOIN link_stats_daily d ON d.url_id = u.id' + dayClause + ' ' +
        'WHERE u.campaign_id = ? ' +
        'GROUP BY u.id, u.short, u.original, u.created_at ' +
        `ORDER BY clicks DESC, u.id DESC LIMIT ${TOP_LINKS_LIMIT}`,
      [...dayParams, campaignId]
    ),
    dbAllAsync(
      'SELECT d.day AS name, COALESCE(SUM(d.clicks), 0) AS clicks, COALESCE(SUM(d.uniques), 0) AS uniques ' +
        'FROM link_stats_daily d JOIN urls u ON u.id = d.url_id ' +
        'WHERE u.campaign_id = ?' + dayClause + ' GROUP BY d.day',
      [campaignId, ...dayParams]
    ),
    dbAllAsync(
      "SELECT COALESCE(NULLIF(c.referrer_host, ''), 'direct') AS name, COUNT(*) AS count " +
        'FROM clicks c JOIN urls u ON u.id = c.url_id ' +
        'WHERE u.campaign_id = ?' + clickClause + botClause + ' ' +
        'GROUP BY COALESCE(NULLIF(c.referrer_host, \'\'), \'direct\') ORDER BY count DESC LIMIT 12',
      [campaignId, ...clickParams]
    ),
    dbAllAsync(
      'SELECT v.goal AS name, COUNT(*) AS count ' +
        'FROM link_conversions v JOIN urls u ON u.id = v.url_id ' +
        'WHERE u.campaign_id = ?' + conversionClause + ' GROUP BY v.goal ORDER BY count DESC LIMIT 12',
      [campaignId, ...conversionParams]
    ),
    dbGetAsync('SELECT COUNT(*) AS count FROM urls WHERE campaign_id = ?', [campaignId]),
  ]);

  return formatCampaignStats({ campaign, range, includeBots, now, rangeStartIso,
    rangeStartDay, endDay, totalsRow, linksRow, dailyRow, sourcesRow, goalsRow, linksCountRow });
}

/** Loads all assets (links, active QR codes, optional client space) linked to a campaign. */
async function loadCampaignAssets({ campaign } = {}) {
  if (!campaign || !campaign.id) throw new Error('loadCampaignAssets requires a campaign row');
  const campaignId = Number(campaign.id);

  const [links, qrCodes] = await Promise.all([
    dbAllAsync(
      `SELECT u.id, u.short, u.original, u.created_at,
              COALESCE((SELECT COUNT(*) FROM clicks cl WHERE cl.url_id = u.id), 0) AS clicks
         FROM urls u
        WHERE u.campaign_id = ?
        ORDER BY u.id DESC
        LIMIT 200`,
      [campaignId]
    ),
    dbAllAsync(
      `SELECT q.id, q.url_id, q.short, q.slug, q.label, q.scans, q.created_at
         FROM qr_codes q
         JOIN urls u ON u.id = q.url_id
        WHERE u.campaign_id = ? AND q.deleted_at IS NULL
        ORDER BY q.id DESC
        LIMIT 200`,
      [campaignId]
    ).catch(() => []),
  ]);

  let clientSpace = null;
  try {
    const clientRow = await dbGetAsync(
      `SELECT cs.id, cs.name, cs.slug, cs.status
         FROM organization_client_campaigns occ
         JOIN organization_client_spaces cs ON cs.id = occ.client_id
        WHERE occ.campaign_id = ?
        LIMIT 1`,
      [campaignId]
    );
    if (clientRow) {
      clientSpace = {
        id: clientRow.id,
        name: clientRow.name,
        slug: clientRow.slug,
        status: clientRow.status,
      };
    }
  } catch {
    // Client portfolio tables are opt-in (P10); gracefully omit when disabled.
  }

  const normalizedLinks = (links || []).map((row) => ({
    id: Number(row.id),
    short: row.short,
    original: row.original,
    clicks: Number(row.clicks || 0),
    created_at: row.created_at || null,
  }));
  const normalizedQrs = (qrCodes || []).map((row) => ({
    id: Number(row.id),
    url_id: Number(row.url_id),
    short: row.short,
    slug: row.slug,
    label: row.label || '',
    scans: Number(row.scans || 0),
    created_at: row.created_at || null,
  }));

  return {
    campaign: mapCampaignRow(campaign),
    client: clientSpace,
    links: normalizedLinks,
    qr_codes: normalizedQrs,
    summary: {
      links_count: normalizedLinks.length,
      qr_codes_count: normalizedQrs.length,
      total_link_clicks: normalizedLinks.reduce((acc, item) => acc + item.clicks, 0),
      total_qr_scans: normalizedQrs.reduce((acc, item) => acc + item.scans, 0),
    },
  };
}

/** Compares raw clicks vs link_stats_daily rollup for one campaign (P19 reconciliation). */
async function reconcileCampaignMetrics({ campaign } = {}) {
  if (!campaign || !campaign.id) throw new Error('reconcileCampaignMetrics requires a campaign row');
  const campaignId = Number(campaign.id);
  const [rawRow, rollupRow] = await Promise.all([
    dbGetAsync(
      'SELECT COUNT(c.id) AS clicks, COALESCE(SUM(CASE WHEN COALESCE(c.is_bot, 0) = 1 THEN 1 ELSE 0 END), 0) AS bots ' +
        'FROM clicks c JOIN urls u ON u.id = c.url_id WHERE u.campaign_id = ?',
      [campaignId]
    ),
    dbGetAsync(
      'SELECT COALESCE(SUM(d.clicks), 0) AS clicks, COALESCE(SUM(d.bots), 0) AS bots ' +
        'FROM link_stats_daily d JOIN urls u ON u.id = d.url_id WHERE u.campaign_id = ?',
      [campaignId]
    ),
  ]);
  return {
    campaign_id: campaignId,
    ...reconcileRawVsRollup({ raw: rawRow || {}, rollup: rollupRow || {} }),
  };
}

/** Verifies that a campaign belongs to the caller before assigning links to it. */
async function assertCampaignOwnership({ userId, campaignId }) {
  const id = Number.parseInt(campaignId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  return getCampaignForUser({ userId, campaignId: id });
}

module.exports = {
  CAMPAIGN_NAME_MAX,
  CAMPAIGN_SLUG_MAX,
  CAMPAIGN_LIST_LIMIT,
  TOP_LINKS_LIMIT,
  MAX_GOAL_TARGET,
  CAMPAIGN_STATUSES,
  normalizeGoalTarget,
  computeGoalProgress,
  normalizeCampaignName,
  slugifyCampaignName,
  mapCampaignRow,
  createCampaign,
  getCampaignForUser,
  getCampaignForActor,
  listCampaigns,
  loadCampaignStats,
  loadCampaignAssets,
  reconcileCampaignMetrics,
  assertCampaignOwnership,
  evaluateStatusTransition,
  resolveEffectiveStatus,
  validateUtcInterval,
  normalizeBudget,
  toInt,
};
