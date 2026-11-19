'use strict';

/**
 * Analytics Data Contract v1 (P19).
 *
 * Single canonical source of truth for metric definitions, denominators, UTC
 * bucketing, accuracy labels (exact / estimated / unknown), privacy-safe
 * identity disclaimers, and raw-vs-rollup reconciliation across API, UI, CSV,
 * and MCP.
 */

const CONTRACT_VERSION = 'v1';
const CANONICAL_TIMEZONE = 'UTC';

const ACCURACY_LEVELS = Object.freeze({
  EXACT: 'exact',
  ESTIMATED: 'estimated',
  UNKNOWN: 'unknown',
});

const METRIC_DEFINITIONS = Object.freeze({
  clicks: Object.freeze({
    key: 'clicks',
    label: 'Clicks',
    formula: 'COUNT(clicks.id) or SUM(link_stats_daily.clicks)',
    denominator: null,
    timezone: CANONICAL_TIMEZONE,
    accuracy: ACCURACY_LEVELS.EXACT,
    notes: 'Recorded redirect events on canonical /:short links. Consent-declined visits record 0 clicks.',
  }),
  uniques: Object.freeze({
    key: 'uniques',
    label: 'Unique visitors (estimated)',
    formula: 'COUNT(DISTINCT (url_id, UTC_DAY(click_time), ip_hash))',
    denominator: null,
    timezone: CANONICAL_TIMEZONE,
    accuracy: ACCURACY_LEVELS.ESTIMATED,
    identity_disclaimer: 'Hashed IP/day buckets are anonymous visit estimates, never verified real-world human identities.',
    notes: 'Raw IPs are never stored; shared NAT/mobile networks and cookie/IP rotation make uniques an estimate.',
  }),
  bots: Object.freeze({
    key: 'bots',
    label: 'Bot clicks (estimated)',
    formula: 'COUNT(clicks.id WHERE is_bot = 1)',
    denominator: 'clicks',
    timezone: CANONICAL_TIMEZONE,
    accuracy: ACCURACY_LEVELS.ESTIMATED,
    notes: 'Heuristic user-agent and automated-crawler classification; stealth bots cannot be guaranteed 0%.',
  }),
  conversions: Object.freeze({
    key: 'conversions',
    label: 'Conversions',
    formula: 'COUNT(link_conversions.id matched to prior non-bot click when bots=exclude)',
    denominator: 'clicks',
    timezone: CANONICAL_TIMEZONE,
    accuracy: ACCURACY_LEVELS.EXACT,
    notes: 'Explicitly tracked post-click conversion events. Returns unknown when no conversion endpoint is wired.',
  }),
  conversion_rate: Object.freeze({
    key: 'conversion_rate',
    label: 'Conversion rate (%)',
    formula: 'clicks > 0 ? ROUND((conversions / clicks) * 100, 1) : 0',
    denominator: 'clicks',
    timezone: CANONICAL_TIMEZONE,
    accuracy: ACCURACY_LEVELS.EXACT,
    notes: 'Computed against the selected click denominator (all clicks or human-only clicks).',
  }),
  qr_scans: Object.freeze({
    key: 'qr_scans',
    label: 'QR scans',
    formula: 'SUM(qr_codes.scans) / SUM(qr_scan_daily.scans) via /q/:slug',
    denominator: null,
    timezone: CANONICAL_TIMEZONE,
    accuracy: ACCURACY_LEVELS.EXACT,
    notes: 'Counted separately from canonical link clicks; does not represent confirmed offline sales.',
  }),
  lead: Object.freeze({
    key: 'lead',
    label: 'Leads',
    formula: "COUNT(link_conversions.id WHERE LOWER(goal) IN ('lead','leads','signup'))",
    denominator: 'clicks',
    timezone: CANONICAL_TIMEZONE,
    accuracy: ACCURACY_LEVELS.UNKNOWN,
    notes: 'Marked unknown unless lead conversion events are actively recorded by the client.',
  }),
  revenue: Object.freeze({
    key: 'revenue',
    label: 'Revenue',
    formula: 'SUM(verified_revenue_events.amount)',
    denominator: null,
    timezone: CANONICAL_TIMEZONE,
    accuracy: ACCURACY_LEVELS.UNKNOWN,
    notes: 'Never estimated or inferred from clicks; remains unknown unless verified monetary events exist.',
  }),
});

