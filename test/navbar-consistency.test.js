const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');

function forgeSessionCookie(sid) {
  const signed = 's:' + sid + '.' + crypto.createHmac('sha256', process.env.SESSION_SECRET).update(sid).digest('base64').replace(/=+$/, '');
  return `connect.sid=${encodeURIComponent(signed)}`;
}

const createdTestUserIds = [];
const createdTestSids = [];

let hasPostgres = false;

test.before(async () => {
  try {
    await helpers.dbGetAsync('SELECT 1');
    hasPostgres = true;
  } catch (err) {
    hasPostgres = false;
  }
  const migrationDrainDeadline = Date.now() + 5000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test.after(async () => {
  for (const sid of createdTestSids) {
    try {
      await helpers.dbRunAsync('DELETE FROM express_sessions WHERE sid = ?', [sid]);
    } catch {}
  }
  for (const userId of createdTestUserIds) {
    try {
      await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [userId]);
    } catch {}
  }
  const migrationDrainDeadline = Date.now() + 5000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    await helpers.closeDbPool();
  } catch {}
});

test('Universal Navbar consistency across pages and authentication tiers', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(() => {
    server.close();
  });

  const pagesToTest = ['/', '/pricing', '/about', '/why-ovlink', '/faq', '/api-guide', '/docs'];

  await t.test('1. Guest session correctly renders Language, Login, Register, and Pro on all pages', async () => {
    for (const path of pagesToTest) {
      const res = await fetch(`${baseUrl}${path}`);
      assert.equal(res.status, 200, `Path ${path} must respond 200`);
      const html = await res.text();

      // Guest Login & Register must be present and NOT hidden
      assert.match(html, /id="navAuthGuestLogin"[^>]*>Log in<\/a>/, `Guest Login link must not be hidden on ${path}`);
      assert.doesNotMatch(html, /id="navAuthGuestLogin"[^>]*hidden/, `Guest Login must not have hidden attribute on ${path}`);

      assert.match(html, /id="navAuthGuestReg"[^>]*>Sign up<\/a>/, `Guest Sign up button must not be hidden on ${path}`);
      assert.doesNotMatch(html, /id="navAuthGuestReg"[^>]*hidden/, `Guest Sign up must not have hidden attribute on ${path}`);

      // Pro CTA item must be present and not hidden for Guest
      assert.match(html, /id="navPricingItem"[^>]*>/, `Pro link must exist on ${path}`);
      assert.doesNotMatch(html, /id="navPricingItem"[^>]*hidden/, `Pro link must not be hidden for guest on ${path}`);

      // User menu must be hidden for Guest
      assert.match(html, /id="navAuthUser"[^>]*hidden/, `User menu must be hidden for guest on ${path}`);
    }
  });

  await t.test('2. Logged-in Free user navbar renders User Menu & Pro upgrade CTA, hides Guest buttons', async () => {
    if (!hasPostgres) {
      t.skip('Skipping DB-dependent test: Postgres not reachable in test runner');
      return;
    }

    const testEmail = `nav_free_${Date.now()}@example.com`;
    const passwordHash = '$2b$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUV012345';
    await helpers.dbRunAsync(
      `INSERT INTO users (email, email_hash, password, plan_tier, plan_status, created_at)
       VALUES (?, ?, ?, 'free', 'active', ?)`,
      [encryptAES256GCM(testEmail), blindIndex(testEmail), passwordHash, new Date().toISOString()]
    );
    const userRow = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(testEmail)]);
    createdTestUserIds.push(userRow.id);

    const sid = `test_sid_free_${Date.now()}`;
    createdTestSids.push(sid);
    const sessionData = {
      cookie: { originalMaxAge: 86400000, expires: new Date(Date.now() + 86400000).toISOString(), httpOnly: true, path: '/' },
      userId: userRow.id,
      username: testEmail
    };
    await helpers.dbRunAsync(
      'INSERT INTO express_sessions (sid, sess, expire) VALUES (?, ?, ?)',
      [sid, JSON.stringify(sessionData), new Date(Date.now() + 86400000)]
    );

    const sessionCookie = forgeSessionCookie(sid);

    for (const path of pagesToTest) {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { 'Cookie': sessionCookie }
      });
      assert.equal(res.status, 200, `Path ${path} must respond 200`);
      const html = await res.text();

      assert.match(html, /id="navAuthGuestLogin"[^>]*hidden/, `Guest Login must be hidden for logged in user on ${path}`);
      assert.match(html, /id="navAuthGuestReg"[^>]*hidden/, `Guest Register must be hidden for logged in user on ${path}`);

      assert.match(html, /id="navAuthUser"/, `User menu must exist on ${path}`);
      assert.doesNotMatch(html, /id="navAuthUser"[^>]*hidden/, `User menu must not be hidden on ${path}`);

      assert.match(html, /id="navPricingItem"/, `Pro link must exist on ${path}`);
      assert.doesNotMatch(html, /id="navPricingItem"[^>]*hidden/, `Pro link must not be hidden for Free user on ${path}`);

      assert.match(html, /id="navUserProBadge"[^>]*hidden/, `PRO badge should be hidden for Free user on ${path}`);
    }
  });

  await t.test('3. Logged-in Pro user navbar shows User Menu with PRO badge and hides redundant Pro buy CTA', async () => {
    if (!hasPostgres) {
      t.skip('Skipping DB-dependent test: Postgres not reachable in test runner');
      return;
    }

    const testEmail = `nav_pro_${Date.now()}@example.com`;
    const passwordHash = '$2b$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUV012345';
    await helpers.dbRunAsync(
      `INSERT INTO users (email, email_hash, password, plan_tier, plan_status, pro_expires_at, created_at)
       VALUES (?, ?, ?, 'pro', 'active', ?, ?)`,
      [encryptAES256GCM(testEmail), blindIndex(testEmail), passwordHash, new Date(Date.now() + 30 * 86400000).toISOString(), new Date().toISOString()]
    );
    const userRow = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(testEmail)]);
    createdTestUserIds.push(userRow.id);

    const sid = `test_sid_pro_${Date.now()}`;
    createdTestSids.push(sid);
    const sessionData = {
      cookie: { originalMaxAge: 86400000, expires: new Date(Date.now() + 86400000).toISOString(), httpOnly: true, path: '/' },
      userId: userRow.id,
      username: testEmail
    };
    await helpers.dbRunAsync(
      'INSERT INTO express_sessions (sid, sess, expire) VALUES (?, ?, ?)',
      [sid, JSON.stringify(sessionData), new Date(Date.now() + 86400000)]
    );

    const sessionCookie = forgeSessionCookie(sid);

    for (const path of pagesToTest) {
      const res = await fetch(`${baseUrl}${path}`, {
        headers: { 'Cookie': sessionCookie }
      });
      assert.equal(res.status, 200, `Path ${path} must respond 200`);
      const html = await res.text();

      assert.match(html, /id="navAuthGuestLogin"[^>]*hidden/, `Guest Login must be hidden on ${path}`);
      assert.match(html, /id="navAuthGuestReg"[^>]*hidden/, `Guest Register must be hidden on ${path}`);

      assert.match(html, /id="navAuthUser"/, `User menu must exist on ${path}`);
      assert.doesNotMatch(html, /id="navAuthUser"[^>]*hidden/, `User menu must not be hidden on ${path}`);

      assert.match(html, /id="navPricingItem"[^>]*hidden/, `Pro buy CTA should be hidden for Pro subscriber on ${path}`);

      assert.match(html, /id="navUserProBadge"/, `PRO badge must exist on ${path}`);
      assert.doesNotMatch(html, /id="navUserProBadge"[^>]*hidden/, `PRO badge should be visible for Pro subscriber on ${path}`);
    }
  });
});
