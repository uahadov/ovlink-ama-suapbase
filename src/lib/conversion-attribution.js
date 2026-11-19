'use strict';

/**
 * Conversion Attribution & Reconciliation Contract v1 (P22).
 *
 * Matches link-scoped server conversion events against prior non-bot clicks
 * using explicit first-touch / last-touch windows, surfaces unattributed and
 * consent/session-unmeasurable leads separately, separates multi-currency
 * revenue without fake FX conversion, and never fabricates ROI.
 */

const { dbAllAsync, dbGetAsync } = require('../db/helpers');
const { ensureConversionEventsTable } = require('./conversion-events');

const ATTRIBUTION_CONTRACT_VERSION = 'v1';
const DEFAULT_ATTRIBUTION_WINDOW_DAYS = 7;
const ALLOWED_ATTRIBUTION_WINDOWS = Object.freeze([1, 7, 14, 30]);
const ALLOWED_TOUCH_MODELS = Object.freeze(['last_touch', 'first_touch']);
const LEAD_GOALS = new Set(['lead', 'leads', 'signup']);
const PURCHASE_GOALS = new Set(['purchase', 'sale', 'order', 'checkout']);

const UNMATCHED_REASONS = Object.freeze({
  NO_PRIOR_CLICK: 'no_prior_click',
  OUTSIDE_WINDOW: 'outside_attribution_window',
  BOT_CLICK_ONLY: 'bot_click_only',
  CONSENT_OR_SESSION: 'consent_or_session_unmeasurable',
  TIME_SKEW_BEFORE_CLICK: 'before_click_time_skew',
});

function normalizeAttributionWindowDays(raw) {
  const n = Number.parseInt(raw, 10);
  if (ALLOWED_ATTRIBUTION_WINDOWS.includes(n)) return n;
  return DEFAULT_ATTRIBUTION_WINDOW_DAYS;
}

function normalizeTouchModel(raw) {
  const m = (raw || '').toString().trim().toLowerCase();
  return ALLOWED_TOUCH_MODELS.includes(m) ? m : 'last_touch';
}

function getAttributionContractSpec() {
  return {
    version: ATTRIBUTION_CONTRACT_VERSION,
    default_window_days: DEFAULT_ATTRIBUTION_WINDOW_DAYS,
    allowed_window_days: ALLOWED_ATTRIBUTION_WINDOWS,
    models: ALLOWED_TOUCH_MODELS,
    default_model: 'last_touch',
    unmatched_reasons: Object.values(UNMATCHED_REASONS),
    causality_disclaimer:
      'Click-to-conversion matching proves temporal correlation on the same link and hashed visitor within the attribution window; it never proves absolute advertising causality.',
    currency_policy:
      'Monetary totals are grouped strictly per ISO-4217 currency; unverified FX rates are never applied and currencies are never mixed.',
    roi_policy:
      'ROI is never inferred or fabricated from clicks or unverified spend; roi remains null unless verified ad-spend and same-currency revenue exist.',
  };
}

/**
 * Pure, explainable click-to-conversion attribution engine.
 * Deduplicates duplicate event_id inputs defensively before matching.
 */
