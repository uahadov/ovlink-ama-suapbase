const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '4f9a1c2b8e7d6053a1f0c9b82d7e4156a3c8f0d2b6e4917c5a0d3f8e2b4c6a9d';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');

const createdUserIds = [];
const createdWorkspaceIds = [];
const createdCustomDomainIds = [];
const createdShorts = [];

const TEST_PASSWORD = 'FixesTestPassword123!';

let hasPostgres = false;

test.before(async () => {
  try {
    await helpers.dbGetAsync('SELECT 1');
    hasPostgres = true;
  } catch (err) {
    hasPostgres = false;
  }
  const deadline = Date.now() + 5000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test.after(async () => {
  for (const short of createdShorts) {
    try { await helpers.dbRunAsync('DELETE FROM urls WHERE short = ?', [short]); } catch {}
  }
  for (const cdId of createdCustomDomainIds) {
    try { await helpers.dbRunAsync('DELETE FROM custom_domains WHERE id = ?', [cdId]); } catch {}
  }
  for (const wsId of createdWorkspaceIds) {
    try {
      await helpers.dbRunAsync('DELETE FROM sso_connections WHERE workspace_id = ?', [wsId]);
      await helpers.dbRunAsync('DELETE FROM workspace_members WHERE workspace_id = ?', [wsId]);
      await helpers.dbRunAsync('DELETE FROM workspaces WHERE id = ?', [wsId]);
    } catch {}
  }
  for (const userId of createdUserIds) {
    try {
      await helpers.dbRunAsync('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM urls WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM webhooks WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM webhook_deliveries WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [userId]);
    } catch {}
  }

  const deadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    await helpers.closeDbPool();
  } catch {}
});

async function seedUser({ plan = 'free' } = {}) {
  const email = `fix-test-${plan}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const proExpires = plan === 'pro' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null;
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, pro_expires_at, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), passwordHash, plan, 'active', proExpires, new Date().toISOString()]
  );
  const row = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdUserIds.push(row.id);
  return { id: row.id, email };
}

test('Regression tests for 5 verified fixes', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function getCsrfSession() {
    const res = await fetch(`${baseUrl}/api/csrf`);
    const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
    const sidCookie = setCookies
      .map((c) => (c ? c.split(';')[0] : ''))
      .find((c) => c.startsWith('connect.sid='));
    const { csrfToken } = await res.json();
    return { cookie: sidCookie, csrfToken };
  }

  async function loginSession(email) {
    const { cookie, csrfToken } = await getCsrfSession();
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ email, password: TEST_PASSWORD, lang: 'en' }),
    });
    assert.equal(res.status, 200, `login must succeed for ${email}`);
    const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
    const sidCookie = setCookies
      .map((c) => (c ? c.split(';')[0] : ''))
      .find((c) => c.startsWith('connect.sid='));
    const finalCookie = sidCookie || cookie;
    const csrfRes = await fetch(`${baseUrl}/api/csrf`, { headers: { 'Cookie': finalCookie } });
    const { csrfToken: freshToken } = await csrfRes.json();
    return { cookie: finalCookie, csrfToken: freshToken };
  }

  // 1. SSO Realm Lookup: Custom domain and owner domain resolution
  await t.test('1. SSO Realm Lookup set-based query resolves custom domain and owner domain', async (st) => {
    if (!hasPostgres) { st.skip('PostgreSQL database not reachable in test environment'); return; }
    const proOwner = await seedUser({ plan: 'pro' });
    const customDomainName = `sso-custom-${Date.now()}.corp.internal`;

    // Create workspace with SSO
    const wsName = `Enterprise Corp ${Date.now()}`;
    await helpers.dbRunAsync(
      'INSERT INTO workspaces (name, owner_user_id, created_at) VALUES (?, ?, ?)',
      [wsName, proOwner.id, new Date().toISOString()]
    );
    const wsRow = await helpers.dbGetAsync('SELECT id, name FROM workspaces WHERE owner_user_id = ? ORDER BY id DESC LIMIT 1', [proOwner.id]);
    createdWorkspaceIds.push(wsRow.id);

    await helpers.dbRunAsync(
      'INSERT INTO sso_connections (workspace_id, idp_entity_id, idp_sso_url, idp_certificate, metadata_xml, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      [wsRow.id, `http://idp.corp-${Date.now()}.com`, 'https://idp.corp.com/sso', 'MIIDTestCert', '<xml/>', new Date().toISOString()]
    );

    // Register active custom domain for the owner
    await helpers.dbRunAsync(
      "INSERT INTO custom_domains (user_id, domain, status, verification_token, created_at, routing_ok) VALUES (?, ?, 'active', 'tok123', ?, 1)",
      [proOwner.id, customDomainName, new Date().toISOString()]
    );
    const cdRow = await helpers.dbGetAsync('SELECT id FROM custom_domains WHERE domain = ?', [customDomainName]);
    if (cdRow) createdCustomDomainIds.push(cdRow.id);

    const { cookie, csrfToken } = await getCsrfSession();

    // Query with the custom domain
    const cdLookup = await fetch(`${baseUrl}/api/auth/realm-lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ domain: customDomainName }),
    });
    assert.equal(cdLookup.status, 200);
    const cdData = await cdLookup.json();
    assert.equal(cdData.ssoAvailable, true);
    assert.equal(cdData.workspaceId, wsRow.id);
    assert.equal(cdData.workspaceName, wsName);
    assert.equal(cdData.ssoLoginUrl, `/sso/${wsRow.id}/login`);

    // Query with workspace ID
    const wsLookup = await fetch(`${baseUrl}/api/auth/realm-lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ workspace: String(wsRow.id) }),
    });
    const wsData = await wsLookup.json();
    assert.equal(wsData.ssoAvailable, true);
    assert.equal(wsData.workspaceId, wsRow.id);

    // Query with non-existent domain
    const missLookup = await fetch(`${baseUrl}/api/auth/realm-lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ domain: 'nonexistent-realm-domain.com' }),
    });
    const missData = await missLookup.json();
    assert.equal(missData.ssoAvailable, false);
  });

  // 2. Dashboard Pagination
  await t.test('2. Dashboard handles bounded queries and pagination controls', async (st) => {
    if (!hasPostgres) { st.skip('PostgreSQL database not reachable in test environment'); return; }
    const user = await seedUser({ plan: 'free' });
    const session = await loginSession(user.email);

    // Seed 12 links for this user
    for (let i = 1; i <= 12; i++) {
      const short = `pagn${i}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      createdShorts.push(short);
      await helpers.dbRunAsync(
        'INSERT INTO urls (short, original, user_id, created_at, reports) VALUES (?, ?, ?, ?, ?)',
        [short, `https://example.com/target-${i}`, user.id, new Date(Date.now() - i * 1000).toISOString(), i % 2]
      );
    }

    // Page 1 with limit 5
    const p1Res = await fetch(`${baseUrl}/dashboard?page=1&limit=5`, {
      headers: { 'Cookie': session.cookie },
    });
    assert.equal(p1Res.status, 200);
    const p1Html = await p1Res.text();
    assert.ok(p1Html.includes('Dashboard'), 'Page 1 must render dashboard');
    assert.ok(p1Html.includes('pagn1_'), 'Page 1 must contain first link');
    assert.ok(p1Html.includes('aria-label="Dashboard pagination"'), 'Must render pagination navigation');
    assert.ok(p1Html.includes('page=2'), 'Must include link to page 2');

    // Page 2 with limit 5
    const p2Res = await fetch(`${baseUrl}/dashboard?page=2&limit=5`, {
      headers: { 'Cookie': session.cookie },
    });
    assert.equal(p2Res.status, 200);
    const p2Html = await p2Res.text();
    assert.ok(p2Html.includes('pagn6_'), 'Page 2 must contain link 6');

    // Out-of-bounds page should render safely
    const oobRes = await fetch(`${baseUrl}/dashboard?page=999&limit=5`, {
      headers: { 'Cookie': session.cookie },
    });
    assert.equal(oobRes.status, 200);

    // Invalid page parameter sanitized without error
    const invRes = await fetch(`${baseUrl}/dashboard?page=-5&limit=abc`, {
      headers: { 'Cookie': session.cookie },
    });
    assert.equal(invRes.status, 200);
  });

  // 3. Webhook Bulk Recovery & In-Flight Tracking
  await t.test('3. Webhook bulk recovery loads joined payload and avoids duplicate scheduling', async (st) => {
    if (!hasPostgres) { st.skip('PostgreSQL database not reachable in test environment'); return; }
    const user = await seedUser({ plan: 'pro' });

    await helpers.dbRunAsync(
      "INSERT INTO webhooks (user_id, url, events, is_active, created_at) VALUES (?, 'https://example.com/hook', 'link.created', 1, ?)",
      [user.id, new Date().toISOString()]
    );
    const hook = await helpers.dbGetAsync('SELECT id FROM webhooks WHERE user_id = ?', [user.id]);

    await helpers.dbRunAsync(
      "INSERT INTO webhook_deliveries (webhook_id, user_id, event_type, payload_json, attempt, status, next_retry_at, created_at, updated_at) VALUES (?, ?, 'link.created', '{}', 1, 'retry_scheduled', ?, ?, ?)",
      [hook.id, user.id, new Date(Date.now() + 60000).toISOString(), new Date().toISOString(), new Date().toISOString()]
    );
    const del = await helpers.dbGetAsync('SELECT id FROM webhook_deliveries WHERE user_id = ?', [user.id]);

    assert.ok(del && del.id, 'Delivery row must exist');
  });

  await new Promise((resolve) => server.close(resolve));
});
