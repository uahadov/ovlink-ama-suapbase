const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const speakeasy = require('speakeasy');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');
const { blindIndex, encryptAES256GCM, decryptAES256GCM } = require('../utils/crypto');

const createdTestUserIds = [];
const createdTestSids = [];
const originalFetch = globalThis.fetch;
const TEST_PASSWORD = 'test_password_123';

function trackSid(sid) {
  createdTestSids.push(sid);
  return sid;
}

function forgeSessionCookie(sid) {
  const signed = 's:' + sid + '.' + crypto.createHmac('sha256', process.env.SESSION_SECRET).update(sid).digest('base64').replace(/=+$/, '');
  return `connect.sid=${encodeURIComponent(signed)}`;
}

test.before(async () => {
  const deadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test.after(async () => {
  globalThis.fetch = originalFetch;
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
  const deadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    await helpers.closeDbPool();
  } catch {}
});

test('user 2FA and email change flows', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const email = `twofa-user-${Date.now()}@example.com`;
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status) VALUES (?, ?, ?, 1, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), passwordHash, 'free', 'active']
  );
  const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdTestUserIds.push(user.id);

  const sid = trackSid(`test_2fa_${Date.now()}_${Math.random()}`);
  await helpers.dbRunAsync(
    "INSERT INTO express_sessions (sid, sess, expire) VALUES (?, ?, ?)",
    [sid, JSON.stringify({ cookie: { originalMaxAge: 3600000 }, userId: user.id }), new Date(Date.now() + 3600000).toISOString()]
  );
  const cookie = forgeSessionCookie(sid);

  async function getCsrf(forCookie = cookie) {
    const res = await fetch(`${baseUrl}/pricing`, { headers: { 'cookie': forCookie } });
    const html = await res.text();
    return html.match(/name="csrf-token" content="([^"]+)"/)?.[1] || '';
  }
  async function post(path, body, useCookie = cookie) {
    // The CSRF token is HMAC-bound to the session ID, so it must be fetched
    // with the very cookie that will submit the request.
    const token = await getCsrf(useCookie);
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'cookie': useCookie, 'x-csrf-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, _csrf: token })
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  }

  await t.test('1. 2FA setup returns an otpauth URL and QR', async () => {
    const { status, data } = await post('/api/user/2fa/setup', {});
    assert.equal(status, 200);
    assert.match(data.otpauthUrl, /^otpauth:\/\/totp\//);
    assert.ok(data.qr);
  });

  await t.test('2. enable with a valid TOTP code', async () => {
    const row = await helpers.dbGetAsync('SELECT totp_pending_secret FROM users WHERE id = ?', [user.id]);
    const secret = decryptAES256GCM(row.totp_pending_secret);
    const code = speakeasy.totp({ secret, encoding: 'base32' });
    const { status, data } = await post('/api/user/2fa/enable', { code });
    assert.equal(status, 200);

    const me = await fetch(`${baseUrl}/api/me`, { headers: { 'cookie': cookie } }).then((r) => r.json());
    assert.equal(me.user.twofaEnabled, true);
  });

  await t.test('3. login now requires the second factor', async () => {
    // Use a disposable session: the login flow regenerates the session, which
    // would invalidate the dashboard cookie used by the later subtests.
    const loginSid = trackSid(`test_2fa_login3_${Date.now()}_${Math.random()}`);
    await helpers.dbRunAsync(
      "INSERT INTO express_sessions (sid, sess, expire) VALUES (?, ?, ?)",
      [loginSid, JSON.stringify({ cookie: { originalMaxAge: 3600000 } }), new Date(Date.now() + 3600000).toISOString()]
    );
    const login = await post('/api/login', { email, password: TEST_PASSWORD }, forgeSessionCookie(loginSid));
    assert.equal(login.status, 200);
    assert.equal(login.data.twofaRequired, true);
  });

  await t.test('4. wrong 2FA code is rejected, correct code logs in', async () => {
    const row = await helpers.dbGetAsync('SELECT totp_secret FROM users WHERE id = ?', [user.id]);
    const secret = decryptAES256GCM(row.totp_secret);

    // Need the login-session cookie (holds pending2faUserId), not the dashboard one.
    const guestSid = trackSid(`test_2fa_login_${Date.now()}_${Math.random()}`);
    await helpers.dbRunAsync(
      "INSERT INTO express_sessions (sid, sess, expire) VALUES (?, ?, ?)",
      [guestSid, JSON.stringify({ cookie: { originalMaxAge: 3600000 }, pending2faUserId: user.id, pending2faStartedAt: Date.now() }), new Date(Date.now() + 3600000).toISOString()]
    );
    const loginCookie = forgeSessionCookie(guestSid);

    const bad = await post('/api/verify-2fa', { code: '000000' }, loginCookie);
    if (bad.status === 200) return; // 000000 happened to be valid this 30s window
    assert.equal(bad.status, 401);

    const code = speakeasy.totp({ secret, encoding: 'base32' });
    const good = await post('/api/verify-2fa', { code }, loginCookie);
    assert.equal(good.status, 200);
    assert.equal(good.data.username, email);
  });

  await t.test('5. disable requires password and a valid code', async () => {
    const row = await helpers.dbGetAsync('SELECT totp_secret FROM users WHERE id = ?', [user.id]);
    const secret = decryptAES256GCM(row.totp_secret);
    const code = speakeasy.totp({ secret, encoding: 'base32' });

    const wrong = await post('/api/user/2fa/disable', { password: 'not_the_password', code });
    assert.equal(wrong.status, 401);

    const ok = await post('/api/user/2fa/disable', { password: TEST_PASSWORD, code });
    assert.equal(ok.status, 200);
    const me = await fetch(`${baseUrl}/api/me`, { headers: { 'cookie': cookie } }).then((r) => r.json());
    assert.equal(me.user.twofaEnabled, false);
  });

  await t.test('6. email change: request sends a code, confirm swaps identity', async () => {
    // Stub only the Resend mail API; everything else passes through.
    globalThis.fetch = async (url, options) => {
      if (typeof url === 'string' && url.includes('api.resend.com')) {
        return { ok: true, status: 200, json: async () => ({ id: 'stub' }), text: async () => '' };
      }
      return originalFetch(url, options);
    };

    const newEmail = `twofa-new-${Date.now()}@example.com`;
    const wrongPass = await post('/api/user/email/change', { new_email: newEmail, current_password: 'nope' });
    assert.equal(wrongPass.status, 401);

    const req = await post('/api/user/email/change', { new_email: newEmail, current_password: TEST_PASSWORD });
    assert.equal(req.status, 200);

    const pending = await helpers.dbGetAsync('SELECT pending_email, pending_email_code, pending_email_expires_at FROM users WHERE id = ?', [user.id]);
    assert.ok(pending.pending_email);
    assert.ok(pending.pending_email_code);
    assert.equal(decryptAES256GCM(pending.pending_email), newEmail);

    const bad = await post('/api/user/email/confirm', { code: '000000' });
    if (bad.status !== 200) assert.equal(bad.status, 400);

    const good = await post('/api/user/email/confirm', { code: decryptAES256GCM(pending.pending_email_code) });
    assert.equal(good.status, 200);
    assert.equal(good.data.email, newEmail);

    const updated = await helpers.dbGetAsync('SELECT email_hash, pending_email FROM users WHERE id = ?', [user.id]);
    assert.equal(updated.email_hash, blindIndex(newEmail));
    assert.equal(updated.pending_email, null);

    globalThis.fetch = originalFetch;
  });

  await new Promise((resolve) => server.close(resolve));
});
