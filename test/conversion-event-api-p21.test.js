'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'p21-conv-test-secret-0123456789abcdef0123456789abcdef';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('node:http');
const { Client } = require('pg');

const convLib = require('../src/lib/conversion-events');
const jsSdk = require('../public/ovlink-conversion');
const { buildApiKeyValue, hashApiKeyValue, getApiKeyPrefix, getApiKeyLast4 } = require('../src/lib/security');

const url = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(url.split('?')[0]);

async function jsonFetch(baseUrl, path, { method = 'GET', headers = {}, body } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (typeof body === 'string') {
      opts.body = body;
      if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
    } else {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(`${baseUrl}${path}`, opts);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

test('P21 unit: schema validation, timestamp window, HMAC signature & minimal JS SDK consent', async () => {
  const now = new Date('2026-11-19T12:00:00.000Z');

  const ok = convLib.validateConversionEventPayload({
    event_id: 'ord_2026_001',
    short: 'sale26',
    goal: 'purchase',
    timestamp: '2026-11-19T11:55:00.000Z',
    source: 'checkout',
    consent: 'analytics',
    value: 99.5,
    currency: 'azn',
    actor: { external_id: 'cust-77' },
  }, { now });
  assert.equal(ok.ok, true);
  assert.equal(ok.event.value_amount, 99.5);
  assert.equal(ok.event.value_currency, 'AZN');
  assert.ok(ok.event.actor_hash && !ok.event.actor_hash.includes('cust-77'));

  const future = convLib.validateConversionEventPayload({
    event_id: 'ord_future',
    short: 'sale26',
    goal: 'lead',
    timestamp: '2026-11-19T12:15:00.000Z',
  }, { now });
  assert.equal(future.ok, false);
  assert.equal(future.field, 'timestamp');

  const stale = convLib.validateConversionEventPayload({
    event_id: 'ord_stale',
    short: 'sale26',
    goal: 'lead',
    timestamp: '2026-10-01T00:00:00.000Z',
  }, { now });
  assert.equal(stale.ok, false);
  assert.equal(stale.field, 'timestamp');

  const noCur = convLib.validateConversionEventPayload({
    event_id: 'ord_nocur',
    short: 'sale26',
    goal: 'purchase',
    value: 50,
  }, { now });
  assert.equal(noCur.ok, false);
  assert.equal(noCur.field, 'currency');

  const ess = convLib.validateConversionEventPayload({
    event_id: 'ord_ess_01',
    short: 'sale26',
    goal: 'lead',
    consent: 'essential',
    actor: { external_id: 'should-not-hash' },
  }, { now });
  assert.equal(ess.ok, true);
  assert.equal(ess.event.actor_hash, null);

  const secret = 'ovl_test_secret_key';
  const rawBody = JSON.stringify({ event_id: 'sig_1', short: 'abc', goal: 'lead' });
  const tsSec = Math.floor(now.getTime() / 1000);
  const sig = convLib.computeConversionSignature({ secret, timestampSec: tsSec, rawBody });
  assert.equal(
    convLib.verifyConversionSignature({ secret, timestampHeader: String(tsSec), signatureHeader: sig, rawBody, nowMs: now.getTime() }).valid,
    true
  );
  assert.equal(
    convLib.verifyConversionSignature({ secret, timestampHeader: String(tsSec), signatureHeader: 'sha256=deadbeef', rawBody, nowMs: now.getTime() }).valid,
    false
  );
  assert.equal(
    convLib.verifyConversionSignature({ secret, timestampHeader: String(tsSec - 600), signatureHeader: sig, rawBody, nowMs: now.getTime() }).valid,
    false
  );

  jsSdk.init({ endpoint: '/api/ovlink/conversions', consentMode: 'essential' });
  const sdkEss = jsSdk.buildPayload({ short: 'abc', goal: 'lead', actorId: 'user-9' });
  assert.equal(sdkEss.actor, undefined);
  jsSdk.setConsent('declined');
  const declinedRes = await jsSdk.trackLead({ short: 'abc', eventId: 'sdk_declined_1' });
  assert.equal(declinedRes.skipped, true);
  assert.equal(declinedRes.reason, 'consent_declined');
});

test('P21 PG + HTTP integration: auth/scope/signature enforcement, lead & purchase audit, replay/conflict & consent', {
  skip: !safeDb && 'Requires a dedicated Ovlink QA PostgreSQL database',
  timeout: 30000,
}, async () => {
  const { app } = require('../server');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const client = new Client({ connectionString: url });
  await client.connect();

  const code = crypto.randomBytes(5).toString('hex');
  const nowIso = new Date().toISOString();
  const futurePro = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
  let ownerId, outsiderId, campaignId, ownerLinkId, outsiderLinkId;
  const writeKey = buildApiKeyValue();
  const readOnlyKey = buildApiKeyValue();

  try {
    const u1 = await client.query(
      "INSERT INTO users(email, email_verified, plan_tier, plan_status, pro_expires_at, created_at) VALUES($1, 1, 'pro', 'active', $2, $3) RETURNING id",
      [`p21-owner-${code}@example.test`, futurePro, nowIso]
    );
    ownerId = u1.rows[0].id;

    const u2 = await client.query(
      "INSERT INTO users(email, email_verified, plan_tier, plan_status, pro_expires_at, created_at) VALUES($1, 1, 'pro', 'active', $2, $3) RETURNING id",
      [`p21-outsider-${code}@example.test`, futurePro, nowIso]
    );
    outsiderId = u2.rows[0].id;

    const c = await client.query(
      'INSERT INTO campaigns(user_id, name, slug, created_at) VALUES($1, $2, $3, $4) RETURNING id',
      [ownerId, 'P21 Conversion QA', `p21-${code}`, nowIso]
    );
    campaignId = c.rows[0].id;

    const l1 = await client.query(
      'INSERT INTO urls(user_id, short, original, created_at, campaign_id) VALUES($1, $2, $3, $4, $5) RETURNING id',
      [ownerId, `p21own${code}`, 'https://example.test/checkout', nowIso, campaignId]
    );
    ownerLinkId = l1.rows[0].id;

    const l2 = await client.query(
      'INSERT INTO urls(user_id, short, original, created_at) VALUES($1, $2, $3, $4) RETURNING id',
      [outsiderId, `p21out${code}`, 'https://example.test/other', nowIso]
    );
    outsiderLinkId = l2.rows[0].id;

    await client.query(
      'INSERT INTO api_keys(user_id, name, scopes, key_hash, hash_version, key_prefix, last4, created_at) VALUES($1,$2,$3,$4,2,$5,$6,$7)',
      [ownerId, 'P21 Write Key', 'account:read,shorten:write', hashApiKeyValue(writeKey), getApiKeyPrefix(writeKey), getApiKeyLast4(writeKey), nowIso]
    );
    await client.query(
      'INSERT INTO api_keys(user_id, name, scopes, key_hash, hash_version, key_prefix, last4, created_at) VALUES($1,$2,$3,$4,2,$5,$6,$7)',
      [ownerId, 'P21 ReadOnly Key', 'account:read', hashApiKeyValue(readOnlyKey), getApiKeyPrefix(readOnlyKey), getApiKeyLast4(readOnlyKey), nowIso]
    );

    // 1) Unauthorized (no key) -> 401
    const rUnauth = await jsonFetch(baseUrl, '/api/pro/v1/conversions', {
      method: 'POST',
      body: { event_id: `unauth_${code}`, short: `p21own${code}`, goal: 'lead' },
    });
    assert.equal(rUnauth.status, 401);

    // 2) Wrong scope (read-only key) -> 403
    const rScope = await jsonFetch(baseUrl, '/api/pro/v1/conversions', {
      method: 'POST',
      headers: { 'x-api-key': readOnlyKey },
      body: { event_id: `scope_${code}`, short: `p21own${code}`, goal: 'lead' },
    });
    assert.equal(rScope.status, 403);

    // 3) Outsider link -> 404 (zero unauthorized writes)
    const rOutsider = await jsonFetch(baseUrl, '/api/pro/v1/conversions', {
      method: 'POST',
      headers: { 'x-api-key': writeKey },
      body: { event_id: `out_${code}`, short: `p21out${code}`, goal: 'lead' },
    });
    assert.equal(rOutsider.status, 404);

    // 4) Invalid HMAC signature -> 401
    const rBadSig = await jsonFetch(baseUrl, '/api/pro/v1/conversions', {
      method: 'POST',
      headers: {
        'x-api-key': writeKey,
        'x-ovlink-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-ovlink-signature': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: { event_id: `badsig_${code}`, short: `p21own${code}`, goal: 'lead' },
    });
    assert.equal(rBadSig.status, 401);

    // 5) Signed demo `lead` (form submit) -> 201 Created
    const leadPayload = {
      event_id: `lead_${code}`,
      short: `p21own${code}`,
      goal: 'lead',
      source: 'js_sdk',
      consent: 'analytics',
      actor: { external_id: 'lead-user-1' },
    };
    const leadRaw = JSON.stringify(leadPayload);
    const ts1 = String(Math.floor(Date.now() / 1000));
    const sig1 = convLib.computeConversionSignature({ secret: writeKey, timestampSec: ts1, rawBody: leadRaw });
    const rLead = await jsonFetch(baseUrl, '/api/pro/v1/conversions', {
      method: 'POST',
      headers: {
        'x-api-key': writeKey,
        'x-ovlink-timestamp': ts1,
        'x-ovlink-signature': sig1,
      },
      body: leadRaw,
    });
    assert.equal(rLead.status, 201);
    assert.equal(rLead.body.recorded, true);
    assert.equal(rLead.body.event.goal, 'lead');
    assert.equal(rLead.body.event.signature_verified, true);
    assert.equal(rLead.body.event.has_actor_hash, true);

    // 6) Exact replay of `lead` -> 200 OK, replayed=true, no duplicate row
    const rReplay = await jsonFetch(baseUrl, '/api/pro/v1/conversions', {
      method: 'POST',
      headers: { 'x-api-key': writeKey },
      body: leadPayload,
    });
    assert.equal(rReplay.status, 200);
    assert.equal(rReplay.body.replayed, true);
    assert.equal(rReplay.body.recorded, false);

    // 7) Conflicting replay (same event_id, different goal) -> 409 Conflict
    const rConflict = await jsonFetch(baseUrl, '/api/pro/v1/conversions', {
      method: 'POST',
      headers: { 'x-api-key': writeKey },
      body: { ...leadPayload, goal: 'purchase', value: 120, currency: 'AZN' },
    });
    assert.equal(rConflict.status, 409);

    // 8) Demo `purchase` (e-commerce checkout with value & currency) -> 201 Created
    const rPurchase = await jsonFetch(baseUrl, '/api/pro/v1/conversions', {
      method: 'POST',
      headers: { 'x-api-key': writeKey },
      body: {
        event_id: `purch_${code}`,
        short: `p21own${code}`,
        campaign_id: campaignId,
        goal: 'purchase',
        source: 'checkout',
        consent: 'analytics',
        value: 249.9,
        currency: 'AZN',
        actor: { external_id: 'buyer-42' },
      },
    });
    assert.equal(rPurchase.status, 201);
    assert.equal(rPurchase.body.event.goal, 'purchase');
    assert.equal(rPurchase.body.event.value, 249.9);
    assert.equal(rPurchase.body.event.currency, 'AZN');

    // 9) Consent declined -> 202 Accepted, recorded=false, 0 DB rows written
    const rDeclined = await jsonFetch(baseUrl, '/api/pro/v1/conversions', {
      method: 'POST',
      headers: { 'x-api-key': writeKey },
      body: {
        event_id: `decl_${code}`,
        short: `p21own${code}`,
        goal: 'lead',
        consent: 'declined',
      },
    });
    assert.equal(rDeclined.status, 202);
    assert.equal(rDeclined.body.recorded, false);
    assert.equal(rDeclined.body.reason, 'consent_declined');

    // 10) List conversions & verify audit log has both `lead` and `purchase`
    const rList = await jsonFetch(baseUrl, `/api/pro/v1/conversions?short=p21own${code}`, {
      headers: { 'x-api-key': readOnlyKey },
    });
    assert.equal(rList.status, 200);
    assert.equal(rList.body.events.length, 2);

    const auditRows = await client.query(
      "SELECT action, metadata_json FROM analytics_audit_log WHERE user_id = $1 AND action = 'conversion.event.ingested'",
      [ownerId]
    );
    assert.equal(auditRows.rows.length, 2);
    const auditedGoals = auditRows.rows.map((r) => JSON.parse(r.metadata_json).goal).sort();
    assert.deepEqual(auditedGoals, ['lead', 'purchase']);

    // 11) OpenAPI spec includes /api/pro/v1/conversions
    const rOpenApi = await jsonFetch(baseUrl, '/api/pro/v1/openapi.json');
    assert.equal(rOpenApi.status, 200);
    assert.ok(rOpenApi.body.paths['/api/pro/v1/conversions']);
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (ownerId) {
      await client.query('DELETE FROM conversion_events WHERE user_id=$1', [ownerId]).catch(() => {});
      await client.query('DELETE FROM analytics_audit_log WHERE user_id=$1', [ownerId]).catch(() => {});
      await client.query('DELETE FROM api_keys WHERE user_id=$1', [ownerId]).catch(() => {});
    }
    for (const lid of [ownerLinkId, outsiderLinkId].filter(Boolean)) {
      await client.query('DELETE FROM link_conversions WHERE url_id=$1', [lid]).catch(() => {});
      await client.query('DELETE FROM link_stats_daily WHERE url_id=$1', [lid]).catch(() => {});
      await client.query('DELETE FROM urls WHERE id=$1', [lid]).catch(() => {});
    }
    if (campaignId) await client.query('DELETE FROM campaigns WHERE id=$1', [campaignId]).catch(() => {});
    for (const uid of [ownerId, outsiderId].filter(Boolean)) {
      await client.query('DELETE FROM users WHERE id=$1', [uid]).catch(() => {});
    }
    await client.end();
    await require('../src/db/pool').pool.end().catch(() => {});
  }
});
