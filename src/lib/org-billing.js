'use strict';

/**
 * P34 — B2B Organization Billing Model (org-billing-v1).
 *
 * Separates organization/workspace subscriptions from personal Pro accounts
 * (preserving legacy $4.99 personal Pro grandfather rights), enforces Polar
 * product ID allowlists, processes subscription webhooks idempotently, and
 * clearly answers "who pays?" and "what is included?".
 */

const { dbGetAsync, dbRunAsync } = require('../db/helpers');

const ORG_BILLING_CONTRACT_VERSION = 'org-billing-v1';
const ALLOWED_ORG_PLANS = new Set(['free', 'starter', 'business', 'agency', 'enterprise']);
const ALLOWED_SUB_STATUSES = new Set(['active', 'trialing', 'past_due', 'cancelled', 'refunded']);

// Default sandbox Polar product ID allowlist (overridable via env POLAR_ORG_PRODUCT_MAP_JSON)
const DEFAULT_POLAR_PRODUCT_ALLOWLIST = Object.freeze({
  prod_ovlink_starter: 'starter',
  prod_ovlink_business: 'business',
  prod_ovlink_agency: 'agency',
  prod_ovlink_enterprise: 'enterprise',
});

let orgBillingTablesReady = false;

function getPolarProductAllowlist() {
  if (process.env.POLAR_ORG_PRODUCT_MAP_JSON) {
    try {
      const parsed = JSON.parse(process.env.POLAR_ORG_PRODUCT_MAP_JSON);
      if (parsed && typeof parsed === 'object') return { ...DEFAULT_POLAR_PRODUCT_ALLOWLIST, ...parsed };
    } catch {
      // fall back to default allowlist
    }
  }
  return DEFAULT_POLAR_PRODUCT_ALLOWLIST;
}

function resolvePolarProductPlan(productId, allowlist = getPolarProductAllowlist()) {
  const id = String(productId || '').trim();
  if (!id || !Object.prototype.hasOwnProperty.call(allowlist, id)) return null;
  const plan = String(allowlist[id] || '').toLowerCase();
  return ALLOWED_ORG_PLANS.has(plan) ? plan : null;
}

function normalizeAddons(raw) {
  const allowed = new Set(['extra_seats', 'extra_domains', 'extra_client_workspaces', 'dedicated_audit']);
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map((x) => String(x || '').trim().toLowerCase()).filter((x) => allowed.has(x)))];
}

