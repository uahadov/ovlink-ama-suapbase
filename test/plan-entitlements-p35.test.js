'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const planEntitlements = require('../src/lib/plan-entitlements');

test('P35 unit: identical limits across API/UI/MCP, soft 80% warning vs 100% hard limit & trial expiry fallback', () => {
  // Identical calculation across API, UI, and MCP entrypoints
  for (const ep of ['api', 'ui', 'mcp']) {
    const ok = planEntitlements.evaluateEntitlementCheck({
      planCode: 'starter',
      metric: 'campaigns',
      currentUsage: 5,
      increment: 1,
      entrypoint: ep,
    });
    assert.equal(ok.allowed, true);
    assert.equal(ok.level, 'ok');
    assert.equal(ok.limit, 15);

    const warn = planEntitlements.evaluateEntitlementCheck({
      planCode: 'starter',
      metric: 'campaigns',
      currentUsage: 11,
      increment: 1, // 12/15 = 80%
      entrypoint: ep,
    });
    assert.equal(warn.allowed, true);
    assert.equal(warn.level, 'soft_warning');
    assert.equal(warn.recommended_tier, 'business');

    const blocked = planEntitlements.evaluateEntitlementCheck({
      planCode: 'starter',
      metric: 'campaigns',
      currentUsage: 15,
      increment: 1,
      entrypoint: ep,
    });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.level, 'hard_limit');
    assert.equal(blocked.recommended_tier, 'business');
    assert.ok(blocked.upgrade_reason.includes('campaigns'));
    assert.equal(blocked.existing_links_policy.existing_links_redirect_normally, true);
  }

  // Expired trial falls back to free limits cleanly
  const expiredTrial = planEntitlements.evaluateEntitlementCheck({
    planCode: 'agency',
    status: 'trialing',
    trialEndsAt: '2020-01-01T00:00:00.000Z',
    metric: 'campaigns',
    currentUsage: 3,
    increment: 1,
  });
  assert.equal(expiredTrial.effective_plan, 'free');
  assert.equal(expiredTrial.allowed, false);
  assert.equal(expiredTrial.limit, 3);
});

const dbUrl = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(dbUrl.split('?')[0]);

test('P35 integration: workspace entitlements read model, hard limit check, upgrade restoration & zero data loss', { skip: !safeDb && 'Requires isolated QA DB', timeout: 30000 }, async () => {
  const express = require('express');
  const { dbRunAsync, dbGetAsync } = require('../src/db/helpers');
  const campaignsRouter = require('../src/routes/api/campaigns');

  const suffix = crypto.randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();
  const uRes = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, created_at) VALUES (?, 1, 'pro', 'active', ?)",
    [`p35-${suffix}@example.com`, nowIso]
  );
  const userId = Number(uRes.lastID);
  const wsRes = await dbRunAsync(
    'INSERT INTO workspaces (name, owner_user_id, created_at) VALUES (?, ?, ?)',
    [`P35 Org ${suffix}`, userId, nowIso]
  );
  const wsId = Number(wsRes.lastID);

  // Create 3 campaigns in workspace (at Free tier cap of 3)
  for (let i = 1; i <= 3; i += 1) {
    await dbRunAsync(
      "INSERT INTO campaigns (user_id, workspace_id, name, slug, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
      [userId, wsId, `P35 C${i} ${suffix}`, `p35-c${i}-${suffix}`, nowIso]
    );
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId }; next(); });
  app.use(campaignsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const jsonHeaders = { 'content-type': 'application/json' };

  try {
    // 1. On Free tier with 3 campaigns -> creating a 4th campaign is blocked with concrete upgrade reason
    const checkFree = await fetch(`${baseUrl}/api/entitlements/${wsId}/check`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ metric: 'campaigns', increment: 1, entrypoint: 'mcp' }),
    });
    assert.equal(checkFree.status, 200);
    const freeBody = await checkFree.json();
    assert.equal(freeBody.allowed, false);
    assert.equal(freeBody.effective_plan, 'free');
    assert.equal(freeBody.recommended_tier, 'starter');

    // 2. Upgrade org to 'agency' -> limits restore immediately & all 3 existing campaigns remain intact
    const upgRes = await fetch(`${baseUrl}/api/org-billing/accounts`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ workspace_id: wsId, plan_code: 'agency' }),
    });
    assert.equal(upgRes.status, 201);

    const checkAgency = await fetch(`${baseUrl}/api/entitlements/${wsId}/check`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ metric: 'campaigns', increment: 1, entrypoint: 'ui' }),
    });
    const agencyBody = await checkAgency.json();
    assert.equal(agencyBody.allowed, true);
    assert.equal(agencyBody.effective_plan, 'agency');
    assert.equal(agencyBody.limit, 500);

    // 3. Read full unified model
    const readRes = await fetch(`${baseUrl}/api/entitlements/${wsId}?entrypoint=api`);
    assert.equal(readRes.status, 200);
    const readBody = await readRes.json();
    assert.equal(readBody.meters.campaigns.used, 3);
    assert.equal(readBody.existing_links_policy.historical_data_deleted_on_downgrade, false);

    // Verify 0 data loss
    const countRow = await dbGetAsync('SELECT COUNT(*) AS cnt FROM campaigns WHERE workspace_id = ?', [wsId]);
    assert.equal(Number(countRow.cnt), 3);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
