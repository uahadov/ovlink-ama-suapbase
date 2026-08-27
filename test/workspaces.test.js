const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');

const createdTestUserIds = [];
const createdTestWorkspaceIds = [];
const createdTestShorts = [];
const TEST_PASSWORD = 'WsTest!2026x';

const OKTA_METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="http://www.okta.com/ws-test-entity">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo><ds:X509Data><ds:X509Certificate>MIIDvzCCAqegAwIBAgIUQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA</ds:X509Certificate></ds:X509Data></ds:KeyInfo>
    </md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://sso.ws-test-company.com/app/sso/saml"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

let hasPostgres = false;

test.before(async () => {
  try {
    await helpers.dbGetAsync('SELECT 1');
    hasPostgres = true;
  } catch (err) {
    hasPostgres = false;
  }
  const migrationDrainDeadline = Date.now() + 20000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!hasPostgres) return;
  // The workspaces tables may be created by a parallel test process booting the
  // same server; poll briefly instead of assuming this process got there first.
  const tableDeadline = Date.now() + 20000;
  while (Date.now() < tableDeadline) {
    const rows = await helpers.dbAllAsync(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('workspaces', 'workspace_members', 'workspace_invitations', 'sso_connections')"
    );
    if (rows.length === 4) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
});

test.after(async () => {
  for (const short of createdTestShorts) {
    try { await helpers.dbRunAsync('DELETE FROM urls WHERE short = ?', [short]); } catch {}
  }
  for (const workspaceId of createdTestWorkspaceIds) {
    try {
      await helpers.dbRunAsync('UPDATE urls SET workspace_id = NULL WHERE workspace_id = ?', [workspaceId]);
      await helpers.dbRunAsync('DELETE FROM sso_connections WHERE workspace_id = ?', [workspaceId]);
      await helpers.dbRunAsync('DELETE FROM workspace_invitations WHERE workspace_id = ?', [workspaceId]);
      await helpers.dbRunAsync('DELETE FROM workspace_members WHERE workspace_id = ?', [workspaceId]);
      await helpers.dbRunAsync('DELETE FROM workspaces WHERE id = ?', [workspaceId]);
    } catch {}
  }
  for (const userId of createdTestUserIds) {
    try {
      await helpers.dbRunAsync('DELETE FROM workspace_members WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM notifications WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [userId]);
    } catch {}
  }
  const migrationDrainDeadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    await helpers.closeDbPool();
  } catch {}
});

