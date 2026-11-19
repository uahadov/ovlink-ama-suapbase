'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const unitEconomics = require('../src/lib/unit-economics');
const orgBilling = require('../src/lib/org-billing');
const { dbRunAsync } = require('../src/db/helpers');

function requestJson(baseUrl, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, baseUrl);
    const payload = body !== null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { json = null; }
          resolve({ status: res.statusCode, body: json, text: raw });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('P37 unit: all tiers show worst-case cost ceiling, safe paid gross margins, and honest null LTV/CAC', () => {
  const all = unitEconomics.listAllPlanUnitEconomics();
  assert.equal(all.contract_version, 'unit-economics-v1');
  assert.equal(all.ltv_usd, null);
  assert.equal(all.cac_usd, null);
  assert.equal(all.existing_links_policy.existing_links_redirect_normally, true);

  for (const tier of ['free', 'legacy_pro', 'starter', 'business', 'agency', 'enterprise']) {
    const plan = all.plans[tier];
    assert.ok(plan, `missing plan ${tier}`);
    assert.equal(plan.is_margin_safe, true, `${tier} must be margin safe`);
    assert.equal(plan.ltv_usd, null);
    assert.equal(plan.cac_usd, null);
    assert.ok(plan.worst_case_cost_usd > 0, `${tier} worst-case cost must be positive`);
    if (tier !== 'free') {
      assert.ok(plan.worst_case_gross_margin_pct >= 65, `${tier} worst-case margin >= 65%`);
    } else {
      assert.ok(plan.worst_case_cost_usd <= 0.25, 'free tier worst-case cost bounded <= $0.25');
    }
  }
});

test('P37 unit: usage forecast alerts and high-traffic stress quota check work deterministically', () => {
  const fa = unitEconomics.evaluateUsageForecastAndAlerts({
    planCode: 'starter',
    usage: {
      redirects: 290000, // 96.7% -> critical_95pct
      pdf_exports: 25,   // 83.3% -> warning_80pct
      emails_sent: 100,
      ai_tokens_k: 20,
      db_storage_mb: 200,
      support_tickets: 0.25,
    },
    now: new Date('2026-11-10T12:00:00Z'),
  });
  assert.ok(fa.alerts.some((a) => a.metric === 'redirects' && a.severity === 'critical_95pct'));
  assert.ok(fa.alerts.some((a) => a.metric === 'pdf_exports' && a.severity === 'warning_80pct'));

  const stress = unitEconomics.runStressQuotaCheck({
    planCode: 'starter',
    redirects: 8_000_000,
    pdfExports: 500,
    emailsSent: 3000,
    aiTokensK: 1000,
    dbStorageGb: 10,
    supportTickets: 4,
  });
  assert.equal(stress.redirect_continuity_guaranteed, true);
  assert.equal(stress.margin_healthy_under_stress, false);
  assert.ok(stress.cap_breaches.length >= 4);
});

test('P37 unit: fail-open metering guarantees legacy redirects NEVER break on DB error', async () => {
  const brokenRun = async () => {
    throw new Error('simulated_pg_metering_outage');
  };
  const res = await unitEconomics.recordUsageEventFailOpen({
    workspaceId: 999999,
    metric: 'redirects',
    delta: 1,
    runFn: brokenRun,
  });
  assert.equal(res.recorded, false);
  assert.equal(res.fail_open, true);
  assert.equal(res.redirect_impacted, false);
  assert.equal(res.error, 'metering_failed_open');
});

test('P37 DB + HTTP: monthly usage rollup, cost allocation, and auth guard work end-to-end', async () => {
  const wsId = 370000 + Math.floor(Math.random() * 5000);
  const ownerId = 37001;
  const billingMonth = '2026-11';

  await orgBilling.ensureOrgBillingTables();
  await unitEconomics.ensureUnitEconomicsTables();

  await orgBilling.upsertOrgBillingAccount({
    workspaceId: wsId,
    billingOwnerUserId: ownerId,
    planCode: 'business',
    status: 'active',
  });

  let activeUserId = ownerId;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = activeUserId ? { userId: activeUserId } : {};
    next();
  });
  const campaignsRouter = require('../src/routes/api/campaigns');
  app.use(campaignsRouter);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1) Plans matrix endpoint
    const plansRes = await requestJson(baseUrl, 'GET', '/api/unit-economics/plans');
    assert.equal(plansRes.status, 200);
    assert.equal(plansRes.body.plans.business.monthly_revenue_usd, 19);
    assert.equal(plansRes.body.ltv_usd, null);

    // 2) Record metered usage increments
    const u1 = await requestJson(baseUrl, 'POST', `/api/unit-economics/workspaces/${wsId}/usage`, {
      metric: 'redirects',
      delta: 1200000,
      billing_month: billingMonth,
    });
    assert.equal(u1.status, 200);
    assert.equal(u1.body.recorded, true);
    assert.equal(u1.body.redirect_impacted, false);

    const u2 = await requestJson(baseUrl, 'POST', `/api/unit-economics/workspaces/${wsId}/usage`, {
      metric: 'pdf_exports',
      delta: 40,
      billing_month: billingMonth,
    });
    assert.equal(u2.status, 200);
    assert.equal(u2.body.recorded, true);

    // 3) Read workspace cost allocation & margin
    const alloc = await requestJson(baseUrl, 'GET', `/api/unit-economics/workspaces/${wsId}?month=${billingMonth}`);
    assert.equal(alloc.status, 200);
    assert.equal(alloc.body.plan_code, 'business');
    assert.equal(alloc.body.usage.redirects, 1200000);
    assert.equal(alloc.body.usage.pdf_exports, 40);
    assert.ok(alloc.body.economics.actual_gross_margin_pct > 85);
    assert.equal(alloc.body.economics.ltv_usd, null);

    // 4) Stress check endpoint
    const stressRes = await requestJson(baseUrl, 'POST', '/api/unit-economics/stress-check', {
      plan_code: 'business',
      redirects: 2000000,
      pdf_exports: 200,
      emails_sent: 1000,
      ai_tokens_k: 200,
      db_storage_gb: 3,
      support_tickets: 0.5,
    });
    assert.equal(stressRes.status, 200);
    assert.equal(stressRes.body.margin_healthy_under_stress, true);

    // 5) Unauthenticated rejected with 401
    activeUserId = null;
    const unauth = await requestJson(baseUrl, 'GET', '/api/unit-economics/plans');
    assert.equal(unauth.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await dbRunAsync('DELETE FROM org_usage_monthly WHERE workspace_id = ?', [wsId]).catch(() => {});
    await dbRunAsync('DELETE FROM org_billing_accounts WHERE workspace_id = ?', [wsId]).catch(() => {});
  }
});