const EVENT_HANDLING_RULES = Object.freeze({
  anonymous: 'No raw IP or PII stored; daily-salted ip_hash used strictly for anonymous unique estimation.',
  consent_granted: 'Redirect executes and records click event in clicks + link_stats_daily.',
  consent_declined: 'Redirect executes normally and records 0 analytics events.',
  delayed_events: 'Timestamped in UTC; late conversions match prior non-bot clicks with click_time <= conversion.created_at.',
  duplicate_events: 'Repeated clicks increment total clicks each time; unique count increments once per (url_id, UTC day, ip_hash).',
});

function reconcileRawVsRollup({ raw = {}, rollup = {} } = {}) {
  const rawClicks = Number(raw.clicks || 0);
  const rollupClicks = Number(rollup.clicks || 0);
  const rawBots = Number(raw.bots || 0);
  const rollupBots = Number(rollup.bots || 0);
  const clicksDelta = rawClicks - rollupClicks;
  const botsDelta = rawBots - rollupBots;
  const reconciled = clicksDelta === 0 && botsDelta === 0;

  return {
    contract_version: CONTRACT_VERSION,
    reconciled,
    status: reconciled ? 'exact_match' : 'drift_detected',
    authoritative_source: reconciled ? 'raw_and_rollup_aligned' : 'raw_events_clicks_table',
    raw: { clicks: rawClicks, bots: rawBots },
    rollup: { clicks: rollupClicks, bots: rollupBots },
    delta: { clicks: clicksDelta, bots: botsDelta },
    rule: 'When raw clicks and link_stats_daily differ, raw clicks is authoritative and daily rollup must be backfilled.',
  };
}

function buildMetricsContractMeta({ includeBots = true, conversionsCount = 0, revenueAvailable = false } = {}) {
  return {
    version: CONTRACT_VERSION,
    timezone: CANONICAL_TIMEZONE,
    bot_mode: includeBots ? 'include' : 'exclude',
    hashes_are_real_identities: false,
    accuracy: {
      clicks: ACCURACY_LEVELS.EXACT,
      uniques: ACCURACY_LEVELS.ESTIMATED,
      bots: ACCURACY_LEVELS.ESTIMATED,
      conversions: Number(conversionsCount) > 0 ? ACCURACY_LEVELS.EXACT : ACCURACY_LEVELS.UNKNOWN,
      lead: Number(conversionsCount) > 0 ? ACCURACY_LEVELS.EXACT : ACCURACY_LEVELS.UNKNOWN,
      revenue: revenueAvailable ? ACCURACY_LEVELS.EXACT : ACCURACY_LEVELS.UNKNOWN,
    },
  };
}

function getFullAnalyticsContract() {
  return {
    version: CONTRACT_VERSION,
    timezone: CANONICAL_TIMEZONE,
    hashes_are_real_identities: false,
    accuracy_levels: Object.values(ACCURACY_LEVELS),
    metrics: METRIC_DEFINITIONS,
    event_handling: EVENT_HANDLING_RULES,
    reconciliation_policy: {
      raw_table: 'clicks',
      rollup_table: 'link_stats_daily',
      authoritative_on_drift: 'clicks',
      human_only_source: 'clicks (raw non-bot events)',
    },
  };
}

module.exports = {
  CONTRACT_VERSION,
  CANONICAL_TIMEZONE,
  ACCURACY_LEVELS,
  METRIC_DEFINITIONS,
  EVENT_HANDLING_RULES,
  reconcileRawVsRollup,
  buildMetricsContractMeta,
  getFullAnalyticsContract,
};