function attributeConversionEvents({
  events = [],
  clicks = [],
  windowDays = DEFAULT_ATTRIBUTION_WINDOW_DAYS,
  model = 'last_touch',
} = {}) {
  const safeWindowDays = normalizeAttributionWindowDays(windowDays);
  const safeModel = normalizeTouchModel(model);
  const windowMs = safeWindowDays * 24 * 60 * 60 * 1000;

  // Defensive dedupe by event_id so duplicate inputs can never inflate totals.
  const seenEventIds = new Set();
  const uniqueEvents = [];
  for (const ev of events || []) {
    if (!ev) continue;
    const eid = (ev.event_id || '').toString().trim();
    if (eid) {
      if (seenEventIds.has(eid)) continue;
      seenEventIds.add(eid);
    }
    uniqueEvents.push(ev);
  }

  // Index clicks by (url_id, ip_hash) for O(1) lookup.
  const clicksByKey = new Map();
  for (const cl of clicks || []) {
    if (!cl || !cl.url_id || !cl.ip_hash) continue;
    const key = `${Number(cl.url_id)}::${String(cl.ip_hash)}`;
    if (!clicksByKey.has(key)) clicksByKey.set(key, []);
    clicksByKey.get(key).push(cl);
  }

  const results = [];
  const unmatchedBreakdown = {
    [UNMATCHED_REASONS.NO_PRIOR_CLICK]: 0,
    [UNMATCHED_REASONS.OUTSIDE_WINDOW]: 0,
    [UNMATCHED_REASONS.BOT_CLICK_ONLY]: 0,
    [UNMATCHED_REASONS.CONSENT_OR_SESSION]: 0,
    [UNMATCHED_REASONS.TIME_SKEW_BEFORE_CLICK]: 0,
  };
  const leads = { total: 0, attributed: 0, unattributed: 0, unmeasurable_consent_or_session: 0 };
  const purchases = { total: 0, attributed: 0, unattributed: 0 };
  const revenueByCurrency = {};
  const attributedBySource = {};

  let attributedCount = 0;
  let unattributedCount = 0;

  for (const ev of uniqueEvents) {
    const goal = (ev.goal || '').toString().trim().toLowerCase();
    const isLead = LEAD_GOALS.has(goal);
    const isPurchase = PURCHASE_GOALS.has(goal);
    const consentMode = (ev.consent_mode || ev.consent || 'analytics').toString().trim().toLowerCase();
    const actorHash = ev.actor_hash ? String(ev.actor_hash).trim() : '';
    const eventMs = new Date(ev.occurred_at || ev.created_at).getTime();

    if (isLead) leads.total += 1;
    if (isPurchase) purchases.total += 1;

    let status = 'unmatched';
    let unmatchedReason = null;
    let matchedClick = null;

    if (consentMode !== 'analytics' || !actorHash) {
      unmatchedReason = UNMATCHED_REASONS.CONSENT_OR_SESSION;
    } else {
      const candidates = clicksByKey.get(`${Number(ev.url_id)}::${actorHash}`) || [];
      if (!candidates.length) {
        unmatchedReason = UNMATCHED_REASONS.NO_PRIOR_CLICK;
      } else {
        const humanClicks = candidates.filter((c) => Number(c.is_bot || 0) === 0);
        if (!humanClicks.length) {
          unmatchedReason = UNMATCHED_REASONS.BOT_CLICK_ONLY;
        } else {
          const eligible = [];
          let sawBeforeClick = false;
          let sawOutsideWindow = false;
          for (const hc of humanClicks) {
            const clickMs = new Date(hc.click_time).getTime();
            if (!Number.isFinite(clickMs) || !Number.isFinite(eventMs)) continue;
            if (clickMs > eventMs) {
              sawBeforeClick = true;
              continue;
            }
            const lag = eventMs - clickMs;
            if (lag > windowMs) {
              sawOutsideWindow = true;
              continue;
            }
            eligible.push({ click: hc, clickMs, lag });
          }

          if (eligible.length) {
            eligible.sort((a, b) => {
              if (a.clickMs !== b.clickMs) return a.clickMs - b.clickMs;
              return Number(a.click.id || 0) - Number(b.click.id || 0);
            });
            const picked = safeModel === 'first_touch' ? eligible[0] : eligible[eligible.length - 1];
            status = 'attributed';
            matchedClick = picked;
          } else if (sawOutsideWindow) {
            unmatchedReason = UNMATCHED_REASONS.OUTSIDE_WINDOW;
          } else if (sawBeforeClick) {
            unmatchedReason = UNMATCHED_REASONS.TIME_SKEW_BEFORE_CLICK;
          } else {
            unmatchedReason = UNMATCHED_REASONS.NO_PRIOR_CLICK;
          }
        }
      }
    }

    if (status === 'attributed') {
      attributedCount += 1;
      if (isLead) leads.attributed += 1;
      if (isPurchase) purchases.attributed += 1;
      const srcName = (matchedClick.click.utm_source || matchedClick.click.referrer_host || 'direct').toString().trim() || 'direct';
      attributedBySource[srcName] = (attributedBySource[srcName] || 0) + 1;
    } else {
      unattributedCount += 1;
      unmatchedBreakdown[unmatchedReason] = (unmatchedBreakdown[unmatchedReason] || 0) + 1;
      if (isLead) {
        leads.unattributed += 1;
        if (unmatchedReason === UNMATCHED_REASONS.CONSENT_OR_SESSION) {
          leads.unmeasurable_consent_or_session += 1;
        }
      }
      if (isPurchase) purchases.unattributed += 1;
    }

    const val = ev.value_amount !== undefined && ev.value_amount !== null ? Number(ev.value_amount) : null;
    const cur = ev.value_currency ? String(ev.value_currency).trim().toUpperCase() : null;
    if (val !== null && Number.isFinite(val) && cur) {
      if (!revenueByCurrency[cur]) {
        revenueByCurrency[cur] = { total: 0, attributed: 0, unattributed: 0, events_count: 0 };
      }
      revenueByCurrency[cur].total = Math.round((revenueByCurrency[cur].total + val) * 100) / 100;
      revenueByCurrency[cur].events_count += 1;
      if (status === 'attributed') {
        revenueByCurrency[cur].attributed = Math.round((revenueByCurrency[cur].attributed + val) * 100) / 100;
      } else {
        revenueByCurrency[cur].unattributed = Math.round((revenueByCurrency[cur].unattributed + val) * 100) / 100;
      }
    }

    results.push({
      event_id: ev.event_id,
      url_id: Number(ev.url_id),
      goal,
      occurred_at: ev.occurred_at,
      status,
      unmatched_reason: unmatchedReason,
      touch_model: safeModel,
      window_days: safeWindowDays,
      matched_click_id: matchedClick ? Number(matchedClick.click.id) : null,
      matched_click_time: matchedClick ? matchedClick.click.click_time : null,
      lag_seconds: matchedClick ? Math.round(matchedClick.lag / 1000) : null,
      source: matchedClick ? (matchedClick.click.utm_source || matchedClick.click.referrer_host || 'direct') : null,
      value: val,
      currency: cur,
    });
  }

  return {
    contract_version: ATTRIBUTION_CONTRACT_VERSION,
    model: safeModel,
    window_days: safeWindowDays,
    summary: {
      total_events: uniqueEvents.length,
      attributed_events: attributedCount,
      unattributed_events: unattributedCount,
      attribution_rate_percent:
        uniqueEvents.length > 0 ? Math.round((attributedCount / uniqueEvents.length) * 1000) / 10 : 0,
      leads,
      purchases,
      unmatched_breakdown: unmatchedBreakdown,
      revenue_by_currency: revenueByCurrency,
      attributed_by_source: attributedBySource,
      roi: null,
      roi_status: 'not_computed_without_verified_spend_and_fx',
    },
    events: results,
    spec: getAttributionContractSpec(),
  };
}