async function seedUser({ plan = 'free' } = {}) {
  const email = `ws-test-${plan}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const proExpires = plan === 'pro' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null;
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, pro_expires_at, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?) RETURNING id',
    [encryptAES256GCM(email), blindIndex(email), passwordHash, plan, 'active', proExpires, new Date().toISOString()]
  );
  const row = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdTestUserIds.push(row.id);
  return { id: row.id, email };
}

test('workspaces: Pro gating, invitations, scoped links and SAML SSO config', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }
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
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('connect.sid='));
    const { csrfToken } = await res.json();
    return { cookie: sidCookie, csrfToken };
  }

  async function loginSession(email) {
    const { cookie, csrfToken } = await getCsrfSession();
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'cookie': cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: TEST_PASSWORD, lang: 'en' })
    });
    assert.equal(res.status, 200, `login must succeed for ${email}`);
    const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
    const sidCookie = setCookies
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('connect.sid='));
    const finalCookie = sidCookie || cookie;
    // After session regeneration the CSRF token is bound to the new session id.
    const csrfRes = await fetch(`${baseUrl}/api/csrf`, { headers: { 'cookie': finalCookie } });
    const { csrfToken: freshToken } = await csrfRes.json();
    return { cookie: finalCookie, csrfToken: freshToken };
  }

  const api = (session) => ({
    async json(method, path, body) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'cookie': session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
      });
      return { res, data: await res.json().catch(() => ({})) };
    }
  });

  const freeUser = await seedUser({ plan: 'free' });
  const proUser = await seedUser({ plan: 'pro' });
  const memberUser = await seedUser({ plan: 'free' });

  const freeSession = await loginSession(freeUser.email);
  const proSession = await loginSession(proUser.email);
  const memberSession = await loginSession(memberUser.email);

  await t.test('free users cannot create workspaces (Pro gate)', async () => {
    const { res } = await api(freeSession).json('POST', '/api/workspaces', { name: 'Free Co' });
    assert.equal(res.status, 403);
  });

  let workspaceId = 0;
  await t.test('pro user creates a workspace and becomes owner', async () => {
    const { res, data } = await api(proSession).json('POST', '/api/workspaces', { name: 'Ws Test Company' });
    assert.equal(res.status, 200);
    assert.ok(data.id > 0);
    workspaceId = data.id;
    createdTestWorkspaceIds.push(workspaceId);
    const ownerMember = await helpers.dbGetAsync('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [workspaceId, proUser.id]);
    assert.equal(ownerMember.role, 'owner');
  });

  await t.test('duplicate workspace creation is rejected', async () => {
    const { res } = await api(proSession).json('POST', '/api/workspaces', { name: 'Second Co' });
    assert.equal(res.status, 409);
  });

  let inviteToken = '';
  await t.test('owner invites a teammate by email', async () => {
    const { res, data } = await api(proSession).json('POST', `/api/workspaces/${workspaceId}/invitations`, { email: memberUser.email, role: 'member' });
    assert.equal(res.status, 200);
    assert.ok(data.invite_url.includes('/workspaces/accept?token='));
    inviteToken = new URL(data.invite_url).searchParams.get('token');
    assert.ok(inviteToken.length > 20);
  });

  await t.test('outsider cannot create workspace-scoped links', async () => {
    const { res } = await api(freeSession).json('POST', '/api/shorten', { original: 'https://example.com/outsider', workspaceId: workspaceId });
    assert.equal(res.status, 403);
  });

  await t.test('invitation acceptance flow enforces email match and membership', async () => {
    // Wrong account: the free outsider tries to accept the member's token.
    const wrongRes = await fetch(`${baseUrl}/workspaces/accept?token=${encodeURIComponent(inviteToken)}`, {
      headers: { 'cookie': freeSession.cookie },
      redirect: 'manual'
    });
    assert.equal(wrongRes.status, 200);
    const wrongHtml = await wrongRes.text();
    assert.match(wrongHtml, /wrong_email|ws_accept_wrong_email/);

    // Correct account accepts through the POST form.
    const acceptRes = await fetch(`${baseUrl}/workspaces/accept`, {
      method: 'POST',
      headers: { 'cookie': memberSession.cookie, 'x-csrf-token': memberSession.csrfToken, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: inviteToken, _csrf: memberSession.csrfToken }).toString(),
      redirect: 'manual'
    });
    assert.equal(acceptRes.status, 302);
    assert.ok(acceptRes.headers.get('location').includes(`/dashboard?ws=${workspaceId}`));

    const membership = await helpers.dbGetAsync('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [workspaceId, memberUser.id]);
    assert.equal(membership.role, 'member');
  });

  let memberShort = '';
  await t.test('member creates a workspace-scoped link through the same domain', async () => {
    const { res, data } = await api(memberSession).json('POST', '/api/shorten', { original: 'https://example.com/team-campaign', workspaceId: workspaceId });
    assert.equal(res.status, 200);
    assert.ok(data.short);
    memberShort = data.short;
    createdTestShorts.push(memberShort);
    const row = await helpers.dbGetAsync('SELECT workspace_id, user_id FROM urls WHERE short = ?', [memberShort]);
    assert.equal(row.workspace_id, workspaceId);
    assert.equal(row.user_id, memberUser.id);
  });

  await t.test('dashboard is scoped by workspace', async () => {
    const wsRes = await fetch(`${baseUrl}/dashboard?ws=${workspaceId}`, { headers: { 'cookie': memberSession.cookie }, redirect: 'manual' });
    assert.equal(wsRes.status, 200);
    const wsHtml = await wsRes.text();
    assert.ok(wsHtml.includes(memberShort), 'workspace dashboard must list the shared link');

    const personalRes = await fetch(`${baseUrl}/dashboard`, { headers: { 'cookie': memberSession.cookie }, redirect: 'manual' });
    assert.equal(personalRes.status, 200);
    const personalHtml = await personalRes.text();
    assert.ok(!personalHtml.includes(memberShort), 'personal dashboard must not list workspace links');
  });

  await t.test('member can update and delete shared workspace links', async () => {
    const { res } = await api(memberSession).json('POST', '/api/user/link/update', { short: memberShort, original: 'https://example.com/team-campaign-v2' });
    assert.equal(res.status, 200);
    const row = await helpers.dbGetAsync('SELECT original FROM urls WHERE short = ?', [memberShort]);
    assert.equal(row.original, 'https://example.com/team-campaign-v2');

    const delRes = await fetch(`${baseUrl}/api/user/delete`, {
      method: 'POST',
      headers: { 'cookie': memberSession.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ short: memberShort, _csrf: memberSession.csrfToken }).toString(),
      redirect: 'manual'
    });
    assert.equal(delRes.status, 302);
    const gone = await helpers.dbGetAsync('SELECT id FROM urls WHERE short = ?', [memberShort]);
    assert.equal(gone, undefined);
    const idx = createdTestShorts.indexOf(memberShort);
    if (idx >= 0) createdTestShorts.splice(idx, 1);
  });

  await t.test('SSO configuration: invalid XML rejected, valid metadata saved', async () => {
    const bad = await api(proSession).json('PUT', `/api/workspaces/${workspaceId}/sso`, { metadataXml: 'not xml' });
    assert.equal(bad.res.status, 400);

    const good = await api(proSession).json('PUT', `/api/workspaces/${workspaceId}/sso`, { metadataXml: OKTA_METADATA });
    assert.equal(good.res.status, 200);
    assert.equal(good.data.idp_entity_id, 'http://www.okta.com/ws-test-entity');

    const ssoRow = await helpers.dbGetAsync('SELECT idp_sso_url, enabled FROM sso_connections WHERE workspace_id = ?', [workspaceId]);
    assert.equal(ssoRow.idp_sso_url, 'https://sso.ws-test-company.com/app/sso/saml');
    assert.equal(ssoRow.enabled, 1);
  });

  await t.test('SP metadata endpoint serves XML; ACS rejects garbage without a session leak', async () => {
    const metaRes = await fetch(`${baseUrl}/sso/${workspaceId}/metadata`, { redirect: 'manual' });
    assert.equal(metaRes.status, 200);
    const metaXml = await metaRes.text();
    assert.match(metaXml, /EntityDescriptor/);
    assert.match(metaXml, /AssertionConsumerService/);
    assert.match(metaXml, new RegExp(`/sso/${workspaceId}/acs`));

    const acsRes = await fetch(`${baseUrl}/sso/${workspaceId}/acs`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'SAMLResponse=garbage',
      redirect: 'manual'
    });
    assert.equal(acsRes.status, 302);
    assert.ok(acsRes.headers.get('location').includes('/login?sso=error'));
  });

  await t.test('free member list hidden from non-members; outsider gets 404/403', async () => {
    const { res } = await api(freeSession).json('GET', `/api/workspaces/${workspaceId}`);
    assert.equal(res.status, 403);
  });

  await t.test('deleting the workspace nulls link scope and cascades members', async () => {
    // Re-create a link so we can assert the workspace_id reset.
    const { data } = await api(memberSession).json('POST', '/api/shorten', { original: 'https://example.com/cleanup-probe', workspaceId: workspaceId });
    createdTestShorts.push(data.short);

    const { res } = await api(proSession).json('DELETE', `/api/workspaces/${workspaceId}`);
    assert.equal(res.status, 200);

    const row = await helpers.dbGetAsync('SELECT workspace_id FROM urls WHERE short = ?', [data.short]);
    assert.equal(row.workspace_id, null);
    const members = await helpers.dbGetAsync('SELECT COUNT(*)::int AS c FROM workspace_members WHERE workspace_id = ?', [workspaceId]);
    assert.equal(members.c, 0);
    const sso = await helpers.dbGetAsync('SELECT COUNT(*)::int AS c FROM sso_connections WHERE workspace_id = ?', [workspaceId]);
    assert.equal(sso.c, 0);
  });

  await new Promise((resolve) => server.close(resolve));
});
