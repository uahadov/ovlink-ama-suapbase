'use strict';

/**
 * P35 — Unified Plan & Usage Entitlement Engine (plan-entitlements-v1).
 *
 * Single source of truth for Free, Starter, Business, Agency, and Enterprise
 * limits shared across API, UI, and MCP entrypoints:
 *   - Per-organization quotas: client_workspaces, seats, domains, campaigns,
 *     monthly_jobs, monthly_reports, monthly_api_calls
 *   - Soft warning (80%) vs Hard limit (100%) separation
 *   - Concrete upgrade reason & recommended next tier
 *   - Existing links & historical data are NEVER broken or deleted when a limit
 *     is reached or a trial/subscription expires.
 */

const { dbGetAsync } = require('../db/helpers');
const orgBilling = require('./org-billing');

const ENTITLEMENTS_CONTRACT_VERSION = 'plan-entitlements-v1';
const SOFT_WARNING_RATIO = 0.8;

const EXISTING_LINKS_POLICY = Object.freeze({
  existing_links_redirect_normally: true,
  historical_data_deleted_on_downgrade: false,
  summary: 'Existing short links continue redirecting normally and historical analytics are preserved. Only creating new resources above the active tier quota is restricted.',
});

const TIER_ORDER = ['free', 'starter', 'business', 'agency', 'enterprise'];

const PLAN_ENTITLEMENT_MATRIX = Object.freeze({
  free: Object.freeze({
    client_workspaces: 0,
    seats: 1,
    domains: 1,
    campaigns: 3,
    monthly_jobs: 25,
    monthly_reports: 5,
    monthly_api_calls: 0,
  }),
  starter: Object.freeze({
    client_workspaces: 2,
    seats: 3,
    domains: 3,
    campaigns: 15,
    monthly_jobs: 250,
    monthly_reports: 30,
    monthly_api_calls: 25000,
  }),
  business: Object.freeze({
    client_workspaces: 10,
    seats: 10,
    domains: 10,
    campaigns: 100,
    monthly_jobs: 2500,
    monthly_reports: 250,
    monthly_api_calls: 100000,
  }),
  agency: Object.freeze({
    client_workspaces: 30,
    seats: 100,
    domains: 30,
    campaigns: 500,
    monthly_jobs: 10000,
    monthly_reports: 500,
    monthly_api_calls: 500000,
  }),
  enterprise: Object.freeze({
    client_workspaces: 250,
    seats: 1000,
    domains: 100,
    campaigns: 5000,
    monthly_jobs: 100000,
    monthly_reports: 2500,
    monthly_api_calls: 5000000,
  }),
});

function normalizePlanCode(raw) {
  const s = String(raw || 'free').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PLAN_ENTITLEMENT_MATRIX, s) ? s : 'free';
}

function resolveEffectivePlanCode({ planCode = 'free', status = 'active', trialEndsAt = null, now = new Date() } = {}) {
  const normalized = normalizePlanCode(planCode);
  const safeStatus = String(status || 'active').trim().toLowerCase();
  if (safeStatus === 'cancelled' || safeStatus === 'refunded') return 'free';
  if (safeStatus === 'trialing' && trialEndsAt) {
    const exp = new Date(trialEndsAt);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() <= now.getTime()) {
      return 'free';
    }
  }
  return normalized;
}

function nextRecommendedTier(planCode) {
  const idx = TIER_ORDER.indexOf(normalizePlanCode(planCode));
  if (idx < 0 || idx >= TIER_ORDER.length - 1) return 'enterprise';
  return TIER_ORDER[idx + 1];
}

/**
 * Pure, deterministic entitlement check shared identically across API, UI, and MCP.
 */
function evaluateEntitlementCheck({
  planCode = 'free',
  status = 'active',
  trialEndsAt = null,
  metric,
  currentUsage = 0,
  increment = 1,
  entrypoint = 'api',
  now = new Date(),
} = {}) {
  const effectivePlan = resolveEffectivePlanCode({ planCode, status, trialEndsAt, now });
  const limits = PLAN_ENTITLEMENT_MATRIX[effectivePlan];
  const meterKey = String(metric || '').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(limits, meterKey)) {
    return { error: 'unknown_entitlement_metric', statusCode: 400 };
  }

  const limit = Number(limits[meterKey]);
  const used = Math.max(0, Number(currentUsage) || 0);
  const delta = Math.max(0, Number(increment) || 0);
  const projected = used + delta;
  const usagePercent = limit > 0 ? Math.round((used / limit) * 1000) / 10 : (used > 0 ? 100 : 0);
  const recommended = nextRecommendedTier(effectivePlan);

  if (projected > limit) {
    return {
      contract_version: ENTITLEMENTS_CONTRACT_VERSION,
      entrypoint,
      effective_plan: effectivePlan,
      metric: meterKey,
      used,
      limit,
      projected,
      usage_percent: usagePercent,
      allowed: false,
      level: 'hard_limit',
      upgrade_required: true,
      recommended_tier: recommended,
      upgrade_reason: `${effectivePlan} paketində '${meterKey}' limiti (${limit}) dolub. Davam etmək üçün '${recommended}' paketinə yüksəldin.`,
      existing_links_policy: EXISTING_LINKS_POLICY,
    };
  }

  const isSoftWarn = limit > 0 && projected / limit >= SOFT_WARNING_RATIO;
  return {
    contract_version: ENTITLEMENTS_CONTRACT_VERSION,
    entrypoint,
    effective_plan: effectivePlan,
    metric: meterKey,
    used,
    limit,
    projected,
    usage_percent: usagePercent,
    allowed: true,
    level: isSoftWarn ? 'soft_warning' : 'ok',
    upgrade_required: false,
    recommended_tier: isSoftWarn ? recommended : null,
    upgrade_reason: isSoftWarn
      ? `'${meterKey}' istifadəsi ${effectivePlan} paket limitinin 80%-ni keçib (${projected}/${limit}).`
      : null,
    existing_links_policy: EXISTING_LINKS_POLICY,
  };
}