/**
 * Loads campaign-scoped server conversion events + candidate clicks from PG
 * and returns a full attributed/unattributed reconciliation report.
 */
async function reconcileCampaignAttribution({
  campaignId,
  windowDays = DEFAULT_ATTRIBUTION_WINDOW_DAYS,
  model = 'last_touch',
} = {}) {
  const id = Number.parseInt(campaignId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('reconcileCampaignAttribution requires a valid campaignId');
  }
  await ensureConversionEventsTable();

  const [events, clicks, pixelRow] = await Promise.all([
    dbAllAsync(
      'SELECT e.id, e.event_id, e.url_id, e.campaign_id, e.goal, e.occurred_at, e.source, e.consent_mode, ' +
        'e.value_amount, e.value_currency, e.actor_hash, e.created_at ' +
        'FROM conversion_events e JOIN urls u ON u.id = e.url_id ' +
        'WHERE u.campaign_id = ? OR e.campaign_id = ? ' +
        'ORDER BY e.occurred_at DESC, e.id DESC LIMIT 2000',
      [id, id]
    ),
    dbAllAsync(
      'SELECT c.id, c.url_id, c.click_time, c.ip_hash, c.is_bot, c.referrer_host, c.utm_source, c.utm_campaign ' +
        'FROM clicks c JOIN urls u ON u.id = c.url_id ' +
        'WHERE u.campaign_id = ? AND c.ip_hash IS NOT NULL AND c.ip_hash <> \'\' ' +
        'ORDER BY c.click_time ASC LIMIT 20000',
      [id]
    ),
    dbGetAsync(
      'SELECT COUNT(v.id) AS count FROM link_conversions v JOIN urls u ON u.id = v.url_id WHERE u.campaign_id = ?',
      [id]
    ).catch(() => ({ count: 0 })),
  ]);

  const attribution = attributeConversionEvents({ events, clicks, windowDays, model });
  return {
    campaign_id: id,
    server_events_count: attribution.summary.total_events,
    legacy_pixel_conversions_count: Number((pixelRow && pixelRow.count) || 0),
    ...attribution,
  };
}

module.exports = {
  ATTRIBUTION_CONTRACT_VERSION,
  DEFAULT_ATTRIBUTION_WINDOW_DAYS,
  ALLOWED_ATTRIBUTION_WINDOWS,
  ALLOWED_TOUCH_MODELS,
  UNMATCHED_REASONS,
  normalizeAttributionWindowDays,
  normalizeTouchModel,
  getAttributionContractSpec,
  attributeConversionEvents,
  reconcileCampaignAttribution,
};
