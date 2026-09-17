const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '4f9a1c2b8e7d6053a1f0c9b82d7e4156a3c8f0d2b6e4917c5a0d3f8e2b4c6a9d';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');

const createdUserIds = [];
const createdShorts = [];
const TEST_PASSWORD = 'DashboardTestPassword123!';

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
  for (const userId of createdUserIds) {
    try {
      await helpers.dbRunAsync('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM urls WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [userId]);
    } catch {}
  }
  try {
    await helpers.closeDbPool();
  } catch {}
});

async function seedUser({ plan = 'free' } = {}) {
  const email = `dash-test-${plan}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
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

test('Dashboard Redesign & 100% Bootstrap-Free Modal Verification', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
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

  async function loginSession(email) {
    const { cookie, csrfToken } = await getCsrfSession();
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ email, password: TEST_PASSWORD, lang: 'az' }),
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

  // 1. Verify all 6 views have ZERO bootstrap.bundle.min.js and ZERO bootstrap.min.css
  await t.test('1. Views account, workspaces, workspaces-accept, stats, stats-page, dashboard are 100% Bootstrap free', () => {
    const viewFiles = [
      'account.ejs',
      'workspaces.ejs',
      'workspaces-accept.ejs',
      'stats.ejs',
      'stats-page.ejs',
      'dashboard.ejs',
    ];

    for (const file of viewFiles) {
      const filePath = path.join(__dirname, '..', 'views', file);
      assert.ok(fs.existsSync(filePath), `View file ${file} must exist`);
      const content = fs.readFileSync(filePath, 'utf8');
      assert.equal(
        content.includes('bootstrap.bundle.min.js'),
        false,
        `${file} must NOT contain bootstrap.bundle.min.js`
      );
      assert.equal(
        content.includes('bootstrap.min.css'),
        false,
        `${file} must NOT contain bootstrap.min.css`
      );
    }
  });

  // 2. Verify public/script.js has vanilla modal engine and zero bootstrap.Modal dependencies
  await t.test('2. public/script.js contains native zero-dependency modal controller', () => {
    const scriptPath = path.join(__dirname, '..', 'public', 'script.js');
    const content = fs.readFileSync(scriptPath, 'utf8');
    assert.ok(content.includes('function openModalById(modalId)'), 'Must define openModalById');
    assert.ok(content.includes('function closeModalById(modalId)'), 'Must define closeModalById');
    assert.ok(content.includes('data-bs-toggle="modal"'), 'Must support data-bs-toggle=modal click delegation');
    assert.ok(content.includes('data-bs-dismiss="modal"'), 'Must support data-bs-dismiss=modal click delegation');
    assert.ok(content.includes('show.bs.modal'), 'Must dispatch show.bs.modal CustomEvent');
    assert.ok(content.includes('hidden.bs.modal'), 'Must dispatch hidden.bs.modal CustomEvent');
    assert.ok(content.includes('modalFallbackBackdrop'), 'Must handle native dark backdrop');
    assert.equal(content.includes('bootstrap.Modal'), false, 'Must NOT depend on bootstrap.Modal in script.js');
  });

  // 3. Verify public/home.css contains Section 51 Monolith modal and dashboard styles
  await t.test('3. public/home.css contains Monolith modal & dashboard table styling', () => {
    const cssPath = path.join(__dirname, '..', 'public', 'home.css');
    const content = fs.readFileSync(cssPath, 'utf8');
    assert.ok(content.includes('.modal {'), 'Must define .modal class');
    assert.ok(content.includes('.modal-backdrop {'), 'Must define .modal-backdrop class');
    assert.ok(content.includes('.modal-content {'), 'Must define .modal-content class');
    assert.ok(content.includes('.m-dash-bento'), 'Must define .m-dash-bento class');
    assert.ok(content.includes('.m-table'), 'Must define .m-table class');
    assert.ok(content.includes('.m-pagination-bar'), 'Must define .m-pagination-bar class');
  });

  // 4. Authenticated /dashboard route rendering test
  await t.test('4. GET /dashboard renders 200 Monolith EJS template with Bento cards, modals, and 0 Bootstrap', async (st) => {
    if (!hasPostgres) { st.skip('PostgreSQL database not reachable in test environment'); return; }

    const user = await seedUser({ plan: 'pro' });
    const session = await loginSession(user.email);

    // Seed test link
    const short = `dash_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    createdShorts.push(short);
    await helpers.dbRunAsync(
      'INSERT INTO urls (short, original, user_id, created_at, reports, folder_name, tags_json) VALUES (?, ?, ?, ?, 0, ?, ?)',
      [short, 'https://example.com/test-dash-url', user.id, new Date().toISOString(), 'marketing', '["tag1", "tag2"]']
    );

    const res = await fetch(`${baseUrl}/dashboard`, {
      headers: { 'Cookie': session.cookie },
    });

    assert.equal(res.status, 200, 'GET /dashboard must return 200');
    const html = await res.text();

    // Verification of Monolith and 0 Bootstrap compliance
    assert.equal(html.includes('bootstrap.min.css'), false, 'Rendered dashboard must NOT include bootstrap.min.css');
    assert.equal(html.includes('bootstrap.bundle.min.js'), false, 'Rendered dashboard must NOT include bootstrap.bundle.min.js');
    assert.ok(html.includes('id="cursorGlow"'), 'Must include #cursorGlow ambient cursor');
    assert.ok(html.includes('m-dash-bento'), 'Must include Monolith Bento grid');
    assert.ok(html.includes('m-table'), 'Must include Monolith dark table');
    assert.ok(html.includes('dashboardEditLinkModal'), 'Must include edit URL modal');
    assert.ok(html.includes('dashboardMetaModal'), 'Must include folder/tags metadata modal');
    assert.ok(html.includes('bulkImportModal'), 'Must include bulk import modal');
    assert.ok(html.includes(short), 'Must render created link short code');
    assert.ok(html.includes('marketing'), 'Must render folder name');
    assert.ok(html.includes('tag1'), 'Must render tag');
    assert.ok(html.includes('m-nav'), 'Must render universal navbar');
    assert.ok(html.includes('m-footer'), 'Must render universal footer');
  });
});
