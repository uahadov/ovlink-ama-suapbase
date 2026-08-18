const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');
const {
  isPublicConsumerEmailDomain,
  createSignedRelayState,
  verifySignedRelayState,
  sanitizeReturnUrl,
  extractAssertionId
} = require('../utils/sso');

let server;
let baseUrl;
const createdUserIds = [];
const createdWorkspaceIds = [];

test.before(async () => {
  const migrationDrainDeadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  for (const wsId of createdWorkspaceIds) {
    try {
      await helpers.dbRunAsync('DELETE FROM sso_replay_cache WHERE workspace_id = ?', [wsId]);
      await helpers.dbRunAsync('DELETE FROM sso_connections WHERE workspace_id = ?', [wsId]);
      await helpers.dbRunAsync('DELETE FROM workspace_members WHERE workspace_id = ?', [wsId]);
      await helpers.dbRunAsync('DELETE FROM workspaces WHERE id = ?', [wsId]);
    } catch {}
  }
  for (const userId of createdUserIds) {
    try {
      await helpers.dbRunAsync('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [userId]);
    } catch {}
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  const migrationDrainDeadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    await helpers.closeDbPool();
  } catch {}
});

async function getCsrfSession() {
  const res = await fetch(`${baseUrl}/api/csrf`);
  const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
  const sidCookie = setCookies
    .map((c) => (c ? c.split(';')[0] : ''))
    .find((c) => c.startsWith('connect.sid='));
  const { csrfToken } = await res.json();
  return { cookie: sidCookie, csrfToken };
}

test('Enterprise SSO Hardening: Security mechanisms, RelayState HMAC, replay defense and Realm Discovery', async (t) => {
  const secret = process.env.SESSION_SECRET;

  await t.test('1. RelayState HMAC signing, tampering rejection, and Open Redirect prevention', () => {
    // Valid signing and verification
    const state = createSignedRelayState(42, '/dashboard/links', secret);
    assert.ok(state && state.includes('.'));

    const verified = verifySignedRelayState(state, 42, secret);
    assert.equal(verified.valid, true);
    assert.equal(verified.returnTo, '/dashboard/links');

    // Mismatched workspace ID
    const wrongWs = verifySignedRelayState(state, 999, secret);
    assert.equal(wrongWs.valid, false);
    assert.equal(wrongWs.returnTo, '/dashboard');

    // Tampered payload
    const parts = state.split('.');
    const tampered = 'eyJyZXQiOiIvaGFja2VkIn0.' + parts[1];
    const tamperedCheck = verifySignedRelayState(tampered, 42, secret);
    assert.equal(tamperedCheck.valid, false);

    // Open Redirect sanitization
    assert.equal(sanitizeReturnUrl('https://evil.com/phish'), '/dashboard');
    assert.equal(sanitizeReturnUrl('//evil.com/phish'), '/dashboard');
    assert.equal(sanitizeReturnUrl('/\\evil.com'), '/dashboard');
    assert.equal(sanitizeReturnUrl('/dashboard?tab=sso'), '/dashboard?tab=sso');
  });

  await t.test('2. Consumer email filter and Assertion ID extraction', () => {
    assert.equal(isPublicConsumerEmailDomain('user@gmail.com'), true);
    assert.equal(isPublicConsumerEmailDomain('test@yahoo.com'), true);
    assert.equal(isPublicConsumerEmailDomain('employee@outlook.com'), true);
    assert.equal(isPublicConsumerEmailDomain('someone@proton.me'), true);
    assert.equal(isPublicConsumerEmailDomain('admin@acme-corp.com'), false);
    assert.equal(isPublicConsumerEmailDomain('corp.internal'), false);

    const profileWithInResponseTo = { inResponseTo: '_abc123456789' };
    assert.equal(extractAssertionId(profileWithInResponseTo), '_abc123456789');

    const profileWithAttr = { attributes: { assertionId: 'ASSERTION_99887766' } };
    assert.equal(extractAssertionId(profileWithAttr), 'ASSERTION_99887766');
  });

  await t.test('3. POST /api/auth/realm-lookup correctly discovers active Pro workspace SSO', async () => {
    const { cookie, csrfToken } = await getCsrfSession();

    // 1. Consumer email lookup returns ssoAvailable: false
    const consumerRes = await fetch(`${baseUrl}/api/auth/realm-lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ email: 'john.doe@gmail.com' })
    });
    assert.equal(consumerRes.status, 200);
    const consumerData = await consumerRes.json();
    assert.equal(consumerData.ssoAvailable, false);

    // 2. Seed a Pro owner user and Workspace with SSO enabled
    const uniqueDomain = `acme-corp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.com`;
    const ownerEmail = `sso-owner-${Date.now()}@${uniqueDomain}`;
    const passwordHash = await bcrypt.hash('Secret12345!', 10);
    const proExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const insertUser = await helpers.dbRunAsync(
      'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, pro_expires_at, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?) RETURNING id',
      [encryptAES256GCM(ownerEmail), blindIndex(ownerEmail), passwordHash, 'pro', 'active', proExpires, new Date().toISOString()]
    );
    const userRow = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(ownerEmail)]);
    createdUserIds.push(userRow.id);

    const wsName = `Acme Global ${Date.now()}`;
    const insertWs = await helpers.dbRunAsync(
      'INSERT INTO workspaces (name, owner_user_id, created_at) VALUES (?, ?, ?) RETURNING id',
      [wsName, userRow.id, new Date().toISOString()]
    );
    const wsRow = await helpers.dbGetAsync('SELECT id FROM workspaces WHERE owner_user_id = ?', [userRow.id]);
    createdWorkspaceIds.push(wsRow.id);

    await helpers.dbRunAsync(
      'INSERT INTO sso_connections (workspace_id, idp_entity_id, idp_sso_url, idp_certificate, metadata_xml, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      [wsRow.id, `http://www.okta.com/exk-${Date.now()}`, 'https://acme.okta.com/app/sso/saml', 'MIICTestCertificate', '<xml></xml>', new Date().toISOString()]
    );

    // 3. Lookup corporate email for Acme
    const corpRes = await fetch(`${baseUrl}/api/auth/realm-lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ email: `alice@${uniqueDomain}` })
    });
    assert.equal(corpRes.status, 200);
    const corpData = await corpRes.json();
    assert.equal(corpData.ssoAvailable, true);
    assert.equal(corpData.workspaceId, wsRow.id);
    assert.equal(corpData.workspaceName, wsName);
    assert.equal(corpData.ssoLoginUrl, `/sso/${wsRow.id}/login`);
  });

  await t.test('4. i18n parity: all SSO login keys exist across az, tr, and en in public/lang.js', () => {
    const langMainCode = fs.readFileSync(path.join(__dirname, '../public/lang.js'), 'utf8');
    const ctxMain = {
      window: { addEventListener: () => {} },
      document: { querySelectorAll: () => [], addEventListener: () => {}, cookie: '' },
      localStorage: { getItem: () => null, setItem: () => {} }
    };
    vm.createContext(ctxMain);
    const mainTranslations = vm.runInContext(langMainCode + '\n; translations;', ctxMain);

    const ssoKeys = [
      'login_sso_btn',
      'login_sso_modal_title',
      'login_sso_hint',
      'login_sso_email_ph',
      'login_sso_continue_btn',
      'error_sso_failed',
      'error_sso_replay',
      'error_sso_not_found'
    ];

    ['az', 'tr', 'en'].forEach((lang) => {
      ssoKeys.forEach((k) => {
        assert.ok(
          mainTranslations[lang] && mainTranslations[lang][k],
          `Missing '${k}' in public/lang.js for language '${lang}'`
        );
      });
    });
  });
});
