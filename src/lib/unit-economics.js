'use strict';

/**
 * P37 — Unit Economics, Usage Rollup & Capacity Metering (unit-economics-v1).
 *
 * Prevents margin loss on low-priced tiers and provides transparent per-org
 * resource budgeting:
 *   - Itemized unit cost model (redirects/1M, PDF, email, AI tokens, DB storage, support)
 *   - Worst-case monthly cost ceiling & gross margin model per plan
 *   - Monthly usage rollup & organization cost allocation (org_usage_monthly)
 *   - Usage forecast & alert thresholds (80% warning, 95% critical, margin compression)
 *   - High-traffic stress quota calibration check
 *   - Guaranteed fail-open metering: metering errors NEVER interrupt legacy or active redirects
 *   - Strict honesty rule: LTV and CAC remain null until real cohort data exists
 */

const { dbGetAsync, dbRunAsync } = require('../db/helpers');
const orgBilling = require('./org-billing');
const { PLAN_ENTITLEMENT_MATRIX, EXISTING_LINKS_POLICY } = require('./plan-entitlements');

const UNIT_ECONOMICS_CONTRACT_VERSION = 'unit-economics-v1';

// Conservative infrastructure & operational unit costs (USD)
const UNIT_COSTS_USD = Object.freeze({
  per_million_redirects: 0.45,
  per_pdf_export: 0.0015,
  per_email_delivery: 0.0008,
  per_1k_ai_tokens: 0.0025,
  per_gb_db_storage_month: 0.18,
  per_support_ticket: 2.50,
  payment_processing_rate: 0.04,
  payment_processing_fixed_usd: 0.40,
});

const PLAN_MONTHLY_REVENUE_USD = Object.freeze({
  free: 0,
  legacy_pro: 4.99,
  starter: 19,
  business: 49,
  agency: 129,
  enterprise: 349,
});

// Worst-case monthly capacity ceilings per plan (calibrated for safe gross margins)
const PLAN_WORST_CASE_CAPS = Object.freeze({
  free: Object.freeze({
    redirects: 50000,
    pdf_exports: PLAN_ENTITLEMENT_MATRIX.free.monthly_reports,
    emails_sent: 10,
    ai_tokens_k: 5,
    db_storage_gb: 0.1,
    support_tickets: 0,
  }),
  legacy_pro: Object.freeze({
    redirects: 250000,
    pdf_exports: 20,
    emails_sent: 50,
    ai_tokens_k: 25,
    db_storage_gb: 0.25,
    support_tickets: 0.25,
  }),
  starter: Object.freeze({
    redirects: 500000,
    pdf_exports: PLAN_ENTITLEMENT_MATRIX.starter.monthly_reports,
    emails_sent: 250,
    ai_tokens_k: 100,
    db_storage_gb: 1,
    support_tickets: 1,
  }),
  business: Object.freeze({
    redirects: 2500000,
    pdf_exports: PLAN_ENTITLEMENT_MATRIX.business.monthly_reports,
    emails_sent: 1500,
    ai_tokens_k: 400,
    db_storage_gb: 5,
    support_tickets: 2,
  }),
  agency: Object.freeze({
    redirects: 10000000,
    pdf_exports: PLAN_ENTITLEMENT_MATRIX.agency.monthly_reports,
    emails_sent: 6000,
    ai_tokens_k: 1200,
    db_storage_gb: 20,
    support_tickets: 4,
  }),
  enterprise: Object.freeze({
    redirects: 40000000,
    pdf_exports: PLAN_ENTITLEMENT_MATRIX.enterprise.monthly_reports,
    emails_sent: 25000,
    ai_tokens_k: 4000,
    db_storage_gb: 80,
    support_tickets: 8,
  }),
});

const METER_COLUMNS = Object.freeze({
  redirects: 'redirects',
  pdf_exports: 'pdf_exports',
  emails_sent: 'emails_sent',
  ai_tokens_k: 'ai_tokens_k',
  db_storage_mb: 'db_storage_mb',
  support_tickets: 'support_tickets',
});

const HONESTY_DISCLOSURE = 'LTV and CAC are intentionally null until verified paid customer cohort history exists; all figures below represent variable unit costs and worst-case margin bounds only.';

let unitEconTablesReady = false;

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function normalizeBillingMonth(raw, now = new Date()) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

function normalizePlanForEconomics(raw) {
  const s = String(raw || 'free').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PLAN_WORST_CASE_CAPS, s) ? s : 'free';
}

/**
 * Compute itemized variable cost (USD) for a given usage profile.
 */
