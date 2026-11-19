'use strict';

/**
 * P36 — Self-Serve Checkout, Trial Auto-Renew Terms, Dunning, Grace Period & Billing Portal (checkout-dunning-v1).
 *
 * Implements the full self-service billing lifecycle:
 *   - Checkout session creation with explicit trial auto-renew disclosures
 *   - Sandbox end-to-end checkout -> webhook activation
 *   - Dunning & 7-day Grace Period state machine on payment failures
 *   - Always-accessible self-serve cancellation & billing portal summary
 *   - Invoice/receipt generation with USD settlement + indicative AZN display & tax/MoR note
 *   - Guaranteed uninterrupted existing-link redirects when subscription expires
 */

const crypto = require('crypto');
const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../db/helpers');
const orgBilling = require('./org-billing');
const { EXISTING_LINKS_POLICY } = require('./plan-entitlements');

const CHECKOUT_DUNNING_CONTRACT_VERSION = 'checkout-dunning-v1';
const GRACE_PERIOD_DAYS = 7;
const MAX_DUNNING_ATTEMPTS = 3;
const INDICATIVE_USD_TO_AZN = 1.7;
const ALLOWED_TRIAL_DAYS = new Set([0, 7, 14]);
const PLAN_MONTHLY_USD = Object.freeze({
  starter: 7,
  business: 19,
  agency: 49,
  enterprise: 129,
});

const SELLER_ONBOARDING_NOTE = 'Polar acts as Merchant of Record for global sales tax/VAT; Azerbaijan seller payout eligibility must still be verified directly in the live Polar seller dashboard before enabling production charges.';

let checkoutTablesReady = false;

function buildTrialTerms(trialDays = 0, planCode = 'business') {
  const days = ALLOWED_TRIAL_DAYS.has(Number(trialDays)) ? Number(trialDays) : 0;
  const usd = PLAN_MONTHLY_USD[planCode] || 19;
  const azn = Math.round(usd * INDICATIVE_USD_TO_AZN * 100) / 100;
  return {
    trial_days: days,
    auto_renews: days > 0,
    cancel_anytime_before_charge: true,
    settlement_currency: 'USD',
    monthly_price_usd: usd,
    indicative_price_azn: azn,
    tax_note: 'Applicable VAT/sales tax is calculated and collected by Polar as Merchant of Record at checkout.',
    disclosure_az: days > 0
      ? `${days} günlük sınaq bitdikdən sonra abunəlik avtomatik yenilənir ($${usd}/ay, təxminən ${azn} AZN). Ödənişdən əvvəl istənilən vaxt portaldan ləğv edə bilərsiniz.`
      : `Aylıq abunəlik $${usd}/ay (təxminən ${azn} AZN). İstənilən vaxt portaldan ləğv edə bilərsiniz.`,
    disclosure_en: days > 0
      ? `After the ${days}-day trial, your subscription auto-renews at $${usd}/mo (~${azn} AZN). Cancel anytime in the billing portal before renewal.`
      : `Monthly subscription at $${usd}/mo (~${azn} AZN). Cancel anytime in the billing portal.`,
  };
}

function evaluateDunningTransition({ dunningAttempts = 0, gracePeriodEndsAt = null, now = new Date() } = {}) {
  const attempts = Number(dunningAttempts || 0) + 1;
  const nowMs = now.getTime();
  const graceEnd = gracePeriodEndsAt
    ? new Date(gracePeriodEndsAt)
    : new Date(nowMs + GRACE_PERIOD_DAYS * 86400 * 1000);
  const graceExpired = graceEnd.getTime() <= nowMs || attempts >= MAX_DUNNING_ATTEMPTS;

  return {
    dunning_attempts: attempts,
    grace_period_ends_at: graceEnd.toISOString(),
    grace_expired: graceExpired,
    next_status: graceExpired ? 'cancelled' : 'past_due',
    effective_plan_after: graceExpired ? 'free' : null,
    reminder_stage: attempts === 1 ? 'day_0_notice' : (attempts === 2 ? 'day_3_reminder' : 'final_warning_downgrade'),
    existing_links_policy: EXISTING_LINKS_POLICY,
  };
}

