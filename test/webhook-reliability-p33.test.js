'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const webhookRel = require('../src/lib/webhook-reliability');

test('P33 unit: HMAC signing, replay window, SSRF private-IP block & scoped API key isolation', () => {
  const secret = 'whsec_test_12345';
  const rawBody = JSON.stringify(webhookRel.buildWebhookEventEnvelope({ eventType: 'conversion.recorded', data: { value: 50 } }));
  const signed = webhookRel.signWebhookPayload({ secret, rawBody, timestamp: 1700000000 });
  assert.equal(webhookRel.verifyWebhookSignature({ secret, signatureHeader: signed.header, rawBody, nowSeconds: 1700000050 }).valid, true);
  assert.equal(webhookRel.verifyWebhookSignature({ secret, signatureHeader: signed.header, rawBody, nowSeconds: 1700000900 }).valid, false);
  assert.equal(webhookRel.verifyWebhookSignature({ secret: 'wrong', signatureHeader: signed.header, rawBody, nowSeconds: 1700000050 }).valid, false);

  // SSRF protection
  assert.equal(webhookRel.validateWebhookTargetUrl('https://127.0.0.1/hook').valid, false);
  assert.equal(webhookRel.validateWebhookTargetUrl('https://169.254.169.254/latest').valid, false);
  assert.equal(webhookRel.validateWebhookTargetUrl('https://hooks.zapier.com/hooks/catch/123').valid, true);

  // Workspace/organization API key isolation
  assert.equal(
    webhookRel.evaluateScopedApiKeyAccess({ apiKeyRecord: { workspace_id: 10 }, targetWorkspaceId: 20 }).allowed,
    false
  );
  assert.equal(
    webhookRel.evaluateScopedApiKeyAccess({ apiKeyRecord: { workspace_id: 10 }, targetWorkspaceId: 10 }).allowed,
    true
  );
});

const dbUrl = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(dbUrl.split('?')[0]);

test('P33 integration: 5xx/timeout tracked retry, matching event/request IDs & manual replay', { skip: !safeDb && 'Requires isolated QA DB', timeout: 30000 }, async () => {
  const express = require('express');
  const { dbRunAsync } = require('../src/db/helpers');
  const campaignsRouter = require('../src/routes/api/campaigns');

  const suffix = crypto.randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();
  const uRes = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, created_at) VALUES (?, 1, 'pro', 'active', ?)",
    [`p33-${suffix}@example.com`, nowIso]
  );
  const userId = Number(uRes.lastID);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId }; next(); });
  app.use(campaignsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const jsonHeaders = { 'content-type': 'application/json' };

  try {
    // 1. Simulated 503 failure -> status 'retrying', next_retry_at set, event_id & request_id recorded
    const d1Res = await fetch(`${baseUrl}/api/integrations/webhooks/test-delivery`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        target_url: 'https://hooks.zapier.com/hooks/catch/999/test',
        event_type: 'conversion.recorded',
        simulate_status: 503,
      }),
    });
    assert.equal(d1Res.status, 200);
    const d1 = await d1Res.json();
    assert.equal(d1.delivery.status, 'retrying');
    assert.ok(d1.delivery.next_retry_at);
    assert.match(d1.delivery.event_id, /^evt_/);
    assert.match(d1.delivery.request_id, /^req_/);

    // 2. Manual replay -> preserves original event_id, issues new request_id, marks delivered
    const repRes = await fetch(`${baseUrl}/api/integrations/webhooks/deliveries/${d1.delivery.id}/replay`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ simulate_status: 200 }),
    });
    assert.equal(repRes.status, 200);
    const rep = await repRes.json();
    assert.equal(rep.delivery.status, 'delivered');
    assert.equal(rep.delivery.event_id, d1.delivery.event_id);
    assert.notEqual(rep.delivery.request_id, d1.delivery.request_id);
    assert.equal(rep.delivery.replayed_from_id, d1.delivery.id);

    // 3. Delivery logs list both entries
    const logsRes = await fetch(`${baseUrl}/api/integrations/webhooks/deliveries`);
    assert.equal(logsRes.status, 200);
    const logs = await logsRes.json();
    assert.equal(logs.deliveries.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
