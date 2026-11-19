'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const checkoutDunning = require('../src/lib/checkout-dunning');

test('P36 unit: trial auto-renew disclosures (AZ/EN, USD/AZN) and 7-day dunning grace period transitions', () => {
  const terms = checkoutDunning.buildTrialTerms(14, 'business');
  assert.equal(terms.trial_days, 14);
  assert.equal(terms.auto_renews, true);
  assert.equal(terms.cancel_anytime_before_charge, true);
  assert.equal(terms.monthly_price_usd, 49);
  assert.ok(terms.indicative_price_azn > 0);
  assert.match(terms.disclosure_az, /14 günlük sınaq/);

  // Attempt 1 -> enters past_due with 7-day grace period
  const d1 = checkoutDunning.evaluateDunningTransition({ dunningAttempts: 0, now: new Date('2026-11-20T00:00:00.000Z') });
  assert.equal(d1.next_status, 'past_due');
  assert.equal(d1.grace_expired, false);
  assert.equal(d1.reminder_stage, 'day_0_notice');

  // Attempt 3 -> grace period ends -> downgrades cleanly to free while preserving existing links
  const d3 = checkoutDunning.evaluateDunningTransition({ dunningAttempts: 2, gracePeriodEndsAt: d1.grace_period_ends_at, now: new Date('2026-11-26T00:00:00.000Z') });
  assert.equal(d3.grace_expired, true);
  assert.equal(d3.next_status, 'cancelled');
  assert.equal(d3.effective_plan_after, 'free');
  assert.equal(d3.existing_links_policy.existing_links_redirect_normally, true);
});

const dbUrl = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(dbUrl.split('?')[0]);

test('P36 integration: sandbox checkout->webhook activation, receipts, dunning grace period & self-serve cancel', { skip: !safeDb && 'Requires isolated QA DB', timeout: 30000 }, async () => {
  const express = require('express');
  const { dbRunAsync } = require('../src/db/helpers');
  const campaignsRouter = require('../src/routes/api/campaigns');

  const suffix = crypto.randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();
  const uRes = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, created_at) VALUES (?, 1, 'free', 'active', ?)",
    [`p36-${suffix}@example.com`, nowIso]
  );
  const userId = Number(uRes.lastID);
  const wsRes = await dbRunAsync(
    'INSERT INTO workspaces (name, owner_user_id, created_at) VALUES (?, ?, ?)',
    [`P36 Biz ${suffix}`, userId, nowIso]
  );
  const wsId = Number(wsRes.lastID);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId }; next(); });
  app.use(campaignsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const jsonHeaders = { 'content-type': 'application/json' };

  try {
    // 1. Create Business checkout session with 14-day trial
    const sessRes = await fetch(`${baseUrl}/api/checkout/sessions`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ workspace_id: wsId, plan_code: 'business', trial_days: 14, currency_display: 'AZN' }),
    });
    assert.equal(sessRes.status, 201);
    const sess = await sessRes.json();
    assert.match(sess.checkout_id, /^chk_/);
    assert.equal(sess.trial_terms.auto_renews, true);

    // 2. Complete sandbox checkout via webhook -> activates Business plan & issues receipt
    const compRes = await fetch(`${baseUrl}/api/checkout/sessions/${sess.checkout_id}/sandbox-complete`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(compRes.status, 200);
    const comp = await compRes.json();
    assert.equal(comp.status, 'completed');
    assert.equal(comp.account.plan_code, 'business');
    assert.match(comp.receipt.receipt_number, /^OVL-/);

    // 3. Payment failure -> enters past_due Grace Period (existing links remain unaffected)
    const fail1 = await fetch(`${baseUrl}/api/billing-portal/${wsId}/payment-failed`, { method: 'POST' });
    assert.equal(fail1.status, 200);
    const f1Body = await fail1.json();
    assert.equal(f1Body.next_status, 'past_due');
    assert.equal(f1Body.existing_links_policy.existing_links_redirect_normally, true);

    // 4. Billing portal shows receipts & self-serve cancel endpoint
    const portalRes = await fetch(`${baseUrl}/api/billing-portal/${wsId}`);
    assert.equal(portalRes.status, 200);
    const portal = await portalRes.json();
    assert.equal(portal.self_serve_actions.can_cancel_anytime, true);
    assert.equal(portal.receipts.length, 1);

    // 5. User cancels anytime self-serve
    const cancelRes = await fetch(`${baseUrl}/api/billing-portal/${wsId}/cancel`, { method: 'POST' });
    assert.equal(cancelRes.status, 200);
    const cancelBody = await cancelRes.json();
    assert.equal(cancelBody.cancelled, true);
    assert.equal(cancelBody.existing_links_policy.existing_links_redirect_normally, true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
