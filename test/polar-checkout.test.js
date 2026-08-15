const test = require('node:test');
const assert = require('node:assert/strict');

process.env.POLAR_WEBHOOK_SECRET = 'whsec_test_secret_for_regression';
process.env.POLAR_PRODUCT_ID = 'test_pro_product_id';
process.env.POLAR_PRODUCT_PRICE_ID = 'test_pro_price_id';
process.env.POLAR_ACCESS_TOKEN = 'test_access_token';
process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');

const createdTestUserIds = [];
const createdTestSids = [];
const originalFetch = globalThis.fetch;

test.before(async () => {
  const migrationDrainDeadline = Date.now() + 5000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
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
  const migrationDrainDeadline = Date.now() + 5000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    await helpers.closeDbPool();
  } catch {}
});

test('Polar Server-Side Checkout Sessions API', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Helper to create a test user and their active session.
  // The email column is seeded the way real registration stores it:
  // AES-256-GCM ciphertext plus a blind-index hash. (Regression guard for
  // the checkout bug where the ciphertext was sent to Polar as-is.)
  async function createAuthenticatedSession(email, trialUsedAt = null) {
    const eHash = blindIndex(email);
    await helpers.dbRunAsync(
      'INSERT INTO users (email, email_hash, password, plan_tier, plan_status, trial_used_at) VALUES (?, ?, ?, ?, ?, ?)',
      [encryptAES256GCM(email), eHash, 'x', 'free', 'none', trialUsedAt]
    );
    const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [eHash]);
    createdTestUserIds.push(user.id);

    // Create session in DB to bypass the /login route for testing
    const sid = `test_sid_${Date.now()}_${Math.random()}`;
    createdTestSids.push(sid);
    const sessData = { cookie: { originalMaxAge: 3600000 }, userId: user.id };
    const expireStr = new Date(Date.now() + 3600000).toISOString();
    await helpers.dbRunAsync(
      "INSERT INTO express_sessions (sid, sess, expire) VALUES (?, ?, ?)",
      [sid, JSON.stringify(sessData), expireStr]
    );

    // session signature (connect-pg-simple uses express-session signing logic)
    const crypto = require('crypto');
    const signed = 's:' + sid + '.' + crypto.createHmac('sha256', process.env.SESSION_SECRET).update(sid).digest('base64').replace(/\=+$/, '');

    return { user, cookie: `connect.sid=${encodeURIComponent(signed)}` };
  }

  async function requestCheckout(cookie) {
    const getRes = await fetch(`${baseUrl}/pricing`, { headers: { 'cookie': cookie } });
    const getHtml = await getRes.text();
    const csrfMatch = getHtml.match(/name="csrf-token" content="([^"]+)"/);
    const csrfToken = csrfMatch ? csrfMatch[1] : '';

    let polarPayloadReceived = null;
    globalThis.fetch = async (url, options) => {
      if (url === 'https://api.polar.sh/v1/checkouts/') {
        polarPayloadReceived = JSON.parse(options.body);
        return { ok: true, json: async () => ({ url: 'https://sandbox.polar.sh/checkout/xxx' }) };
      }
      return originalFetch(url, options);
    };

    const res = await fetch(`${baseUrl}/api/polar/create-checkout`, {
      method: 'POST',
      headers: {
        'cookie': cookie,
        'x-csrf-token': csrfToken,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ _csrf: csrfToken })
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, polarPayloadReceived };
  }

  await t.test('1. Unauthenticated users cannot create checkouts', async () => {
    const res = await fetch(`${baseUrl}/api/polar/create-checkout`, { method: 'POST' });
    assert.equal(res.status, 403);
  });

  await t.test('1b. The /pro checkout success page exists (F5: success_url must not 404)', async () => {
    const res = await fetch(`${baseUrl}/pro`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.match(html, /pro_success_title|Pro/, 'the success page content must render');
  });

  await t.test('2. Checkout sends the DECRYPTED email to Polar (C1: ciphertext must never leak)', async () => {
    const testEmail = `checkout-auth1-${Date.now()}@example.com`;
    const { user, cookie } = await createAuthenticatedSession(testEmail);

    const { status, data, polarPayloadReceived } = await requestCheckout(cookie);
    assert.equal(status, 200);
    assert.equal(data.url, 'https://sandbox.polar.sh/checkout/xxx');

    // The stored email is ciphertext; Polar must receive the plaintext.
    assert.equal(polarPayloadReceived.customer_email, testEmail);
    assert.notEqual(polarPayloadReceived.customer_email, encryptAES256GCM(testEmail));
    // Server forces the metadata, ignoring anything the client might have tried to spoof
    assert.equal(polarPayloadReceived.customer_metadata.user_id, user.id.toString());
    // The success_url must point at the existing /pro page (F5).
    assert.ok(polarPayloadReceived.success_url.endsWith('/pro'), `success_url must end with /pro, got: ${polarPayloadReceived.success_url}`);
  });

  await t.test('3. Users who already used the trial get allow_trial:false (L3)', async () => {
    const testEmail = `checkout-trial-used-${Date.now()}@example.com`;
    const { cookie } = await createAuthenticatedSession(testEmail, new Date('2025-01-01T00:00:00Z').toISOString());

    const { status, polarPayloadReceived } = await requestCheckout(cookie);
    assert.equal(status, 200);
    assert.equal(polarPayloadReceived.allow_trial, false);
  });

  await t.test('4. Users who never used a trial keep the product default (no allow_trial override)', async () => {
    const testEmail = `checkout-trial-fresh-${Date.now()}@example.com`;
    const { cookie } = await createAuthenticatedSession(testEmail, null);

    const { status, polarPayloadReceived } = await requestCheckout(cookie);
    assert.equal(status, 200);
    assert.equal(polarPayloadReceived.allow_trial, undefined);
  });

  await t.test('5. Portal session: unauthenticated requests are rejected', async () => {
    const res = await fetch(`${baseUrl}/api/polar/portal-session`, { method: 'POST' });
    assert.equal(res.status, 403);
  });

  await t.test('6. Portal session: users without a Polar customer link get no_subscription', async () => {
    const testEmail = `portal-nolink-${Date.now()}@example.com`;
    const { cookie } = await createAuthenticatedSession(testEmail, null);

    const getRes = await fetch(`${baseUrl}/pricing`, { headers: { 'cookie': cookie } });
    const csrfToken = (await getRes.text()).match(/name="csrf-token" content="([^"]+)"/)?.[1] || '';

    const res = await fetch(`${baseUrl}/api/polar/portal-session`, {
      method: 'POST',
      headers: { 'cookie': cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ _csrf: csrfToken })
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'no_subscription');
  });

  await t.test('7. Portal session: linked users receive a Polar portal URL', async () => {
    const testEmail = `portal-ok-${Date.now()}@example.com`;
    const { cookie } = await createAuthenticatedSession(testEmail, null);
    await helpers.dbRunAsync('UPDATE users SET polar_customer_id = ? WHERE email_hash = ?', ['00000000-0000-4000-8000-00000000c0de', blindIndex(testEmail)]);

    const getRes = await fetch(`${baseUrl}/pricing`, { headers: { 'cookie': cookie } });
    const csrfToken = (await getRes.text()).match(/name="csrf-token" content="([^"]+)"/)?.[1] || '';

    let portalPayload = null;
    globalThis.fetch = async (url, options) => {
      if (url === 'https://api.polar.sh/v1/customer-sessions/') {
        portalPayload = JSON.parse(options.body);
        return { ok: true, json: async () => ({ customerPortalUrl: 'https://polar.sh/ovlink/portal/session?token=abc' }) };
      }
      return originalFetch(url, options);
    };

    const res = await fetch(`${baseUrl}/api/polar/portal-session`, {
      method: 'POST',
      headers: { 'cookie': cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ _csrf: csrfToken })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.url, 'https://polar.sh/ovlink/portal/session?token=abc');
    assert.equal(portalPayload.customer_id, '00000000-0000-4000-8000-00000000c0de');
    assert.ok(portalPayload.return_url.endsWith('/account'));
  });

  await new Promise((resolve) => server.close(resolve));
});