function calculateVariableCost(usage = {}) {
  const redirects = Math.max(0, Number(usage.redirects) || 0);
  const pdfExports = Math.max(0, Number(usage.pdf_exports) || 0);
  const emailsSent = Math.max(0, Number(usage.emails_sent) || 0);
  const aiTokensK = Math.max(0, Number(usage.ai_tokens_k) || 0);
  const dbStorageGb = usage.db_storage_gb !== undefined
    ? Math.max(0, Number(usage.db_storage_gb) || 0)
    : Math.max(0, (Number(usage.db_storage_mb) || 0) / 1024);
  const supportTickets = Math.max(0, Number(usage.support_tickets) || 0);

  const itemized = {
    redirects_usd: round4((redirects / 1_000_000) * UNIT_COSTS_USD.per_million_redirects),
    pdf_exports_usd: round4(pdfExports * UNIT_COSTS_USD.per_pdf_export),
    emails_usd: round4(emailsSent * UNIT_COSTS_USD.per_email_delivery),
    ai_tokens_usd: round4(aiTokensK * UNIT_COSTS_USD.per_1k_ai_tokens),
    db_storage_usd: round4(dbStorageGb * UNIT_COSTS_USD.per_gb_db_storage_month),
    support_usd: round4(supportTickets * UNIT_COSTS_USD.per_support_ticket),
  };

  const infraTotal = round4(
    itemized.redirects_usd +
    itemized.pdf_exports_usd +
    itemized.emails_usd +
    itemized.ai_tokens_usd +
    itemized.db_storage_usd +
    itemized.support_usd
  );

  return { itemized, infra_cost_usd: infraTotal };
}

/**
 * Compute gross margin & worst-case cost ceiling for a plan.
 */
function computePlanUnitEconomics(planCode, actualUsage = null) {
  const plan = normalizePlanForEconomics(planCode);
  const revenueUsd = PLAN_MONTHLY_REVENUE_USD[plan];
  const caps = PLAN_WORST_CASE_CAPS[plan];
  const paymentFeesUsd = revenueUsd > 0
    ? round4(revenueUsd * UNIT_COSTS_USD.payment_processing_rate + UNIT_COSTS_USD.payment_processing_fixed_usd)
    : 0;

  const worstCase = calculateVariableCost(caps);
  const worstCaseTotalUsd = round4(worstCase.infra_cost_usd + paymentFeesUsd);
  const worstCaseProfitUsd = round4(revenueUsd - worstCaseTotalUsd);
  const worstCaseMarginPct = revenueUsd > 0
    ? round2((worstCaseProfitUsd / revenueUsd) * 100)
    : null;

  const actual = actualUsage ? calculateVariableCost(actualUsage) : null;
  const actualTotalUsd = actual ? round4(actual.infra_cost_usd + paymentFeesUsd) : null;
  const actualMarginPct = actual && revenueUsd > 0
    ? round2(((revenueUsd - actualTotalUsd) / revenueUsd) * 100)
    : null;

  const isMarginSafe = plan === 'free'
    ? worstCaseTotalUsd <= 0.25
    : worstCaseMarginPct >= 65;

  return {
    contract_version: UNIT_ECONOMICS_CONTRACT_VERSION,
    plan_code: plan,
    monthly_revenue_usd: revenueUsd,
    payment_fees_usd: paymentFeesUsd,
    worst_case_caps: caps,
    worst_case_cost_usd: worstCaseTotalUsd,
    worst_case_itemized_usd: worstCase.itemized,
    worst_case_gross_profit_usd: worstCaseProfitUsd,
    worst_case_gross_margin_pct: worstCaseMarginPct,
    actual_cost_usd: actualTotalUsd,
    actual_itemized_usd: actual ? actual.itemized : null,
    actual_gross_margin_pct: actualMarginPct,
    is_margin_safe: isMarginSafe,
    ltv_usd: null,
    cac_usd: null,
    honesty_note: HONESTY_DISCLOSURE,
  };
}

function listAllPlanUnitEconomics() {
  const plans = {};
  for (const planCode of Object.keys(PLAN_WORST_CASE_CAPS)) {
    plans[planCode] = computePlanUnitEconomics(planCode);
  }
  return {
    contract_version: UNIT_ECONOMICS_CONTRACT_VERSION,
    unit_costs_usd: UNIT_COSTS_USD,
    plans,
    ltv_usd: null,
    cac_usd: null,
    honesty_note: HONESTY_DISCLOSURE,
    existing_links_policy: EXISTING_LINKS_POLICY,
  };
}

/**
 * Evaluate usage alerts and end-of-month linear forecast for an org.
 */
