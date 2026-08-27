const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');

let hasPostgres = false;
const createdTestUserIds = [];

test.before(async () => {
  try {
    await helpers.dbGetAsync('SELECT 1');
    hasPostgres = true;
  } catch (err) {
    hasPostgres = false;
  }
  const migrationDrainDeadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test.after(async () => {
  for (const userId of createdTestUserIds) {
    try {
      await helpers.dbRunAsync('DELETE FROM notifications WHERE user_id = ?', [userId]);
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

// C2 regression: one account per email identity, enforced by the database.
// The index is created by the startup migration; parallel test processes boot
// the server against the same database, so poll briefly instead of assuming
// this process created it first.
test('unique indexes exist on users(email_hash) and admin_users(email_hash)', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }
  const deadline = Date.now() + 15000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await helpers.dbAllAsync(
      "SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('idx_users_email_hash', 'idx_admin_users_email_hash')"
    );
    if (rows.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const names = rows.map((r) => r.indexname).sort();
  assert.deepEqual(names, ['idx_admin_users_email_hash', 'idx_users_email_hash']);
  for (const row of rows) {
    assert.match(row.indexdef, /UNIQUE/i, `${row.indexname} must be a UNIQUE index`);
  }
});

test('account identity: duplicate emails and id-scoped verification', async (t) => {
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

  // Guest session with a CSRF token (the register endpoint requires both).
  async function getCsrfSession() {
    const res = await fetch(`${baseUrl}/api/csrf`);
    const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
    const sidCookie = setCookies
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('connect.sid='));
    const { csrfToken } = await res.json();
    return { cookie: sidCookie, csrfToken };
  }

  await t.test('registration rejects a second account for an existing email (C2 shadow-account attack)', async () => {
    const victimEmail = `c2-victim-${Date.now()}@example.com`;
    const victimHash = blindIndex(victimEmail);
    await helpers.dbRunAsync(
      'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status) VALUES (?, ?, ?, 1, ?, ?)',
      [encryptAES256GCM(victimEmail), victimHash, 'victim_password_hash', 'free', 'active']
    );
    const victim = await helpers.dbGetAsync('SELECT id, email_verified FROM users WHERE email_hash = ?', [victimHash]);
    createdTestUserIds.push(victim.id);

    const { cookie, csrfToken } = await getCsrfSession();
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'cookie': cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ email: victimEmail, password: 'attacker_password' })
    });

    assert.equal(res.status, 400);
    const countRow = await helpers.dbGetAsync('SELECT COUNT(*)::int AS c FROM users WHERE email_hash = ?', [victimHash]);
    assert.equal(countRow.c, 1, 'no second row may exist for the same email identity');

    const stillThere = await helpers.dbGetAsync('SELECT id, email_verified FROM users WHERE id = ?', [victim.id]);
    assert.ok(stillThere, 'the original account must be untouched');
    assert.equal(stillThere.email_verified, 1);
  });

  await t.test('verify-email updates only the matched account row (C3 id-scoping)', async () => {
    const emailA = `c3-verify-a-${Date.now()}@example.com`;
    const emailB = `c3-verify-b-${Date.now()}@example.com`;
    const codeA = '654321';
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await helpers.dbRunAsync(
      'INSERT INTO users (email, email_hash, password, email_verified, verification_code, verification_expires_at, plan_tier, plan_status) VALUES (?, ?, ?, 0, ?, ?, ?, ?)',
      [encryptAES256GCM(emailA), blindIndex(emailA), 'x', encryptAES256GCM(codeA), expiresAt, 'free', 'active']
    );
    await helpers.dbRunAsync(
      'INSERT INTO users (email, email_hash, password, email_verified, verification_code, verification_expires_at, plan_tier, plan_status) VALUES (?, ?, ?, 0, ?, ?, ?, ?)',
      [encryptAES256GCM(emailB), blindIndex(emailB), 'x', encryptAES256GCM('999999'), expiresAt, 'free', 'active']
    );
    const userA = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(emailA)]);
    const userB = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(emailB)]);
    createdTestUserIds.push(userA.id, userB.id);

    const { cookie, csrfToken } = await getCsrfSession();
    const res = await fetch(`${baseUrl}/api/verify-email`, {
      method: 'POST',
      headers: { 'cookie': cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailA, verificationCode: codeA })
    });
    assert.equal(res.status, 200);

    const afterA = await helpers.dbGetAsync('SELECT email_verified, verification_code FROM users WHERE id = ?', [userA.id]);
    const afterB = await helpers.dbGetAsync('SELECT email_verified, verification_code FROM users WHERE id = ?', [userB.id]);
    assert.equal(afterA.email_verified, 1, 'the verified account must be marked');
    assert.equal(afterA.verification_code, null);
    assert.equal(afterB.email_verified, 0, 'other accounts must remain untouched');
    assert.ok(afterB.verification_code, 'other account keeps its own code');
  });

  await new Promise((resolve) => server.close(resolve));
});
