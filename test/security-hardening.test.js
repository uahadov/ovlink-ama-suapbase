const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '4f9a1c2b8e7d6053a1f0c9b82d7e4156a3c8f0d2b6e4917c5a0d3f8e2b4c6a9d';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');

const createdShorts = [];
const createdUserIds = [];
const createdBlockedDomains = [];

let hasPostgres = false;

const CONSENT_COOKIE = 'ovlink_redirect_consent=analytics';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function uniqueShort(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function pastIso() {
  return new Date(Date.now() - 60 * 1000).toISOString();
}

test.before(async () => {
  try {
    await helpers.dbGetAsync('SELECT 1');
    hasPostgres = true;
  } catch {
    hasPostgres = false;
  }
  const deadline = Date.now() + 5000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test.after(async () => {
  for (const short of createdShorts) {
    try { await helpers.dbRunAsync('DELETE FROM clicks WHERE url_id IN (SELECT id FROM urls WHERE short = ?)', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM reports WHERE short = ?', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM urls WHERE short = ?', [short]); } catch {}
  }
  for (const domain of createdBlockedDomains) {
    try { await helpers.dbRunAsync('DELETE FROM blocked_domains WHERE domain = ?', [domain]); } catch {}
  }
  for (const userId of createdUserIds) {
    try { await helpers.dbRunAsync('DELETE FROM password_resets WHERE user_id = ?', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM user_sessions WHERE user_id = ?', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM bot_users WHERE user_id = ?', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM urls WHERE user_id = ?', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [userId]); } catch {}
  }

  const deadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { await helpers.closeDbPool(); } catch {}
});

// ---------------------------------------------------------------------------
// Unit-level checks (no database required)
// ---------------------------------------------------------------------------

test('SEC-01: getUrlHostname parses URLs instead of returning the scheme', () => {
  const { getUrlHostname } = require('../src/routes/api/links');
  assert.equal(getUrlHostname('https://evil.example/path'), 'evil.example');
  assert.equal(getUrlHostname('http://sub.evil.example:8080/x'), 'sub.evil.example');
  assert.equal(getUrlHostname('evil.example/x'), 'evil.example');
  assert.equal(getUrlHostname(''), '');
  assert.equal(getUrlHostname('not a valid url'), '');
});

test('SEC-02: the redirect confirm token is signed, time-bound and short-code bound', () => {
  const { buildRedirectConfirmToken, isRedirectConfirmTokenValid, REDIRECT_CONFIRM_TTL_MS } = require('../src/lib/consent');

  const token = buildRedirectConfirmToken('abc123');
  assert.ok(token && token.includes('.'), 'token must contain expiry + signature');
  assert.equal(isRedirectConfirmTokenValid('abc123', token), true);
  assert.equal(isRedirectConfirmTokenValid('other1', token), false, 'token must not be reusable for another short code');
  assert.equal(isRedirectConfirmTokenValid('abc123', 'true'), false, 'legacy ?confirm=true must be rejected');
  assert.equal(isRedirectConfirmTokenValid('abc123', '1'), false);
  assert.equal(isRedirectConfirmTokenValid('abc123', ''), false);
  assert.equal(isRedirectConfirmTokenValid('abc123', null), false);

  const expired = buildRedirectConfirmToken('abc123', Date.now() - REDIRECT_CONFIRM_TTL_MS - 60000);
  assert.equal(isRedirectConfirmTokenValid('abc123', expired), false, 'expired tokens must be rejected');

  const tampered = token.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'));
  assert.equal(isRedirectConfirmTokenValid('abc123', tampered), false, 'tampered signatures must be rejected');
});

test('SEC-03: outbound fetcher refuses internal-service ports', async () => {
  const redis = await helpers.validateOutboundWebhookUrl('https://8.8.8.8:6379/attack');
  assert.equal(redis.ok, false);
  assert.equal(redis.reason, 'blocked_port');

  const ssh = await helpers.validateOutboundWebhookUrl('https://example.com:22/hook');
  assert.equal(ssh.ok, false);
  assert.equal(ssh.reason, 'blocked_port');

  const postgres = await helpers.validateOutboundWebhookUrl('https://example.com:5432/hook');
  assert.equal(postgres.ok, false);
  assert.equal(postgres.reason, 'blocked_port');

  // Legitimate HTTPS targets (including non-default ports) still pass.
  const https = await helpers.validateOutboundWebhookUrl('https://8.8.8.8/webhook');
  assert.equal(https.ok, true);
  const customPort = await helpers.validateOutboundWebhookUrl('https://8.8.8.8:8443/webhook');
  assert.equal(customPort.ok, true);
  assert.equal(helpers.getEffectivePort(new URL('https://example.com/x')), 443);
  assert.equal(helpers.getEffectivePort(new URL('http://example.com/x')), 80);
});

test('SEC-04: outbound responses are capped instead of buffered without limit', async () => {
  const { requestWebhookWithPinnedIp } = require('../src/lib/webhook');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    if (req.url === '/big') {
      res.end('x'.repeat(8 * 1024));
    } else {
      res.end('ok');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  const { port } = server.address();

  try {
    const small = await requestWebhookWithPinnedIp(`http://127.0.0.1:${port}/small`, '127.0.0.1', {
      method: 'GET',
      timeoutMs: 3000,
      maxResponseBytes: 1024,
    });
    assert.equal(small.status, 200);
    assert.equal(small.body, 'ok');

    await assert.rejects(
      () => requestWebhookWithPinnedIp(`http://127.0.0.1:${port}/big`, '127.0.0.1', {
        method: 'GET',
        timeoutMs: 3000,
        maxResponseBytes: 1024,
      }),
      /size limit/i,
      'oversized responses must abort instead of filling memory'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// Integration checks
// ---------------------------------------------------------------------------

test('SEC-05: moderation, expiry, blocklist and click limits cannot be bypassed via /proceed', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function insertShort(fields) {
    const payload = {
      original: 'https://example.com/destination',
      created_at: new Date().toISOString(),
      ...fields,
    };
    const columns = Object.keys(payload);
    const placeholders = columns.map(() => '?').join(', ');
    const inserted = await helpers.dbRunAsync(
      `INSERT INTO urls (${columns.join(', ')}) VALUES (${placeholders})`,
      columns.map((column) => payload[column])
    );
    createdShorts.push(payload.short);
    return inserted.lastID;
  }

  await t.test('1. /proceed honours an admin takedown (disabled link)', async (st) => {
    if (!hasPostgres) { st.skip('PostgreSQL database not reachable in test environment'); return; }
    const short = uniqueShort('hxp');
    await insertShort({ short, disabled: 1, disabled_reason: 'malware' });

    const res = await fetch(`${baseUrl}/proceed/${short}`, {
      headers: { Cookie: CONSENT_COOKIE },
      redirect: 'manual',
    });
    assert.equal(res.status, 410, 'disabled links must not be deliverable through /proceed');
  });

  await t.test('2. /proceed honours expiry', async (st) => {
    if (!hasPostgres) { st.skip('PostgreSQL database not reachable in test environment'); return; }
    const short = uniqueShort('hxe');
    await insertShort({ short, expires_at: pastIso() });

    const res = await fetch(`${baseUrl}/proceed/${short}`, {
      headers: { Cookie: CONSENT_COOKIE },
      redirect: 'manual',
    });
    assert.equal(res.status, 410, 'expired links must not be deliverable through /proceed');
  });

  await t.test('3. /proceed honours the destination blocklist for the resolved (device) target', async (st) => {
    if (!hasPostgres) { st.skip('PostgreSQL database not reachable in test environment'); return; }
    const blockedDomain = `blocked-${Date.now().toString(36)}.hx-test`;
    await helpers.dbRunAsync(
      'INSERT OR IGNORE INTO blocked_domains (domain, created_at) VALUES (?, ?)',
      [blockedDomain, new Date().toISOString()]
    );
    createdBlockedDomains.push(blockedDomain);

    const short = uniqueShort('hxb');
    await insertShort({
      short,
      original: 'https://example.com/safe',
      ios_url: `https://${blockedDomain}/payload`,
      original_b: `https://${blockedDomain}/split`,
      ab_split_percent: 0,
    });

    const mobileRes = await fetch(`${baseUrl}/proceed/${short}`, {
      headers: { Cookie: CONSENT_COOKIE, 'user-agent': IPHONE_UA },
      redirect: 'manual',
    });
    assert.equal(mobileRes.status, 451, 'device-targeted destinations must be checked against the blocklist');

    const abRes = await fetch(`${baseUrl}/proceed/${short}`, {
      headers: { Cookie: CONSENT_COOKIE, 'user-agent': DESKTOP_UA },
      redirect: 'manual',
    });
    assert.equal(abRes.status, 451, 'A/B destinations must be checked against the blocklist');
  });

  await t.test('4. /proceed honours the click limit', async (st) => {
    if (!hasPostgres) { st.skip('PostgreSQL database not reachable in test environment'); return; }
    const short = uniqueShort('hxm');
    const urlId = await insertShort({ short, max_clicks: 1 });
    await helpers.dbRunAsync(
      'INSERT INTO clicks (url_id, click_time, browser, os, country) VALUES (?, ?, ?, ?, ?)',
      [urlId, new Date().toISOString(), 'Chrome', 'Linux', 'AZ']
    );

    const res = await fetch(`${baseUrl}/proceed/${short}`, {
      headers: { Cookie: CONSENT_COOKIE },
      redirect: 'manual',
    });
    assert.equal(res.status, 410, 'click-limited links must not be deliverable through /proceed');
  });

  await t.test('5. dangerous links warn on /proceed and only a signed confirm proceeds', async (st) => {
    if (!hasPostgres) { st.skip('PostgreSQL database not reachable in test environment'); return; }
    const short = uniqueShort('hxw');
    await insertShort({ short, dangerous: 1, reports: 5 });

    const warn = await fetch(`${baseUrl}/proceed/${short}`, {
      headers: { Cookie: CONSENT_COOKIE },
      redirect: 'manual',
    });
    assert.equal(warn.status, 200, 'dangerous links must render the interstitial');
    const html = await warn.text();
    assert.ok(html.includes('m-gateway-card--warning'), 'warning card must be rendered');

    const unsigned = await fetch(`${baseUrl}/proceed/${short}?confirm=true`, {
      headers: { Cookie: CONSENT_COOKIE },
      redirect: 'manual',
    });
    assert.equal(unsigned.status, 200, 'unsigned ?confirm=true must not bypass the interstitial');

    const token = helpers.buildRedirectConfirmToken(short);
    const confirmed = await fetch(`${baseUrl}/proceed/${short}?confirm=${encodeURIComponent(token)}`, {
      headers: { Cookie: CONSENT_COOKIE },
      redirect: 'manual',
    });
    assert.equal(confirmed.status, 302, 'a signed confirm token must proceed');
    assert.equal(confirmed.headers.get('location'), 'https://example.com/destination');
  });

  await new Promise((resolve) => server.close(resolve));
});

test('SEC-06: CSRF exemption is scoped to the API-key namespace, not to any /api request', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await t.test('1. session route with an API-key-shaped header still requires CSRF', async () => {
      const res = await fetch(`${baseUrl}/api/user/ui-lang`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': `ovk_${'a'.repeat(40)}`,
        },
        body: JSON.stringify({ lang: 'en' }),
      });
      assert.equal(res.status, 403, 'CSRF must still apply to session-authenticated API routes');
    });

    await t.test('2. the Pro API remains usable without a CSRF token', async () => {
      const res = await fetch(`${baseUrl}/api/pro/v1/shorten`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': `ovk_${'b'.repeat(40)}`,
        },
        body: JSON.stringify({ url: 'https://example.com' }),
      });
      assert.notEqual(res.status, 403, 'the Pro API must not be rejected by CSRF');
      assert.ok([401, 500].includes(res.status), `expected an auth/db error, got ${res.status}`);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SEC-07: account enumeration and pre-hijack protections', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function getCsrfSession() {
    const res = await fetch(`${baseUrl}/api/csrf`);
    const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
    const sidCookie = setCookies
      .map((c) => (c ? c.split(';')[0] : ''))
      .find((c) => c.startsWith('connect.sid='));
    const { csrfToken } = await res.json();
    return { cookie: sidCookie, csrfToken };
  }

  try {
    await t.test('1. resend-verification never discloses whether an address exists', async () => {
      const { cookie, csrfToken } = await getCsrfSession();
      const body = JSON.stringify({ email: `nobody-${Date.now()}@example.com`, lang: 'en' });
      const res = await fetch(`${baseUrl}/api/resend-verification`, {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
        body,
      });
      assert.equal(res.status, 200, 'unknown addresses must not produce a 404');
      const payload = await res.json().catch(() => ({}));
      assert.ok(payload.message, 'a generic confirmation message must be returned');
    });

    await t.test('2. registering over an unverified row never preserves the attacker password', async (st) => {
      if (!hasPostgres) { st.skip('PostgreSQL database not reachable in test environment'); return; }
      const email = `hijack-${Date.now()}@example.com`;
      const emailHash = blindIndex(email);
      const attackerPassword = 'AttackerPassword123!';
      const attackerHash = await bcrypt.hash(attackerPassword, 10);

      await helpers.dbRunAsync(
        'INSERT INTO users (email, email_hash, password, email_verified) VALUES (?, ?, ?, 0)',
        [encryptAES256GCM(email), emailHash, attackerHash]
      );
      const before = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [emailHash]);
      assert.ok(before && before.id, 'seeded unverified row must exist');
      createdUserIds.push(before.id);

      const { cookie, csrfToken } = await getCsrfSession();
      await fetch(`${baseUrl}/api/register`, {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'VictimPassword123!', lang: 'en' }),
      });

      const after = await helpers.dbGetAsync(
        'SELECT id, password, email_verified FROM users WHERE email_hash = ?',
        [emailHash]
      );
      if (after && after.id) {
        if (after.id !== before.id) createdUserIds.push(after.id);
        assert.notEqual(after.id, before.id, 'the untrusted row must not be reused');
        const attackerStillWorks = await bcrypt.compare(attackerPassword, after.password || '');
        assert.equal(attackerStillWorks, false, 'the attacker-chosen password must not survive');
      } else {
        const resurrected = await helpers.dbGetAsync('SELECT id FROM users WHERE id = ?', [before.id]);
        assert.equal(resurrected, undefined, 'the untrusted unverified row must be purged');
      }
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