function evaluateUsageForecastAndAlerts({ planCode, usage = {}, now = new Date() } = {}) {
  const plan = normalizePlanForEconomics(planCode);
  const caps = PLAN_WORST_CASE_CAPS[plan];
  const dayOfMonth = Math.max(1, now.getUTCDate());
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const paceMultiplier = daysInMonth / dayOfMonth;

  const metrics = {
    redirects: { used: Math.max(0, Number(usage.redirects) || 0), cap: caps.redirects },
    pdf_exports: { used: Math.max(0, Number(usage.pdf_exports) || 0), cap: caps.pdf_exports },
    emails_sent: { used: Math.max(0, Number(usage.emails_sent) || 0), cap: caps.emails_sent },
    ai_tokens_k: { used: Math.max(0, Number(usage.ai_tokens_k) || 0), cap: caps.ai_tokens_k },
    db_storage_gb: {
      used: round4(usage.db_storage_gb !== undefined ? Number(usage.db_storage_gb) || 0 : (Number(usage.db_storage_mb) || 0) / 1024),
      cap: caps.db_storage_gb,
    },
  };

  const forecast = {};
  const alerts = [];

  for (const [key, entry] of Object.entries(metrics)) {
    const ratio = entry.cap > 0 ? entry.used / entry.cap : 0;
    const projected = key === 'db_storage_gb' ? entry.used : Math.round(entry.used * paceMultiplier);
    const projectedRatio = entry.cap > 0 ? projected / entry.cap : 0;
    forecast[key] = {
      used: entry.used,
      cap: entry.cap,
      usage_pct: round2(ratio * 100),
      projected_eom: projected,
      projected_eom_pct: round2(projectedRatio * 100),
    };

    if (ratio >= 0.95) {
      alerts.push({ metric: key, severity: 'critical_95pct', usage_pct: round2(ratio * 100) });
    } else if (ratio >= 0.8 || projectedRatio >= 1.0) {
      alerts.push({
        metric: key,
        severity: ratio >= 0.8 ? 'warning_80pct' : 'forecast_overage',
        usage_pct: round2(ratio * 100),
        projected_eom_pct: round2(projectedRatio * 100),
      });
    }
  }

  const econ = computePlanUnitEconomics(plan, usage);
  if (econ.actual_gross_margin_pct !== null && econ.actual_gross_margin_pct < 65) {
    alerts.push({
      metric: 'gross_margin',
      severity: 'margin_compression',
      actual_gross_margin_pct: econ.actual_gross_margin_pct,
      target_min_pct: 65,
    });
  }

  return {
    day_of_month: dayOfMonth,
    days_in_month: daysInMonth,
    forecast,
    alerts,
  };
}

/**
 * High-traffic stress test & quota calibration check.
 */
function runStressQuotaCheck({ planCode = 'business', redirects = 5_000_000, pdfExports = 500, emailsSent = 2500, aiTokensK = 800, dbStorageGb = 10, supportTickets = 3 } = {}) {
  const plan = normalizePlanForEconomics(planCode);
  const stressUsage = {
    redirects: Math.max(0, Number(redirects) || 0),
    pdf_exports: Math.max(0, Number(pdfExports) || 0),
    emails_sent: Math.max(0, Number(emailsSent) || 0),
    ai_tokens_k: Math.max(0, Number(aiTokensK) || 0),
    db_storage_gb: Math.max(0, Number(dbStorageGb) || 0),
    support_tickets: Math.max(0, Number(supportTickets) || 0),
  };

  const econ = computePlanUnitEconomics(plan, stressUsage);
  const caps = PLAN_WORST_CASE_CAPS[plan];
  const breaches = [];

  for (const [k, capVal] of Object.entries(caps)) {
    if (stressUsage[k] > capVal) {
      breaches.push({
        metric: k,
        stress_value: stressUsage[k],
        configured_cap: capVal,
        action: 'enforce_soft_throttle_or_upgrade_prompt',
      });
    }
  }

  const marginHealthyUnderStress = plan === 'free'
    ? econ.actual_cost_usd <= 0.25
    : econ.actual_gross_margin_pct >= 65;

  return {
    contract_version: UNIT_ECONOMICS_CONTRACT_VERSION,
    plan_code: plan,
    stress_usage: stressUsage,
    stress_cost_usd: econ.actual_cost_usd,
    stress_gross_margin_pct: econ.actual_gross_margin_pct,
    margin_healthy_under_stress: marginHealthyUnderStress,
    cap_breaches: breaches,
    redirect_continuity_guaranteed: true,
    recommendation: marginHealthyUnderStress
      ? 'Current plan quotas keep gross margin within safe bounds under this stress load.'
      : 'Stress load exceeds plan unit-economics margin floor; enforce quota throttle on new creations or prompt upgrade to next tier without interrupting existing redirects.',
  };
}

