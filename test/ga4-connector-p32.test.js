'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const ga4Connector = require('../src/lib/ga4-connector');

test('P32 unit: property validation, source-by-source reconciliation & honest scope disclaimer', () => {
  assert.equal(ga4Connector.normalizePropertyId('123456789'), 'properties/123456789');
  assert.equal(ga4Connector.normalizePropertyId('properties/987654321'), 'properties/987654321');
  assert.equal(ga4Connector.normalizePropertyId('bad-prop'), null);

  const rec = ga4Connector.reconcileOvlinkVsGa4({
    ovlinkSources: [{ name: 'instagram', count: 100 }, { name: 'google', count: 50 }],
    ga4Channels: [{ source: 'instagram', sessions: 80 }, { source: 'google', sessions: 55 }],
    lastHealthySyncedAt: '2026-11-20T00:00:00.000Z',
    isStale: true,
  });
  assert.equal(rec.totals.ovlink_clicks, 150);
  assert.equal(rec.totals.ga4_sessions, 135);
  assert.equal(rec.freshness.is_stale, true);
  assert.match(rec.scope_disclaimer, /Google Ads and Meta Ads/i);
  assert.equal(rec.by_source.length, 2);
});

const dbUrl = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(dbUrl.split('?')[0]);

test('P32 integration: GA4 sandbox sync, quota 429 stale fallback, reconciliation & disconnect wipe', { skip: !safeDb && 'Requires isolated QA DB', timeout: 30000 }, async () => {
  const express = require('express');
  const { dbRunAsync } = require('../src/db/helpers');
  const campaignsRouter = require('../src/routes/api/campaigns');

  const suffix = crypto.randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();
  const uRes = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, created_at) VALUES (?, 1, 'pro', 'active', ?)",
    [`p32-${suffix}@example.com`, nowIso]
  );
  const userId = Number(uRes.lastID);
  const cRes = await dbRunAsync(
    "INSERT INTO campaigns (user_id, name, slug, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    [userId, `P32 Campaign ${suffix}`, `p32-${suffix}`, nowIso]
  );
  const campaignId = Number(cRes.lastID);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId }; next(); });
  app.use(campaignsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const jsonHeaders = { 'content-type': 'application/json' };

  try {
    // 1. Connect read-only GA4 property
    const connRes = await fetch(`${baseUrl}/api/integrations/ga4/connect`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        campaign_id: campaignId,
        property_id: 'properties/445566778',
        oauth_token: 'ya29.sandbox_token_value',
        consent_granted: true,
      }),
    });
    assert.equal(connRes.status, 201);
    const { connection } = await connRes.json();

    // 2. Sync sandbox GA4 data -> 200 fresh
    const syncRes = await fetch(`${baseUrl}/api/integrations/ga4/${connection.id}/sync`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sandbox_rows: [{ source: 'instagram', sessions: 42 }] }),
    });
    assert.equal(syncRes.status, 200);
    const syncBody = await syncRes.json();
    assert.equal(syncBody.stale, false);

    // 3. Quota 429 -> returns last healthy snapshot explicitly marked stale (never fake fresh)
    const q429Res = await fetch(`${baseUrl}/api/integrations/ga4/${connection.id}/sync`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ simulate_quota_429: true }),
    });
    assert.equal(q429Res.status, 429);
    const q429Body = await q429Res.json();
    assert.equal(q429Body.stale, true);
    assert.equal(q429Body.freshness_status, 'stale_quota_429');
    assert.equal(q429Body.snapshot.channels[0].sessions, 42);

    // 4. Reconcile Ovlink vs GA4
    const recRes = await fetch(`${baseUrl}/api/integrations/ga4/${connection.id}/reconcile`);
    assert.equal(recRes.status, 200);
    const recBody = await recRes.json();
    assert.equal(recBody.freshness.is_stale, true);

    // 5. Disconnect wipes token & snapshot -> subsequent sync returns 403 (zero leakage)
    const delRes = await fetch(`${baseUrl}/api/integrations/ga4/${connection.id}`, { method: 'DELETE' });
    assert.equal(delRes.status, 200);
    const delBody = await delRes.json();
    assert.equal(delBody.data_deleted, true);

    const afterDelSync = await fetch(`${baseUrl}/api/integrations/ga4/${connection.id}/sync`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sandbox_rows: [] }),
    });
    assert.equal(afterDelSync.status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
