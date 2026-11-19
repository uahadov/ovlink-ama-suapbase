'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const dbUrl = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(dbUrl.split('?')[0]);

test('P31 integration: dry-run prepare, mandatory human confirmation, idempotent launch, tenant isolation & honest no-data summary', { skip: !safeDb && 'Requires isolated QA DB', timeout: 30000 }, async () => {
  const express = require('express');
  const { dbRunAsync } = require('../src/db/helpers');
  const campaignsRouter = require('../src/routes/api/campaigns');

  const suffix = crypto.randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();
  const u1 = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, created_at) VALUES (?, 1, 'pro', 'active', ?)",
    [`p31-a-${suffix}@example.com`, nowIso]
  );
  const u2 = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, created_at) VALUES (?, 1, 'pro', 'active', ?)",
    [`p31-b-${suffix}@example.com`, nowIso]
  );
  const userA = Number(u1.lastID);
  const userB = Number(u2.lastID);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const uid = Number(req.headers['x-test-user'] || 0);
    req.session = uid ? { userId: uid } : {};
    next();
  });
  app.use(campaignsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headersA = { 'x-test-user': String(userA), 'content-type': 'application/json' };
  const headersB = { 'x-test-user': String(userB), 'content-type': 'application/json' };

  try {
    // 1. Dry-run prepare_campaign -> returns trace_id + confirmation_token without writing campaign
    const prepRes = await fetch(`${baseUrl}/api/mcp/workflows/prepare-campaign`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({
        name: `MCP Launch ${suffix}`,
        goal: 'Leads',
        base_url: 'https://example.com/offer',
        channels: ['instagram', 'google'],
      }),
    });
    assert.equal(prepRes.status, 200);
    const prep = await prepRes.json();
    assert.match(prep.trace_id, /^trc_/);
    assert.match(prep.confirmation_token, /^cfm_/);
    assert.equal(prep.requires_human_confirmation, true);

    // 2. Launch without confirmation token -> blocked 403
    const noConfirmRes = await fetch(`${baseUrl}/api/mcp/workflows/launch-campaign`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({ trace_id: prep.trace_id }),
    });
    assert.equal(noConfirmRes.status, 403);

    // 3. Cross-tenant launch attempt by userB -> masked 404
    const crossTenantRes = await fetch(`${baseUrl}/api/mcp/workflows/launch-campaign`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({ trace_id: prep.trace_id, confirmation_token: prep.confirmation_token }),
    });
    assert.equal(crossTenantRes.status, 404);

    // 4. Valid launch with human confirmation + idempotency key -> creates campaign once; retry deduplicates
    const idemKey = `p31-idem-${suffix}`;
    const l1 = await fetch(`${baseUrl}/api/mcp/workflows/launch-campaign`, {
      method: 'POST',
      headers: { ...headersA, 'idempotency-key': idemKey },
      body: JSON.stringify({ trace_id: prep.trace_id, confirmation_token: prep.confirmation_token }),
    });
    assert.equal(l1.status, 201);
    const l1Body = await l1.json();
    assert.equal(l1Body.deduplicated, false);
    const launchedCampaignId = l1Body.result.campaign.id;

    const l2 = await fetch(`${baseUrl}/api/mcp/workflows/launch-campaign`, {
      method: 'POST',
      headers: { ...headersA, 'idempotency-key': idemKey },
      body: JSON.stringify({ trace_id: prep.trace_id, confirmation_token: prep.confirmation_token }),
    });
    assert.equal(l2.status, 200);
    const l2Body = await l2.json();
    assert.equal(l2Body.deduplicated, true);
    assert.equal(l2Body.result.campaign.id, launchedCampaignId);

    // 5. Summarize empty campaign -> explicitly answers unknown_no_data ("bilmirəm") with provenance
    const sumRes = await fetch(`${baseUrl}/api/mcp/workflows/summarize-report/${launchedCampaignId}`, {
      headers: headersA,
    });
    assert.equal(sumRes.status, 200);
    const sumBody = await sumRes.json();
    assert.equal(sumBody.answer_status, 'unknown_no_data');
    assert.ok(sumBody.provenance && sumBody.provenance.snapshot_id);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