async function ensureOrgBillingTables(runFn = dbRunAsync) {
  if (orgBillingTablesReady) return;
  await runFn(`CREATE TABLE IF NOT EXISTS org_billing_accounts (
    id SERIAL PRIMARY KEY,
    workspace_id INTEGER NOT NULL UNIQUE,
    billing_owner_user_id INTEGER NOT NULL,
    plan_code TEXT NOT NULL DEFAULT 'free',
    status TEXT NOT NULL DEFAULT 'active',
    addons_json TEXT NOT NULL DEFAULT '[]',
    polar_customer_id TEXT,
    polar_subscription_id TEXT,
    polar_product_id TEXT,
    grandfathered_legacy_pro BOOLEAN NOT NULL DEFAULT FALSE,
    current_period_end TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await runFn(`CREATE TABLE IF NOT EXISTS org_billing_events (
    id SERIAL PRIMARY KEY,
    provider_event_id TEXT NOT NULL UNIQUE,
    workspace_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    plan_code TEXT,
    status_after TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  orgBillingTablesReady = true;
}

function mapBillingAccountRow(row, ownerPersonalPlan = null) {
  if (!row) return null;
  let addons = [];
  try { addons = JSON.parse(row.addons_json || '[]'); } catch { addons = []; }
  return {
    contract_version: ORG_BILLING_CONTRACT_VERSION,
    id: Number(row.id),
    workspace_id: Number(row.workspace_id),
    billing_owner_user_id: Number(row.billing_owner_user_id),
    plan_code: row.plan_code,
    status: row.status,
    addons,
    polar_customer_id: row.polar_customer_id || null,
    polar_subscription_id: row.polar_subscription_id || null,
    polar_product_id: row.polar_product_id || null,
    grandfathered_legacy_pro: Boolean(row.grandfathered_legacy_pro),
    current_period_end: row.current_period_end || null,
    who_pays: {
      scope: 'organization_workspace',
      billing_owner_user_id: Number(row.billing_owner_user_id),
      personal_plan_separate: true,
      personal_legacy_pro_preserved: ownerPersonalPlan
        ? String(ownerPersonalPlan.plan_tier || '').toLowerCase() === 'pro'
        : Boolean(row.grandfathered_legacy_pro),
    },
    whats_included: {
      plan_code: row.plan_code,
      addons,
      note: 'Organization plan governs shared workspace/client seats and quotas without overwriting personal Pro legacy rights.',
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function upsertOrgBillingAccount({
  workspaceId,
  billingOwnerUserId,
  planCode = 'starter',
  addons = [],
  polarCustomerId = null,
  polarSubscriptionId = null,
  polarProductId = null,
  dbGet = dbGetAsync,
  dbRun = dbRunAsync,
} = {}) {
  await ensureOrgBillingTables(dbRun);
  const safePlan = ALLOWED_ORG_PLANS.has(String(planCode).toLowerCase()) ? String(planCode).toLowerCase() : 'free';
  const safeAddons = normalizeAddons(addons);
  const ownerRow = await dbGet('SELECT plan_tier, plan_status FROM users WHERE id = ? LIMIT 1', [Number(billingOwnerUserId)]);
  const hasLegacyPro = Boolean(ownerRow && String(ownerRow.plan_tier || '').toLowerCase() === 'pro');
  const nowIso = new Date().toISOString();

  await dbRun(
    `INSERT INTO org_billing_accounts
       (workspace_id, billing_owner_user_id, plan_code, status, addons_json, polar_customer_id,
        polar_subscription_id, polar_product_id, grandfathered_legacy_pro, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET
       plan_code = EXCLUDED.plan_code,
       addons_json = EXCLUDED.addons_json,
       polar_customer_id = COALESCE(EXCLUDED.polar_customer_id, org_billing_accounts.polar_customer_id),
       polar_subscription_id = COALESCE(EXCLUDED.polar_subscription_id, org_billing_accounts.polar_subscription_id),
       polar_product_id = COALESCE(EXCLUDED.polar_product_id, org_billing_accounts.polar_product_id),
       updated_at = EXCLUDED.updated_at`,
    [
      Number(workspaceId),
      Number(billingOwnerUserId),
      safePlan,
      JSON.stringify(safeAddons),
      polarCustomerId,
      polarSubscriptionId,
      polarProductId,
      hasLegacyPro,
      nowIso,
      nowIso,
    ]
  );

  const row = await dbGet('SELECT * FROM org_billing_accounts WHERE workspace_id = ? LIMIT 1', [Number(workspaceId)]);
  return { account: mapBillingAccountRow(row, ownerRow) };
}

async function getOrgBillingAccount({ workspaceId, billingOwnerUserId, dbGet = dbGetAsync, dbRun = dbRunAsync } = {}) {
  await ensureOrgBillingTables(dbRun);
  const row = await dbGet(
    'SELECT * FROM org_billing_accounts WHERE workspace_id = ? AND billing_owner_user_id = ? LIMIT 1',
    [Number(workspaceId), Number(billingOwnerUserId)]
  );
  if (!row) return null;
  const ownerRow = await dbGet('SELECT plan_tier, plan_status FROM users WHERE id = ? LIMIT 1', [Number(billingOwnerUserId)]);
  return mapBillingAccountRow(row, ownerRow);
}

/**
 * Idempotently applies a Polar organization subscription event (created/updated/renewed/canceled/refunded).
 * Duplicate `providerEventId` never creates a second subscription or double-mutates state.
 * Personal `users.plan_tier` is NEVER overwritten.
 */
async function applyOrgSubscriptionWebhookEvent({
  providerEventId,
  workspaceId,
  billingOwnerUserId,
  eventType,
  polarProductId = null,
  polarCustomerId = null,
  polarSubscriptionId = null,
  currentPeriodEnd = null,
  dbGet = dbGetAsync,
  dbRun = dbRunAsync,
} = {}) {
  await ensureOrgBillingTables(dbRun);
  const cleanEvtId = String(providerEventId || '').trim();
  if (!cleanEvtId) return { error: 'missing_provider_event_id', statusCode: 400 };

  const existingEvt = await dbGet('SELECT * FROM org_billing_events WHERE provider_event_id = ? LIMIT 1', [cleanEvtId]);
  if (existingEvt) {
    const acct = await getOrgBillingAccount({ workspaceId: existingEvt.workspace_id, billingOwnerUserId, dbGet, dbRun });
    return { deduplicated: true, event_id: cleanEvtId, account: acct };
  }

  let resolvedPlan = null;
  if (['subscription.created', 'subscription.updated', 'subscription.renewed'].includes(eventType)) {
    resolvedPlan = resolvePolarProductPlan(polarProductId);
    if (!resolvedPlan) {
      return { error: 'polar_product_not_allowlisted', statusCode: 400, message: 'Polar product ID allowlist-də deyil.' };
    }
  }

  let nextStatus = 'active';
  if (eventType === 'subscription.canceled') nextStatus = 'cancelled';
  else if (eventType === 'order.refunded') nextStatus = 'refunded';
  else if (!['subscription.created', 'subscription.updated', 'subscription.renewed'].includes(eventType)) {
    return { error: 'unsupported_event_type', statusCode: 400 };
  }

  const nowIso = new Date().toISOString();
  const existingAcct = await dbGet('SELECT * FROM org_billing_accounts WHERE workspace_id = ? LIMIT 1', [Number(workspaceId)]);
  const ownerRow = await dbGet('SELECT plan_tier, plan_status FROM users WHERE id = ? LIMIT 1', [Number(billingOwnerUserId)]);
  const hasLegacyPro = Boolean(ownerRow && String(ownerRow.plan_tier || '').toLowerCase() === 'pro');

  if (!existingAcct) {
    await dbRun(
      `INSERT INTO org_billing_accounts
         (workspace_id, billing_owner_user_id, plan_code, status, addons_json, polar_customer_id,
          polar_subscription_id, polar_product_id, grandfathered_legacy_pro, current_period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(workspaceId),
        Number(billingOwnerUserId),
        resolvedPlan || 'free',
        nextStatus,
        polarCustomerId,
        polarSubscriptionId,
        polarProductId,
        hasLegacyPro,
        currentPeriodEnd,
        nowIso,
        nowIso,
      ]
    );
  } else {
    const nextPlan = resolvedPlan || (nextStatus === 'refunded' ? 'free' : existingAcct.plan_code);
    await dbRun(
      `UPDATE org_billing_accounts
          SET plan_code = ?, status = ?, polar_customer_id = COALESCE(?, polar_customer_id),
              polar_subscription_id = COALESCE(?, polar_subscription_id),
              polar_product_id = COALESCE(?, polar_product_id),
              current_period_end = COALESCE(?, current_period_end),
              updated_at = ?
        WHERE workspace_id = ?`,
      [nextPlan, nextStatus, polarCustomerId, polarSubscriptionId, polarProductId, currentPeriodEnd, nowIso, Number(workspaceId)]
    );
  }

  await dbRun(
    'INSERT INTO org_billing_events (provider_event_id, workspace_id, event_type, plan_code, status_after, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [cleanEvtId, Number(workspaceId), eventType, resolvedPlan, nextStatus, nowIso]
  );

  const updated = await getOrgBillingAccount({ workspaceId, billingOwnerUserId, dbGet, dbRun });
  return { deduplicated: false, event_id: cleanEvtId, account: updated };
}

module.exports = {
  ORG_BILLING_CONTRACT_VERSION,
  ALLOWED_ORG_PLANS,
  ALLOWED_SUB_STATUSES,
  DEFAULT_POLAR_PRODUCT_ALLOWLIST,
  getPolarProductAllowlist,
  resolvePolarProductPlan,
  ensureOrgBillingTables,
  upsertOrgBillingAccount,
  getOrgBillingAccount,
  applyOrgSubscriptionWebhookEvent,
};
