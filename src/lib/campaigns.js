'use strict';

/**
 * Campaigns: a named group of short links (client / channel / launch) with
 * aggregated statistics. Links are never destroyed when a campaign is removed.
 */

const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../db/helpers');
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
  return {
    id: Number(row.id),
    name: row.name || '',
    slug: row.slug || '',
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
async function createCampaign({ userId, name, goal, goalClicks, goalConversions }) {
  const ownerId = Number.parseInt(userId, 10);
  if (!Number.isInteger(ownerId) || ownerId <= 0) return { error: 'unauthorized' };

  const cleanName = normalizeCampaignName(name);
  if (cleanName.length < 2) return { error: 'invalid_name' };

  const slug = slugifyCampaignName(cleanName);
  if (!slug) return { error: 'invalid_name' };

  const existing = await dbGetAsync(
    'SELECT id FROM campaigns WHERE user_id = ? AND slug = ? LIMIT 1',
    [ownerId, slug]
  ).catch(() => null);
  if (existing) return { error: 'duplicate' };

  const targetClicks = normalizeGoalTarget(goalClicks);
  const targetConversions = normalizeGoalTarget(goalConversions);

  const inserted = await dbRunAsync(
    'INSERT INTO campaigns (user_id, name, slug, goal, goal_clicks, goal_conversions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [ownerId, cleanName, slug, normalizeCampaignName(goal) || null, targetClicks, targetConversions, new Date().toISOString()]
  ).catch(() => null);

  if (!inserted) return { error: 'db_error' };
  return {
    campaign: {
      id: Number(inserted.lastID),
      name: cleanName,
      slug,
      goal: normalizeCampaignName(goal) || '',
      goal_clicks: targetClicks,
      goal_conversions: targetConversions,
    },
  };
}

async function getCampaignForUser({ userId, campaignId }) {
  const ownerId = Number.parseInt(userId, 10);
  const id = Number.parseInt(campaignId, 10);
  if (!Number.isInteger(ownerId) || ownerId <= 0 || !Number.isInteger(id) || id <= 0) return null;
  return dbGetAsync('SELECT * FROM campaigns WHERE id = ? AND user_id = ? LIMIT 1', [id, ownerId]).catch(() => null);
}

async function listCampaigns({ userId, days, includeArchived = false } = {}) {
  const ownerId = Number.parseInt(userId, 10);
  if (!Number.isInteger(ownerId) || ownerId <= 0) return [];

  const range = parseRange(days);
  const dayClause = range.all ? '' : ' AND d.day >= ?';
  const params = [];
  if (!range.all) params.push(isoDay(addDays(new Date(), -range.days)));
  params.push(ownerId);

  const sql =
    'SELECT c.id, c.name, c.slug, c.goal, c.goal_clicks, c.goal_conversions, ' +
    'c.created_at, c.archived_at, ' +
    'COUNT(DISTINCT u.id) AS links_count, ' +
    'COALESCE(SUM(d.clicks), 0) AS clicks, ' +
    'COALESCE(SUM(d.uniques), 0) AS uniques, ' +
    'COALESCE(SUM(d.bots), 0) AS bots, ' +
    'COALESCE(SUM(d.conversions), 0) AS conversions ' +
    'FROM campaigns c ' +
    'LEFT JOIN urls u ON u.campaign_id = c.id ' +
    'LEFT JOIN link_stats_daily d ON d.url_id = u.id' + dayClause + ' ' +
    'WHERE c.user_id = ?' + (includeArchived ? '' : ' AND c.archived_at IS NULL') + ' ' +
    'GROUP BY c.id, c.name, c.slug, c.goal, c.goal_clicks, c.goal_conversions, c.created_at, c.archived_at ' +
    'ORDER BY clicks DESC, c.id DESC ' +
    `LIMIT ${CAMPAIGN_LIST_LIMIT}`;

  const rows = await dbAllAsync(sql, params).catch(() => []);
  return (rows || []).map(mapCampaignRow);
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
        'COALESCE(SUM(d.bots), 0) AS bots, COALESCE(SUM(d.conversions), 0) AS conversions ' +
        'FROM link_stats_daily d JOIN urls u ON u.id = d.url_id ' +
        'WHERE u.campaign_id = ?' + dayClause,
      [campaignId, ...dayParams]
    ).catch(() => null),
    dbAllAsync(
      'SELECT u.short, u.original, u.created_at, COALESCE(SUM(d.clicks), 0) AS clicks, ' +
        'COALESCE(SUM(d.uniques), 0) AS uniques, COALESCE(SUM(d.conversions), 0) AS conversions ' +
        'FROM urls u LEFT JOIN link_stats_daily d ON d.url_id = u.id' + dayClause + ' ' +
        'WHERE u.campaign_id = ? ' +
        'GROUP BY u.id, u.short, u.original, u.created_at ' +
        `ORDER BY clicks DESC, u.id DESC LIMIT ${TOP_LINKS_LIMIT}`,
      [...dayParams, campaignId]
    ).catch(() => []),
    dbAllAsync(
      'SELECT d.day AS name, COALESCE(SUM(d.clicks), 0) AS clicks, COALESCE(SUM(d.uniques), 0) AS uniques ' +
        'FROM link_stats_daily d JOIN urls u ON u.id = d.url_id ' +
        'WHERE u.campaign_id = ?' + dayClause + ' GROUP BY d.day',
      [campaignId, ...dayParams]
    ).catch(() => []),
    dbAllAsync(
      "SELECT COALESCE(NULLIF(c.referrer_host, ''), 'direct') AS name, COUNT(*) AS count " +
        'FROM clicks c JOIN urls u ON u.id = c.url_id ' +
        'WHERE u.campaign_id = ?' + clickClause + botClause + ' ' +
        'GROUP BY COALESCE(NULLIF(c.referrer_host, \'\'), \'direct\') ORDER BY count DESC LIMIT 12',
      [campaignId, ...clickParams]
    ).catch(() => []),
    dbAllAsync(
      'SELECT v.goal AS name, COUNT(*) AS count ' +
        'FROM link_conversions v JOIN urls u ON u.id = v.url_id ' +
        'WHERE u.campaign_id = ?' + conversionClause + ' GROUP BY v.goal ORDER BY count DESC LIMIT 12',
      [campaignId, ...conversionParams]
    ).catch(() => []),
    dbGetAsync('SELECT COUNT(*) AS count FROM urls WHERE campaign_id = ?', [campaignId]).catch(() => null),
  ]);

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

  return {
    campaign: {
      id: campaignId,
      name: campaign.name || '',
      slug: campaign.slug || '',
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
  normalizeGoalTarget,
  computeGoalProgress,
  normalizeCampaignName,
  slugifyCampaignName,
  mapCampaignRow,
  createCampaign,
  getCampaignForUser,
  listCampaigns,
  loadCampaignStats,
  assertCampaignOwnership,
  toInt,
};