/** Loads real workspace usage counts and produces the unified entitlement read model. */
async function loadWorkspaceEntitlements({ workspaceId, ownerUserId, entrypoint = 'api', dbGet = dbGetAsync } = {}) {
  const wsId = Number(workspaceId);
  const billingAcct = await orgBilling.getOrgBillingAccount({ workspaceId: wsId, billingOwnerUserId: ownerUserId });
  const rawPlan = billingAcct ? billingAcct.plan_code : 'free';
  const rawStatus = billingAcct ? billingAcct.status : 'active';
  const effectivePlan = resolveEffectivePlanCode({
    planCode: rawPlan,
    status: rawStatus,
    trialEndsAt: billingAcct ? billingAcct.current_period_end : null,
  });

  const [seatRow, campaignRow, domainRow, reportRow, jobRow] = await Promise.all([
    dbGet('SELECT COUNT(*) AS cnt FROM workspace_members WHERE workspace_id = ?', [wsId]).catch(() => ({ cnt: 1 })),
    dbGet('SELECT COUNT(*) AS cnt FROM campaigns WHERE workspace_id = ?', [wsId]).catch(() => ({ cnt: 0 })),
    dbGet('SELECT COUNT(*) AS cnt FROM custom_domains WHERE user_id = ?', [Number(ownerUserId)]).catch(() => ({ cnt: 0 })),
    dbGet('SELECT COUNT(*) AS cnt FROM report_snapshots WHERE workspace_id = ?', [wsId]).catch(() => ({ cnt: 0 })),
    dbGet('SELECT COUNT(*) AS cnt FROM background_jobs WHERE owner_user_id = ?', [Number(ownerUserId)]).catch(() => ({ cnt: 0 })),
  ]);

  const usage = {
    client_workspaces: 0,
    seats: Number(seatRow && seatRow.cnt || 1),
    domains: Number(domainRow && domainRow.cnt || 0),
    campaigns: Number(campaignRow && campaignRow.cnt || 0),
    monthly_jobs: Number(jobRow && jobRow.cnt || 0),
    monthly_reports: Number(reportRow && reportRow.cnt || 0),
    monthly_api_calls: 0,
  };

  const meters = {};
  const upgradeSuggestions = [];
  for (const key of Object.keys(PLAN_ENTITLEMENT_MATRIX[effectivePlan])) {
    const check = evaluateEntitlementCheck({
      planCode: rawPlan,
      status: rawStatus,
      trialEndsAt: billingAcct ? billingAcct.current_period_end : null,
      metric: key,
      currentUsage: usage[key],
      increment: 0,
      entrypoint,
    });
    meters[key] = {
      used: check.used,
      limit: check.limit,
      usage_percent: check.usage_percent,
      level: check.level,
    };
    if (check.upgrade_reason) {
      upgradeSuggestions.push({
        metric: key,
        level: check.level,
        recommended_tier: check.recommended_tier,
        reason: check.upgrade_reason,
      });
    }
  }

  return {
    contract_version: ENTITLEMENTS_CONTRACT_VERSION,
    entrypoint,
    workspace_id: wsId,
    plan_code: rawPlan,
    billing_status: rawStatus,
    effective_plan: effectivePlan,
    meters,
    upgrade_suggestions: upgradeSuggestions,
    existing_links_policy: EXISTING_LINKS_POLICY,
  };
}

module.exports = {
  ENTITLEMENTS_CONTRACT_VERSION,
  SOFT_WARNING_RATIO,
  EXISTING_LINKS_POLICY,
  TIER_ORDER,
  PLAN_ENTITLEMENT_MATRIX,
  normalizePlanCode,
  resolveEffectivePlanCode,
  nextRecommendedTier,
  evaluateEntitlementCheck,
  loadWorkspaceEntitlements,
};