async function ensureUnitEconomicsTables(runFn = dbRunAsync) {
  if (unitEconTablesReady) return;
  await runFn(`CREATE TABLE IF NOT EXISTS org_usage_monthly (
    id SERIAL PRIMARY KEY,
    workspace_id INTEGER NOT NULL,
    billing_month TEXT NOT NULL,
    redirects BIGINT NOT NULL DEFAULT 0,
    pdf_exports INTEGER NOT NULL DEFAULT 0,
    emails_sent INTEGER NOT NULL DEFAULT 0,
    ai_tokens_k INTEGER NOT NULL DEFAULT 0,
    db_storage_mb REAL NOT NULL DEFAULT 0,
    support_tickets INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, billing_month)
  )`);
  unitEconTablesReady = true;
}

/**
 * Fail-open usage metering:
 * Guarantees that any metering DB error (including on legacy accounts without
 * workspace billing rows) NEVER throws or blocks short-link redirects.
 */
async function recordUsageEventFailOpen({
  workspaceId,
  metric,
  delta = 1,
  billingMonth = null,
  runFn = dbRunAsync,
  now = new Date(),
} = {}) {
  const wsId = Number.parseInt(workspaceId, 10);
  const col = METER_COLUMNS[String(metric || '').trim().toLowerCase()];
  const inc = Math.max(0, Number(delta) || 0);
  if (!Number.isInteger(wsId) || wsId <= 0 || !col || inc <= 0) {
    return { recorded: false, fail_open: true, redirect_impacted: false, reason: 'invalid_meter_input' };
  }

  try {
    await ensureUnitEconomicsTables(runFn);
    const month = normalizeBillingMonth(billingMonth, now);
    const nowIso = now.toISOString();
    await runFn(
      `INSERT INTO org_usage_monthly (workspace_id, billing_month, ${col}, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace_id, billing_month) DO UPDATE SET
         ${col} = org_usage_monthly.${col} + EXCLUDED.${col},
         updated_at = EXCLUDED.updated_at`,
      [wsId, month, inc, nowIso]
    );
    return {
      recorded: true,
      fail_open: true,
      redirect_impacted: false,
      workspace_id: wsId,
      billing_month: month,
      metric: col,
      delta: inc,
    };
  } catch (err) {
    return {
      recorded: false,
      fail_open: true,
      redirect_impacted: false,
      error: 'metering_failed_open',
      detail: err && err.message ? err.message : 'db_error',
    };
  }
}

async function getOrganizationCostAllocation({
  workspaceId,
  ownerUserId,
  billingMonth = null,
  now = new Date(),
} = {}) {
  await ensureUnitEconomicsTables();
  const wsId = Number.parseInt(workspaceId, 10);
  const month = normalizeBillingMonth(billingMonth, now);
  const billing = await orgBilling.getOrgBillingAccount({ workspaceId: wsId, billingOwnerUserId: ownerUserId });
  const row = await dbGetAsync(
    'SELECT * FROM org_usage_monthly WHERE workspace_id = ? AND billing_month = ?',
    [wsId, month]
  );

  const usage = {
    redirects: Number(row && row.redirects) || 0,
    pdf_exports: Number(row && row.pdf_exports) || 0,
    emails_sent: Number(row && row.emails_sent) || 0,
    ai_tokens_k: Number(row && row.ai_tokens_k) || 0,
    db_storage_mb: Number(row && row.db_storage_mb) || 0,
    support_tickets: Number(row && row.support_tickets) || 0,
  };

  const effectivePlan = billing.grandfathered_legacy_pro && billing.plan_code === 'free'
    ? 'legacy_pro'
    : billing.plan_code;
  const economics = computePlanUnitEconomics(effectivePlan, usage);
  const forecastAndAlerts = evaluateUsageForecastAndAlerts({ planCode: effectivePlan, usage, now });

  return {
    contract_version: UNIT_ECONOMICS_CONTRACT_VERSION,
    workspace_id: wsId,
    billing_month: month,
    plan_code: effectivePlan,
    billing_status: billing.status,
    usage,
    economics,
    forecast: forecastAndAlerts.forecast,
    alerts: forecastAndAlerts.alerts,
    existing_links_policy: EXISTING_LINKS_POLICY,
  };
}

module.exports = {
  UNIT_ECONOMICS_CONTRACT_VERSION,
  UNIT_COSTS_USD,
  PLAN_MONTHLY_REVENUE_USD,
  PLAN_WORST_CASE_CAPS,
  HONESTY_DISCLOSURE,
  calculateVariableCost,
  computePlanUnitEconomics,
  listAllPlanUnitEconomics,
  evaluateUsageForecastAndAlerts,
  runStressQuotaCheck,
  ensureUnitEconomicsTables,
  recordUsageEventFailOpen,
  getOrganizationCostAllocation,
};
