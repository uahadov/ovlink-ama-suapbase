'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const orgBilling = require('../src/lib/org-billing');

test('P34 unit: Polar product allowlist rejects unknown IDs and maps allowed tiers', () => {
  assert.equal(orgBilling.resolvePolarProductPlan('prod_ovlink_agency'), 'agency');
  assert.equal(orgBilling.resolvePolarProductPlan('prod_ovlink_business'), 'business');
  assert.equal(orgBilling.resolvePolarProductPlan('prod_unknown_rogue'), null);
});

const dbUrl = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(dbUrl.split('?')[0]);

test('P34 integration: grandfather legacy Pro preserved, duplicate webhook idempotency, cancel/renew/refund & personal isolation', { skip: !safeDb && 'Requires isolated QA DB', timeout: 30000 }, async () => {
  const express = require('express');
  const { dbRunAsync, dbGetAsync } = require('../src/db/helpers');
  const campaignsRouter = require('../src/routes/api/campaigns');

  const suffix = crypto.randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();
  // Legacy $4.99 personal Pro user
  const uRes = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, pro_expires_at, created_at) VALUES (?, 1, 'pro', 'active', '2030-01-01T00:00:00.000Z', ?)",
    [`p34-${suffix}@example.com`, nowIso]
  );
  const userId = Number(uRes.lastID);
  const wsRes = await dbRunAsync(
    'INSERT INTO workspaces (name, owner_user_id, created_at) VALUES (?, ?, ?)',
    [`P34 Org ${suffix}`, userId, nowIso]
  );
  const workspaceId = Number(wsRes.lastID);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId }; next(); });
  app.use(campaignsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const jsonHeaders = { 'content-type': 'application/json' };

  try {
    // 1. Unknown Polar product ID rejected (400)
    const badProd = await fetch(`${baseUrl}/api/org-billing/sandbox-webhook`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        provider_event_id: `pevt_bad_${suffix}`,
        workspace_id: workspaceId,
        event_type: 'subscription.created',
        polar_product_id: 'prod_fake_999',
      }),
    });
    assert.equal(badProd.status, 400);

    // 2. Valid subscription.created -> creates org account & preserves legacy personal Pro
    const evt1 = `pevt_create_${suffix}`;
    const w1 = await fetch(`${baseUrl}/api/org-billing/sandbox-webhook`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        provider_event_id: evt1,
        workspace_id: workspaceId,
        event_type: 'subscription.created',
        polar_product_id: 'prod_ovlink_agency',
        polar_customer_id: `cus_${suffix}`,
        polar_subscription_id: `sub_${suffix}`,
      }),
    });
    assert.equal(w1.status, 200);
    const w1Body = await w1.json();
    assert.equal(w1Body.deduplicated, false);
    assert.equal(w1Body.account.plan_code, 'agency');
    assert.equal(w1Body.account.who_pays.personal_plan_separate, true);
    assert.equal(w1Body.account.who_pays.personal_legacy_pro_preserved, true);

    // 3. Duplicate webhook -> deduplicated=true, no second subscription created
    const w1Dup = await fetch(`${baseUrl}/api/org-billing/sandbox-webhook`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        provider_event_id: evt1,
        workspace_id: workspaceId,
        event_type: 'subscription.created',
        polar_product_id: 'prod_ovlink_agency',
      }),
    });
    assert.equal(w1Dup.status, 200);
    const w1DupBody = await w1Dup.json();
    assert.equal(w1DupBody.deduplicated, true);

    // 4. Cancel -> Renew -> Refund transitions
    const wCancel = await fetch(`${baseUrl}/api/org-billing/sandbox-webhook`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ provider_event_id: `pevt_can_${suffix}`, workspace_id: workspaceId, event_type: 'subscription.canceled' }),
    });
    assert.equal((await wCancel.json()).account.status, 'cancelled');

    const wRenew = await fetch(`${baseUrl}/api/org-billing/sandbox-webhook`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ provider_event_id: `pevt_ren_${suffix}`, workspace_id: workspaceId, event_type: 'subscription.renewed', polar_product_id: 'prod_ovlink_business' }),
    });
    const renewBody = await wRenew.json();
    assert.equal(renewBody.account.status, 'active');
    assert.equal(renewBody.account.plan_code, 'business');

    const wRefund = await fetch(`${baseUrl}/api/org-billing/sandbox-webhook`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ provider_event_id: `pevt_ref_${suffix}`, workspace_id: workspaceId, event_type: 'order.refunded' }),
    });
    const refundBody = await wRefund.json();
    assert.equal(refundBody.account.status, 'refunded');
    assert.equal(refundBody.account.plan_code, 'free');

    // 5. Personal Pro in `users` table was NEVER touched by org refund!
    const userRow = await dbGetAsync('SELECT plan_tier, plan_status FROM users WHERE id = ?', [userId]);
    assert.equal(userRow.plan_tier, 'pro');
    assert.equal(userRow.plan_status, 'active');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
