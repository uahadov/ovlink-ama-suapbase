const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'b66f58f96f4a4f6090de997ca71b72910d9695f95f24ddf9b255f4cbebf9804cff9e1b9d79f60df7e840a9136dbf126fd1f6f4f94b1f8cfbd93afbfccf8d4f8a';
process.env.NODE_ENV = 'test';
process.env.BASE_URL = '';
process.env.PUBLIC_BASE_URL = '';

const { helpers } = require('../server');

// Rows created by tests against the real database (see the API test below)
// so they can be cleaned up even if an assertion throws midway.
const createdTestUserIds = [];
let hasPostgres = false;

test.before(async () => {
  try {
    await helpers.dbGetAsync('SELECT 1');
    hasPostgres = true;
  } catch (err) {
    hasPostgres = false;
  }
});

test.after(async () => {
  for (const userId of createdTestUserIds) {
    try {
      // The API test below triggers fire-and-forget usage/security-event
      // logging via `res.on('finish', ...)` (not awaited by the request
      // handler). Poll briefly for that write to land before we delete the
      // rows it references, so cleanup doesn't race a foreign-key insert
      // against our deletes. This bounds the wait instead of guessing a
      // fixed delay.
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const row = await helpers.dbGetAsync(
          'SELECT COUNT(*) AS cnt FROM api_usage_logs WHERE user_id = ?',
          [userId]
        );
        if (row && Number(row.cnt) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      await helpers.dbRunAsync('DELETE FROM api_usage_logs WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM security_events WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM api_keys WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM urls WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [userId]);
    } catch {}
  }

  // Wait for the server's fire-and-forget startup migration queue to drain
  // before closing the pool, so we don't log spurious "pool already ended"
  // errors for migrations that were still in flight.
  const migrationDrainDeadline = Date.now() + 5000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Close the pg Pool so the test process can exit instead of hanging on
  // the pool's minimum idle connections.
  try {
    await helpers.closeDbPool();
  } catch {}
});

test('ensureAbsoluteUrl allows only http/https and normalizes bare host', () => {
  assert.equal(helpers.ensureAbsoluteUrl('example.com'), 'http://example.com/');
  assert.equal(helpers.ensureAbsoluteUrl('https://ovlink.sbs/path'), 'https://ovlink.sbs/path');
  assert.equal(helpers.ensureAbsoluteUrl('javascript:alert(1)'), '');
  assert.equal(helpers.ensureAbsoluteUrl('data:text/html;base64,AAAA'), '');
});

test('normalizeCustomDomainInput accepts valid domain and rejects invalid inputs', () => {
  assert.equal(helpers.normalizeCustomDomainInput('Go.Example.COM'), 'go.example.com');
  assert.equal(helpers.normalizeCustomDomainInput('https://sub.domain.example/path'), 'sub.domain.example');
  assert.equal(helpers.normalizeCustomDomainInput('127.0.0.1'), '');
  assert.equal(helpers.normalizeCustomDomainInput('bad_domain'), '');
});

test('isReservedShortAlias blocks system and public routes', () => {
  assert.equal(helpers.isReservedShortAlias('faq'), true);
  assert.equal(helpers.isReservedShortAlias('DoCs'), true);
  assert.equal(helpers.isReservedShortAlias('dashboard'), true);
  assert.equal(helpers.isReservedShortAlias('my-brand-link'), false);
});

test('getRequestIp uses req.ip and ignores spoofable forwarded headers', () => {
  const req = {
    ip: '::ffff:203.0.113.10',
    socket: { remoteAddress: '::ffff:10.0.0.9' },
    get(name) {
      const key = String(name || '').toLowerCase();
      if (key === 'cf-connecting-ip') return '198.51.100.5';
      if (key === 'x-real-ip') return '198.51.100.6';
      return '';
    }
  };
  assert.equal(helpers.getRequestIp(req), '203.0.113.10');
});

test('getPublicBaseUrl rejects untrusted Host header fallback', () => {
  const req = {
    secure: false,
    hostname: 'localhost',
    get(name) {
      if ((name || '').toLowerCase() === 'host') return 'evil.example:8080';
      return '';
    }
  };
  assert.equal(helpers.getPublicBaseUrl(req), 'http://localhost');
});

test('getPublicBaseUrl allows trusted localhost host header with port', () => {
  const req = {
    secure: false,
    hostname: 'localhost',
    get(name) {
      if ((name || '').toLowerCase() === 'host') return 'localhost:3001';
      return '';
    }
  };
  assert.equal(helpers.getPublicBaseUrl(req), 'http://localhost:3001');
});

test('redirect consent signature validation is strict', () => {
  const short = 'abc123';
  const next = helpers.normalizeConsentNext('redirect');
  const readyAt = Date.now() + 1500;
  const sig = helpers.buildRedirectConsentSignature(short, next, readyAt);
  assert.equal(Boolean(sig), true);
  assert.equal(helpers.isRedirectConsentSignatureValid(short, next, readyAt, sig), true);
  assert.equal(helpers.isRedirectConsentSignatureValid(short, next, readyAt + 1, sig), false);
  assert.equal(helpers.isRedirectConsentSignatureValid(short, 'proceed', readyAt, sig), false);
});

test('normalizeFutureExpiryInput accepts valid future datetime and rejects invalid values', () => {
  const future = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const ok = helpers.normalizeFutureExpiryInput(future);
  assert.equal(ok.error, '');
  assert.match(ok.value || '', /\d{4}-\d{2}-\d{2}T/);

  const invalid = helpers.normalizeFutureExpiryInput('not-a-date');
  assert.equal(invalid.error, 'invalid');
  assert.equal(invalid.value, null);

  const past = new Date(Date.now() - 60 * 1000).toISOString();
  const expired = helpers.normalizeFutureExpiryInput(past);
  assert.equal(expired.error, 'past');
  assert.equal(expired.value, null);
});

test('isIsoTimeExpired handles valid, empty and malformed date values safely', () => {
  assert.equal(helpers.isIsoTimeExpired(''), false);
  assert.equal(helpers.isIsoTimeExpired(new Date(Date.now() - 5000).toISOString()), true);
  assert.equal(helpers.isIsoTimeExpired(new Date(Date.now() + 5000).toISOString()), false);
  assert.equal(helpers.isIsoTimeExpired('bad-value'), true);
});

test('maskIpForDisplay masks IPv4 and IPv6 values', () => {
  assert.equal(helpers.maskIpForDisplay('104.23.172.119'), '104.23.x.x');
  assert.equal(helpers.maskIpForDisplay('::ffff:203.0.113.10'), '203.0.x.x');
  assert.equal(helpers.maskIpForDisplay('2001:0db8:85a3:0000:0000:8a2e:0370:7334'), '2001:0db8:xxxx:xxxx');
  assert.equal(helpers.maskIpForDisplay('not-an-ip'), '');
});

test('buildNetworkFingerprintForDisplay returns non-reversible short tag', () => {
  const tagA = helpers.buildNetworkFingerprintForDisplay('104.23.172.119');
  const tagB = helpers.buildNetworkFingerprintForDisplay('104.23.172.119');
  const tagC = helpers.buildNetworkFingerprintForDisplay('104.23.172.120');

  assert.match(tagA, /^[A-F0-9]{10}$/);
  assert.equal(tagA, tagB);
  assert.notEqual(tagA, tagC);
  assert.equal(helpers.buildNetworkFingerprintForDisplay(''), '');
});

test('webhook outbound validation blocks local/internal targets', async () => {
  const localIp = await helpers.validateOutboundWebhookUrl('https://127.0.0.1:8080/hook');
  assert.equal(localIp.ok, false);
  assert.equal(localIp.reason, 'blocked_ip');

  const localHost = await helpers.validateOutboundWebhookUrl('https://localhost/webhook');
  assert.equal(localHost.ok, false);
  assert.equal(localHost.reason, 'blocked_host');

  const internalSuffix = await helpers.validateOutboundWebhookUrl('https://hook.internal/callback');
  assert.equal(internalSuffix.ok, false);
  assert.equal(internalSuffix.reason, 'blocked_host');
});

test('webhook outbound validation allows public literal IP and normalizes URL', async () => {
  const publicTarget = await helpers.validateOutboundWebhookUrl('https://8.8.8.8/webhook');
  assert.equal(publicTarget.ok, true);
  assert.equal(publicTarget.normalizedUrl, 'https://8.8.8.8/webhook');
});

test('API key hashing keeps legacy and v2 domains separated', () => {
  const raw = 'ovk_test_example_1234567890';
  const legacy = helpers.hashApiKeyValueLegacy(raw);
  const v2 = helpers.hashApiKeyValue(raw);
  assert.match(legacy, /^[a-f0-9]{64}$/);
  assert.match(v2, /^[a-f0-9]{64}$/);
  assert.notEqual(legacy, v2);
});

test('webhook v2 signature key derivation is deterministic', () => {
  const secret = 'whsec_demo_secret_value';
  const k1 = helpers.buildWebhookSignatureV2Key(secret);
  const k2 = helpers.buildWebhookSignatureV2Key(secret);
  const k3 = helpers.buildWebhookSignatureV2Key('whsec_other_secret_value');
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
  assert.match(k1, /^[A-Za-z0-9_-]{20,}$/);
});

test('adsterra native partial does not crash when optional flag is missing', async () => {
  const partialPath = path.join(process.cwd(), 'views', 'partials', 'adsterra-native.ejs');
  const html = await ejs.renderFile(partialPath, { allowAds: false, adFrameSandbox: 'allow-scripts' }, {
    async: true,
    filename: partialPath,
  });

  assert.equal(html.trim(), '');
});

test('pro shorten API accepts camelCase payloads and returns API-friendly errors', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }
  const nowIso = new Date().toISOString();
  const expiresIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const email = `api-test-${Date.now()}@example.com`;
  const rawKey = `ovk_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 70);
  const keyHash = helpers.hashApiKeyValue(rawKey);

  // Seed against the *same* database the running app uses (helpers.dbRunAsync
  // talks to the real pg Pool inside server.js), not a disconnected local
  // sqlite file. Previously this test created an empty throwaway sqlite
  // database that never had a schema, so it always failed by timing out in
  // `waitForApiSchema`.
  await helpers.dbRunAsync(
    "INSERT INTO users (email, password, plan_tier, plan_status, pro_expires_at) VALUES (?, ?, 'pro', 'active', ?)",
    [email, 'x', expiresIso]
  );
  const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
  assert.equal(Number.isInteger(user && user.id), true);
  createdTestUserIds.push(user.id);

  await helpers.dbRunAsync(
    'INSERT INTO api_keys (user_id, name, scopes, key_hash, hash_version, key_prefix, last4, created_at) VALUES (?, ?, ?, ?, 2, ?, ?, ?)',
    [
      user.id,
      'test key',
      'account:read,shorten:write',
      keyHash,
      rawKey.slice(0, 12),
      rawKey.slice(-4),
      nowIso,
    ]
  );

  const server = require('../server').app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const createRes = await fetch(`${base}/api/pro/v1/shorten`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': rawKey,
      },
      body: JSON.stringify({
        originalUrl: 'https://example.com/camel-case-ok',
        customAlias: '',
      }),
    });
    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    assert.equal(createBody.original_url, 'https://example.com/camel-case-ok');
    assert.match((createBody.short_url || '').toString(), /^http:\/\/127\.0\.0\.1:\d+\//);

    const methodRes = await fetch(`${base}/api/pro/v1/shorten`, { method: 'GET' });
    assert.equal(methodRes.status, 405);
    assert.match(methodRes.headers.get('allow') || '', /POST/i);

    const badJsonRes = await fetch(`${base}/api/pro/v1/shorten`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': rawKey,
      },
      body: '{"original_url":"https://example.com",}',
    });
    assert.equal(badJsonRes.status, 400);
    const badJsonBody = await badJsonRes.json();
    assert.equal(
      badJsonBody.error,
      'Invalid JSON body. Send valid JSON with Content-Type: application/json.'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