async function ensureCheckoutDunningTables(runFn = dbRunAsync) {
  if (checkoutTablesReady) return;
  await orgBilling.ensureOrgBillingTables(runFn);
  await runFn(`CREATE TABLE IF NOT EXISTS billing_checkout_sessions (
    id SERIAL PRIMARY KEY,
    checkout_id TEXT NOT NULL UNIQUE,
    workspace_id INTEGER NOT NULL,
    owner_user_id INTEGER NOT NULL,
    plan_code TEXT NOT NULL,
    trial_days INTEGER NOT NULL DEFAULT 0,
    currency_display TEXT NOT NULL DEFAULT 'AZN',
    status TEXT NOT NULL DEFAULT 'pending',
    dunning_attempts INTEGER NOT NULL DEFAULT 0,
    grace_period_ends_at TEXT,
    receipt_number TEXT,
    amount_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await runFn('CREATE INDEX IF NOT EXISTS idx_checkout_ws ON billing_checkout_sessions(workspace_id, id DESC)').catch(() => {});
  checkoutTablesReady = true;
}

async function createCheckoutSession({
  workspaceId,
  ownerUserId,
  planCode = 'business',
  trialDays = 0,
  currencyDisplay = 'AZN',
  dbRun = dbRunAsync,
} = {}) {
  await ensureCheckoutDunningTables(dbRun);
  const safePlan = Object.prototype.hasOwnProperty.call(PLAN_MONTHLY_USD, String(planCode).toLowerCase())
    ? String(planCode).toLowerCase()
    : null;
  if (!safePlan) return { error: 'invalid_checkout_plan', statusCode: 400, message: 'Keçərli biznes paketi seçin (starter, business, agency, enterprise).' };

  const safeTrial = ALLOWED_TRIAL_DAYS.has(Number(trialDays)) ? Number(trialDays) : 0;
  const safeCurrency = ['AZN', 'USD'].includes(String(currencyDisplay).toUpperCase()) ? String(currencyDisplay).toUpperCase() : 'AZN';
  const checkoutId = 'chk_' + crypto.randomBytes(8).toString('hex');
  const nowIso = new Date().toISOString();
  const terms = buildTrialTerms(safeTrial, safePlan);

  await dbRun(
    `INSERT INTO billing_checkout_sessions
       (checkout_id, workspace_id, owner_user_id, plan_code, trial_days, currency_display, status, amount_usd, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [checkoutId, Number(workspaceId), Number(ownerUserId), safePlan, safeTrial, safeCurrency, terms.monthly_price_usd, nowIso, nowIso]
  );

  return {
    contract_version: CHECKOUT_DUNNING_CONTRACT_VERSION,
    checkout_id: checkoutId,
    workspace_id: Number(workspaceId),
    plan_code: safePlan,
    status: 'pending',
    trial_terms: terms,
    cancel_url: `/api/billing-portal/${Number(workspaceId)}/cancel`,
    seller_onboarding_note: SELLER_ONBOARDING_NOTE,
  };
}

/** Completes a sandbox checkout via Polar webhook flow and issues a receipt number. */
async function completeSandboxCheckout({
  checkoutId,
  ownerUserId,
  providerEventId = null,
  dbGet = dbGetAsync,
  dbRun = dbRunAsync,
} = {}) {
  await ensureCheckoutDunningTables(dbRun);
  const sess = await dbGet(
    'SELECT * FROM billing_checkout_sessions WHERE checkout_id = ? AND owner_user_id = ? LIMIT 1',
    [String(checkoutId || '').trim(), Number(ownerUserId)]
  );
  if (!sess) return { error: 'checkout_not_found', statusCode: 404 };

  const productId = `prod_ovlink_${sess.plan_code}`;
  const evtId = providerEventId || `pevt_chk_${sess.checkout_id}`;
  const webhookRes = await orgBilling.applyOrgSubscriptionWebhookEvent({
    providerEventId: evtId,
    workspaceId: sess.workspace_id,
    billingOwnerUserId: ownerUserId,
    eventType: 'subscription.created',
    polarProductId: productId,
    polarCustomerId: `cus_ws_${sess.workspace_id}`,
    polarSubscriptionId: `sub_${sess.checkout_id}`,
    dbGet,
    dbRun,
  });
  if (webhookRes.error) return webhookRes;

  const receiptNumber = sess.receipt_number || `OVL-${new Date().getUTCFullYear()}-${String(sess.id).padStart(5, '0')}`;
  const nowIso = new Date().toISOString();
  await dbRun(
    "UPDATE billing_checkout_sessions SET status = 'completed', receipt_number = ?, updated_at = ? WHERE id = ?",
    [receiptNumber, nowIso, Number(sess.id)]
  );

  return {
    checkout_id: sess.checkout_id,
    status: 'completed',
    deduplicated: webhookRes.deduplicated,
    receipt: {
      receipt_number: receiptNumber,
      workspace_id: Number(sess.workspace_id),
      plan_code: sess.plan_code,
      amount_usd: Number(sess.amount_usd || 0),
      indicative_azn: Math.round(Number(sess.amount_usd || 0) * INDICATIVE_USD_TO_AZN * 100) / 100,
      tax_note: 'Polar Merchant of Record',
      issued_at: nowIso,
    },
    account: webhookRes.account,
  };
}

/** Records a payment failure, enters/advances Grace Period, and downgrades cleanly once expired. */
async function recordPaymentFailure({ workspaceId, ownerUserId, now = new Date(), dbGet = dbGetAsync, dbRun = dbRunAsync } = {}) {
  await ensureCheckoutDunningTables(dbRun);
  const sess = await dbGet(
    "SELECT * FROM billing_checkout_sessions WHERE workspace_id = ? AND owner_user_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1",
    [Number(workspaceId), Number(ownerUserId)]
  );
  if (!sess) return { error: 'active_checkout_not_found', statusCode: 404 };

  const transition = evaluateDunningTransition({
    dunningAttempts: sess.dunning_attempts,
    gracePeriodEndsAt: sess.grace_period_ends_at,
    now,
  });
  const nowIso = now.toISOString();

  await dbRun(
    'UPDATE billing_checkout_sessions SET dunning_attempts = ?, grace_period_ends_at = ?, updated_at = ? WHERE id = ?',
    [transition.dunning_attempts, transition.grace_period_ends_at, nowIso, Number(sess.id)]
  );

  await dbRun(
    'UPDATE org_billing_accounts SET status = ?, plan_code = COALESCE(?, plan_code), updated_at = ? WHERE workspace_id = ? AND billing_owner_user_id = ?',
    [transition.next_status, transition.effective_plan_after, nowIso, Number(workspaceId), Number(ownerUserId)]
  );

  return {
    workspace_id: Number(workspaceId),
    ...transition,
  };
}

/** Self-serve billing portal summary: plan status, easy cancel endpoint, receipts & redirect guarantee. */
async function getBillingPortalSummary({ workspaceId, ownerUserId, dbAll = dbAllAsync, dbGet = dbGetAsync, dbRun = dbRunAsync } = {}) {
  await ensureCheckoutDunningTables(dbRun);
  const account = await orgBilling.getOrgBillingAccount({ workspaceId, billingOwnerUserId: ownerUserId, dbGet, dbRun });
  const sessions = await dbAll(
    'SELECT checkout_id, plan_code, trial_days, status, dunning_attempts, grace_period_ends_at, receipt_number, amount_usd, created_at FROM billing_checkout_sessions WHERE workspace_id = ? AND owner_user_id = ? ORDER BY id DESC LIMIT 20',
    [Number(workspaceId), Number(ownerUserId)]
  );

  return {
    contract_version: CHECKOUT_DUNNING_CONTRACT_VERSION,
    workspace_id: Number(workspaceId),
    account,
    self_serve_actions: {
      can_cancel_anytime: true,
      cancel_endpoint: `/api/billing-portal/${Number(workspaceId)}/cancel`,
      checkout_endpoint: '/api/checkout/sessions',
    },
    receipts: (sessions || [])
      .filter((s) => s.receipt_number)
      .map((s) => ({
        receipt_number: s.receipt_number,
        plan_code: s.plan_code,
        amount_usd: Number(s.amount_usd || 0),
        indicative_azn: Math.round(Number(s.amount_usd || 0) * INDICATIVE_USD_TO_AZN * 100) / 100,
        created_at: s.created_at,
      })),
    existing_links_policy: EXISTING_LINKS_POLICY,
    seller_onboarding_note: SELLER_ONBOARDING_NOTE,
  };
}

async function cancelSelfServe({ workspaceId, ownerUserId, dbGet = dbGetAsync, dbRun = dbRunAsync } = {}) {
  await ensureCheckoutDunningTables(dbRun);
  const acct = await orgBilling.getOrgBillingAccount({ workspaceId, billingOwnerUserId: ownerUserId, dbGet, dbRun });
  if (!acct) return { error: 'not_found', statusCode: 404 };
  const nowIso = new Date().toISOString();
  await dbRun(
    "UPDATE org_billing_accounts SET status = 'cancelled', updated_at = ? WHERE workspace_id = ? AND billing_owner_user_id = ?",
    [nowIso, Number(workspaceId), Number(ownerUserId)]
  );
  return {
    cancelled: true,
    workspace_id: Number(workspaceId),
    status: 'cancelled',
    cancelled_at: nowIso,
    existing_links_policy: EXISTING_LINKS_POLICY,
  };
}

module.exports = {
  CHECKOUT_DUNNING_CONTRACT_VERSION,
  GRACE_PERIOD_DAYS,
  MAX_DUNNING_ATTEMPTS,
  PLAN_MONTHLY_USD,
  SELLER_ONBOARDING_NOTE,
  buildTrialTerms,
  evaluateDunningTransition,
  ensureCheckoutDunningTables,
  createCheckoutSession,
  completeSandboxCheckout,
  recordPaymentFailure,
  getBillingPortalSummary,
  cancelSelfServe,
};
