'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const clientPortal = require('../src/lib/client-portal');

test('P26 unit: token hashing, expiry/revocation enforcement & strict metric filtering', () => {
  const token = clientPortal.generateShareToken();
  assert.match(token, /^ovp_[A-Za-z0-9_-]+$/);
  const hash = clientPortal.hashShareToken(token);
  assert.equal(hash.length, 64);
  assert.notEqual(hash, token);

  assert.equal(clientPortal.evaluateShareAccess(null).status, 404);
  assert.equal(clientPortal.evaluateShareAccess({ revoked_at: '2026-11-19T00:00:00.000Z', expires_at: '2030-01-01T00:00:00.000Z' }).status, 410);
  assert.equal(clientPortal.evaluateShareAccess({ revoked_at: null, expires_at: '2020-01-01T00:00:00.000Z' }).status, 410);
  assert.equal(clientPortal.evaluateShareAccess({ revoked_at: null, expires_at: '2030-01-01T00:00:00.000Z' }).allowed, true);

  const filtered = clientPortal.filterMetricsForPortal(
    {
      campaign: { id: 5, name: 'C1', slug: 'c1', status: 'active' },
      range: { days: 30 },
      clicks: 99,
      uniques: 77,
      conversions: 12,
      conversion_rate: 12.1,
      top_links: [{ short: 's' }],
      generated_at: '2026-11-20T00:00:00.000Z',
    },
    ['clicks', 'conversions']
  );
  assert.equal(filtered.metrics.clicks, 99);
  assert.equal(filtered.metrics.conversions, 12);
  assert.equal(filtered.metrics.uniques, undefined);
  assert.equal(filtered.metrics.top_links, undefined);
});

const dbUrl = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(dbUrl.split('?')[0]);

test('P26 integration: client portal isolation, view audit, anti-IDOR, feedback & revocation', { skip: !safeDb && 'Requires isolated QA DB', timeout: 30000 }, async () => {
  const express = require('express');
  const { dbRunAsync, dbGetAsync } = require('../src/db/helpers');
  const campaignsRouter = require('../src/routes/api/campaigns');

  const suffix = crypto.randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();
  const u1 = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, created_at) VALUES (?, 1, 'pro', 'active', ?)",
    [`p26-a-${suffix}@example.com`, nowIso]
  );
  const u2 = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, created_at) VALUES (?, 1, 'pro', 'active', ?)",
    [`p26-b-${suffix}@example.com`, nowIso]
  );
  const agencyId = Number(u1.lastID);
  const otherId = Number(u2.lastID);

  const c1 = await dbRunAsync(
    "INSERT INTO campaigns (user_id, name, slug, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    [agencyId, `Client A ${suffix}`, `p26-a-${suffix}`, nowIso]
  );
  const c2 = await dbRunAsync(
    "INSERT INTO campaigns (user_id, name, slug, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    [otherId, `Other Tenant ${suffix}`, `p26-b-${suffix}`, nowIso]
  );
  const c1Id = Number(c1.lastID);
  const c2Id = Number(c2.lastID);

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
  const agencyHeaders = { 'x-test-user': String(agencyId), 'content-type': 'application/json' };

  try {
    // 1. Agency creates revocable share for Client A (campaign c1 only)
    const createRes = await fetch(`${baseUrl}/api/client-portal/shares`, {
      method: 'POST',
      headers: agencyHeaders,
      body: JSON.stringify({
        client_name: 'Client Alpha',
        campaign_ids: [c1Id],
        allowed_metrics: ['clicks', 'conversions'],
        expires_in_days: 7,
      }),
    });
    assert.equal(createRes.status, 201);
    const { share_token: token, share } = await createRes.json();
    assert.match(token, /^ovp_/);

    // 2. Client viewer opens portal (unauthenticated via secure token)
    const viewRes = await fetch(`${baseUrl}/api/portal/view/${token}`);
    assert.equal(viewRes.status, 200);
    assert.match(viewRes.headers.get('cache-control') || '', /no-store/);
    const viewBody = await viewRes.json();
    assert.equal(viewBody.role, 'client_viewer');
    assert.equal(viewBody.ui_capabilities.can_edit, false);
    assert.equal(viewBody.ui_capabilities.can_export_raw_pii, false);
    assert.equal(viewBody.campaigns.length, 1);
    assert.equal(viewBody.campaigns[0].campaign.id, c1Id);

    // Verify view-audit recorded
    const auditRow = await dbGetAsync(
      "SELECT id FROM analytics_audit_log WHERE user_id = ? AND action = 'client_portal.viewed' ORDER BY id DESC LIMIT 1",
      [agencyId]
    );
    assert.ok(auditRow && auditRow.id > 0);

    // 3. Attempting to access another client's campaign ID via URL query is blocked (403)
    const idorRes = await fetch(`${baseUrl}/api/portal/view/${token}?campaign_id=${c2Id}`);
    assert.equal(idorRes.status, 403);

    // 4. Client submits lightweight feedback & agency reads it
    const fbRes = await fetch(`${baseUrl}/api/portal/view/${token}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author_name: 'Alpha CMO', section: 'executive_summary', sentiment: 'approved', note: 'Nəticələr aydındır.' }),
    });
    assert.equal(fbRes.status, 201);

    const listFbRes = await fetch(`${baseUrl}/api/client-portal/shares/${share.id}/feedback`, { headers: agencyHeaders });
    assert.equal(listFbRes.status, 200);
    const listFb = await listFbRes.json();
    assert.equal(listFb.feedback.length, 1);
    assert.equal(listFb.feedback[0].sentiment, 'approved');

    // 5. Revoke share -> subsequent view returns 410 Gone
    const revRes = await fetch(`${baseUrl}/api/client-portal/shares/${share.id}/revoke`, {
      method: 'POST',
      headers: agencyHeaders,
    });
    assert.equal(revRes.status, 200);

    const afterRevRes = await fetch(`${baseUrl}/api/portal/view/${token}`);
    assert.equal(afterRevRes.status, 410);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
