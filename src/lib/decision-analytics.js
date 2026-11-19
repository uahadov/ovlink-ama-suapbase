'use strict';

/**
 * Decision Analytics Engine v1 (P23).
 *
 * Answers "which ad / channel performs better?" with 5 core KPIs,
 * channel/UTM/goal comparison, period-over-period deltas, freshness/bot/source
 * badges, explicit unknown/unattributed visibility, and a 1:1 matching CSV export.
 */

const { dbAllAsync, dbGetAsync } = require('../db/helpers');
const { parseRange, parseBotsFilter, addDays, percentDelta } = require('./link-stats');
const {
  reconcileCampaignAttribution,
  normalizeAttributionWindowDays,
  normalizeTouchModel,
} = require('./conversion-attribution');
const { REDIRECT_CONSENT_MARKER } = require('./consent');

const FRESHNESS_STALE_MINUTES = 1440; // 24 hours

function escapeCsvCell(value) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (/^[\s\uFEFF\u200B]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function normalizeChannelName(utmSource, referrerHost, browser) {
  if (browser === REDIRECT_CONSENT_MARKER) return 'unknown_consent';
  const utm = (utmSource || '').toString().trim().toLowerCase();
  if (utm) return utm;
  const ref = (referrerHost || '').toString().trim().toLowerCase();
  if (ref) return ref;
  return 'direct';
}

function computeFreshness(lastClickAt, now) {
  if (!lastClickAt) {
    return { status: 'no_data', last_click_at: null, lag_minutes: null };
  }
  const lastMs = new Date(lastClickAt).getTime();
  if (!Number.isFinite(lastMs)) {
    return { status: 'unknown', last_click_at: lastClickAt, lag_minutes: null };
  }
  const lagMin = Math.max(0, Math.round((now.getTime() - lastMs) / 60000));
  return {
    status: lagMin <= FRESHNESS_STALE_MINUTES ? 'fresh' : 'stale',
    last_click_at: lastClickAt,
    lag_minutes: lagMin,
  };
}

/**
 * Pure decision analytics builder so unit tests and DB-backed endpoints share
 * the exact same ranking, delta, badge, and unknown/unattributed rules.
 */
function buildDecisionAnalyticsReport({
  campaign,
  rangeDays,
  includeBots = false,
  now = new Date(),
  currentClicksRows = [],
  previousClicksRows = [],
  attributionReport = null,
  lastClickAt = null,
} = {}) {
  const safeNow = now instanceof Date ? now : new Date(now);
  const attrSummary = (attributionReport && attributionReport.summary) || {
    total_events: 0,
    attributed_events: 0,
    unattributed_events: 0,
    leads: { total: 0, attributed: 0, unattributed: 0, unmeasurable_consent_or_session: 0 },
    purchases: { total: 0, attributed: 0, unattributed: 0 },
    revenue_by_currency: {},
    attributed_by_source: {},
    roi: null,
  };

  // Aggregate current & previous period by channel
  const channelMap = new Map();
  let totalCurrentClicks = 0;
  let totalCurrentUniques = 0;
  let unknownSourceClicks = 0;

  for (const row of currentClicksRows || []) {
    const ch = normalizeChannelName(row.utm_source, row.referrer_host, row.browser);
    const clicks = Number(row.clicks || 0);
    const uniques = Number(row.uniques || 0);
    totalCurrentClicks += clicks;
    totalCurrentUniques += uniques;
    if (ch === 'unknown_consent' || ch === 'direct') {
      unknownSourceClicks += clicks;
    }
    const existing = channelMap.get(ch) || {
      channel: ch,
      clicks: 0,
      uniques: 0,
      previous_clicks: 0,
      attributed_conversions: 0,
    };
    existing.clicks += clicks;
    existing.uniques += uniques;
    channelMap.set(ch, existing);
  }

  let totalPreviousClicks = 0;
  let totalPreviousUniques = 0;
  for (const row of previousClicksRows || []) {
    const ch = normalizeChannelName(row.utm_source, row.referrer_host, row.browser);
    const clicks = Number(row.clicks || 0);
    const uniques = Number(row.uniques || 0);
    totalPreviousClicks += clicks;
    totalPreviousUniques += uniques;
    const existing = channelMap.get(ch) || {
      channel: ch,
      clicks: 0,
      uniques: 0,
      previous_clicks: 0,
      attributed_conversions: 0,
    };
    existing.previous_clicks += clicks;
    channelMap.set(ch, existing);
  }

  // Merge attributed conversions per channel from P22 attribution summary
  const attrBySource = attrSummary.attributed_by_source || {};
  for (const [src, count] of Object.entries(attrBySource)) {
    const ch = (src || 'direct').toString().trim().toLowerCase() || 'direct';
    const existing = channelMap.get(ch) || {
      channel: ch,
      clicks: 0,
      uniques: 0,
      previous_clicks: 0,
      attributed_conversions: 0,
    };
    existing.attributed_conversions += Number(count || 0);
    channelMap.set(ch, existing);
  }

  const channelComparison = [...channelMap.values()]
    .map((item) => {
      const convRate = item.clicks > 0
        ? Math.round((item.attributed_conversions / item.clicks) * 1000) / 10
        : null;
      const sharePct = totalCurrentClicks > 0
        ? Math.round((item.clicks / totalCurrentClicks) * 1000) / 10
        : 0;
      return {
        channel: item.channel,
        clicks: item.clicks,
        uniques: item.uniques,
        share_of_clicks_percent: sharePct,
        previous_clicks: item.previous_clicks,
        delta_percent: percentDelta(item.clicks, item.previous_clicks),
        attributed_conversions: item.attributed_conversions,
        conversion_rate_percent: convRate,
        data_status: item.channel === 'unknown_consent' ? 'unmeasurable_consent' : 'measured',
      };
    })
    .sort((a, b) => {
      if (b.attributed_conversions !== a.attributed_conversions) {
        return b.attributed_conversions - a.attributed_conversions;
      }
      if (b.clicks !== a.clicks) return b.clicks - a.clicks;
      return a.channel.localeCompare(b.channel);
    });

  // Goal breakdown from P22 event-level results
  const goalMap = new Map();
  for (const ev of (attributionReport && attributionReport.events) || []) {
    const g = (ev.goal || 'default').toString().trim().toLowerCase();
    const cur = goalMap.get(g) || { goal: g, total: 0, attributed: 0, unattributed: 0 };
    cur.total += 1;
    if (ev.status === 'attributed') cur.attributed += 1;
    else cur.unattributed += 1;
    goalMap.set(g, cur);
  }
  const goalBreakdown = [...goalMap.values()].sort((a, b) => b.total - a.total);

  const totalConversions = Number(attrSummary.total_events || 0);
  const attributedConversions = Number(attrSummary.attributed_events || 0);
  const unattributedConversions = Number(attrSummary.unattributed_events || 0);
  const currentConvRate = totalCurrentClicks > 0
    ? Math.round((attributedConversions / totalCurrentClicks) * 1000) / 10
    : 0;

  // Pick transparent leaders (excluding unknown_consent from "winning ad" recommendation)
  const measurableChannels = channelComparison.filter((c) => c.channel !== 'unknown_consent');
  const topByClicks = [...measurableChannels].sort((a, b) => b.clicks - a.clicks)[0] || null;
  const topByConversions = [...measurableChannels]
    .filter((c) => c.attributed_conversions > 0)
    .sort((a, b) => {
      if (b.attributed_conversions !== a.attributed_conversions) {
        return b.attributed_conversions - a.attributed_conversions;
      }
      return (b.conversion_rate_percent || 0) - (a.conversion_rate_percent || 0);
    })[0] || null;

  const warnings = [];
  if (totalCurrentClicks < 30) warnings.push('low_click_sample_size');
  if (totalConversions === 0) warnings.push('no_conversion_events_recorded');
  if (totalConversions > 0 && unattributedConversions / totalConversions > 0.3) {
    warnings.push('high_unattributed_conversion_share');
  }

  return {
    contract_version: 'v1',
    campaign: {
      id: Number(campaign && campaign.id ? campaign.id : 0),
      name: (campaign && campaign.name) || '',
      slug: (campaign && campaign.slug) || '',
    },
    range: {
      days: rangeDays === 'all' ? 'all' : Number(rangeDays || 30),
      bots: includeBots ? 'include' : 'exclude',
      generated_at: safeNow.toISOString(),
    },
    badges: {
      bot_filter: includeBots ? 'bots_included' : 'human_only',
      metric_source: includeBots ? 'all_recorded_clicks' : 'raw_nonbot_events',
      freshness: computeFreshness(lastClickAt, safeNow),
      attribution_model: (attributionReport && attributionReport.model) || 'last_touch',
      attribution_window_days: (attributionReport && attributionReport.window_days) || 7,
      unknown_and_unattributed_visible: true,
    },
    // Core 5 KPIs — focused, decision-ready, never overwhelming.
    core_kpis: {
      clicks: {
        value: totalCurrentClicks,
        previous: totalPreviousClicks,
        delta_percent: percentDelta(totalCurrentClicks, totalPreviousClicks),
        accuracy: 'exact',
      },
      uniques: {
        value: totalCurrentUniques,
        previous: totalPreviousUniques,
        delta_percent: percentDelta(totalCurrentUniques, totalPreviousUniques),
        accuracy: 'estimated',
      },
      attributed_conversions: {
        value: attributedConversions,
        total_recorded_events: totalConversions,
        accuracy: totalConversions > 0 ? 'exact' : 'unknown',
      },
      conversion_rate_percent: {
        value: currentConvRate,
        denominator: 'clicks',
        accuracy: totalConversions > 0 ? 'exact' : 'unknown',
      },
      unknown_and_unattributed: {
        unknown_or_direct_clicks: unknownSourceClicks,
        unattributed_conversions: unattributedConversions,
        unmeasurable_consent_or_session_leads: Number(
          (attrSummary.leads && attrSummary.leads.unmeasurable_consent_or_session) || 0
        ),
        accuracy: 'exact',
      },
    },
    channel_comparison: channelComparison,
    goal_breakdown: goalBreakdown,
    revenue_by_currency: attrSummary.revenue_by_currency || {},
    decision_summary: {
      top_by_clicks: topByClicks
        ? { channel: topByClicks.channel, clicks: topByClicks.clicks, share_percent: topByClicks.share_of_clicks_percent }
        : null,
      top_by_attributed_conversions: topByConversions
        ? {
            channel: topByConversions.channel,
            attributed_conversions: topByConversions.attributed_conversions,
            conversion_rate_percent: topByConversions.conversion_rate_percent,
          }
        : null,
      warnings,
      roi: null,
      roi_note: 'ROI is never fabricated without verified ad spend and same-currency revenue.',
    },
  };
}

/**
 * 1:1 CSV export matching the exact JSON counters in buildDecisionAnalyticsReport.
 */
function buildDecisionCsv(report) {
  const lines = [];
  const add = (...cols) => lines.push(cols.map(escapeCsvCell).join(','));

  add('Ovlink Decision Analytics Report', report.contract_version || 'v1');
  add('Campaign', report.campaign && report.campaign.name);
  add('Bot filter', report.badges && report.badges.bot_filter);
  add('Freshness', report.badges && report.badges.freshness && report.badges.freshness.status);
  add('Attribution model', `${report.badges.attribution_model} (${report.badges.attribution_window_days}d)`);
  add('Generated at (UTC)', report.range && report.range.generated_at);
  lines.push('');

  add('Core KPI', 'Current', 'Previous', 'Delta (%)', 'Accuracy');
  add('Clicks', report.core_kpis.clicks.value, report.core_kpis.clicks.previous, report.core_kpis.clicks.delta_percent ?? '', report.core_kpis.clicks.accuracy);
  add('Unique visitors', report.core_kpis.uniques.value, report.core_kpis.uniques.previous, report.core_kpis.uniques.delta_percent ?? '', report.core_kpis.uniques.accuracy);
  add('Attributed conversions', report.core_kpis.attributed_conversions.value, '', '', report.core_kpis.attributed_conversions.accuracy);
  add('Conversion rate (%)', report.core_kpis.conversion_rate_percent.value, '', '', report.core_kpis.conversion_rate_percent.accuracy);
  add('Unattributed conversions', report.core_kpis.unknown_and_unattributed.unattributed_conversions, '', '', report.core_kpis.unknown_and_unattributed.accuracy);
  add('Unknown/direct clicks', report.core_kpis.unknown_and_unattributed.unknown_or_direct_clicks, '', '', 'exact');
  lines.push('');

  add('Channel', 'Clicks', 'Uniques', 'Share (%)', 'Previous clicks', 'Delta (%)', 'Attributed conversions', 'Conv rate (%)', 'Data status');
  for (const ch of report.channel_comparison || []) {
    add(
      ch.channel,
      ch.clicks,
      ch.uniques,
      ch.share_of_clicks_percent,
      ch.previous_clicks,
      ch.delta_percent ?? '',
      ch.attributed_conversions,
      ch.conversion_rate_percent ?? '',
      ch.data_status
    );
  }
  lines.push('');

  add('Goal', 'Total events', 'Attributed', 'Unattributed');
  for (const g of report.goal_breakdown || []) {
    add(g.goal, g.total, g.attributed, g.unattributed);
  }

  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/**
 * Loads DB data for one campaign and produces the P23 decision analytics report.
 */
async function loadCampaignDecisionAnalytics({ campaign, query = {}, now = new Date() } = {}) {
  if (!campaign || !campaign.id) throw new Error('loadCampaignDecisionAnalytics requires a campaign row');
  const campaignId = Number(campaign.id);
  const range = parseRange(query.days || query.range);
  const includeBots = parseBotsFilter(query.bots === undefined ? 'exclude' : query.bots);
  const windowDays = normalizeAttributionWindowDays(query.window_days || query.window);
  const model = normalizeTouchModel(query.model);

  const safeNow = now instanceof Date ? now : new Date(now);
  const daysNum = range.all ? null : range.days;
  const currentStartIso = daysNum ? addDays(safeNow, -daysNum).toISOString() : null;
  const prevStartIso = daysNum ? addDays(safeNow, -(daysNum * 2)).toISOString() : null;
  const botClause = includeBots ? '' : ' AND COALESCE(c.is_bot, 0) = 0';
  const uniqueExpr =
    "COUNT(DISTINCT (c.url_id, LEFT(c.click_time, 10), c.ip_hash)) FILTER (WHERE c.ip_hash IS NOT NULL AND c.ip_hash <> '')";

  const [currentRows, previousRows, lastClickRow, attributionReport] = await Promise.all([
    dbAllAsync(
      'SELECT c.utm_source, c.referrer_host, ' +
        'CASE WHEN c.browser = ? THEN ? ELSE NULL END AS browser, ' +
        `COUNT(c.id) AS clicks, ${uniqueExpr} AS uniques ` +
        'FROM clicks c JOIN urls u ON u.id = c.url_id ' +
        `WHERE u.campaign_id = ?${currentStartIso ? ' AND c.click_time >= ?' : ''}${botClause} ` +
        'GROUP BY 1, 2, 3',
      currentStartIso
        ? [REDIRECT_CONSENT_MARKER, REDIRECT_CONSENT_MARKER, campaignId, currentStartIso]
        : [REDIRECT_CONSENT_MARKER, REDIRECT_CONSENT_MARKER, campaignId]
    ),
    daysNum
      ? dbAllAsync(
          'SELECT c.utm_source, c.referrer_host, ' +
            'CASE WHEN c.browser = ? THEN ? ELSE NULL END AS browser, ' +
            `COUNT(c.id) AS clicks, ${uniqueExpr} AS uniques ` +
            'FROM clicks c JOIN urls u ON u.id = c.url_id ' +
            `WHERE u.campaign_id = ? AND c.click_time >= ? AND c.click_time < ?${botClause} ` +
            'GROUP BY 1, 2, 3',
          [
            REDIRECT_CONSENT_MARKER,
            REDIRECT_CONSENT_MARKER,
            campaignId,
            prevStartIso,
            currentStartIso,
          ]
        )
      : Promise.resolve([]),
    dbGetAsync(
      `SELECT MAX(c.click_time) AS last_click_at FROM clicks c JOIN urls u ON u.id = c.url_id WHERE u.campaign_id = ?${botClause}`,
      [campaignId]
    ).catch(() => null),
    reconcileCampaignAttribution({ campaignId, windowDays, model }).catch(() => null),
  ]);

  return buildDecisionAnalyticsReport({
    campaign,
    rangeDays: range.all ? 'all' : range.days,
    includeBots,
    now: safeNow,
    currentClicksRows: currentRows,
    previousClicksRows: previousRows,
    attributionReport,
    lastClickAt: lastClickRow && lastClickRow.last_click_at ? lastClickRow.last_click_at : null,
  });
}

module.exports = {
  FRESHNESS_STALE_MINUTES,
  normalizeChannelName,
  computeFreshness,
  buildDecisionAnalyticsReport,
  buildDecisionCsv,
  loadCampaignDecisionAnalytics,
};
