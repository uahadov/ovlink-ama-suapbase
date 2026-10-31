const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '4f9a1c2b8e7d6053a1f0c9b82d7e4156a3c8f0d2b6e4917c5a0d3f8e2b4c6a9d';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');
const { ensureDbTables } = require('../src/db/migrate');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');
const analytics = require('../src/lib/analytics');
const linkStats = require('../src/lib/link-stats');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_TABLET_UA = 'Mozilla/5.0 (Linux; Android 13; SM-T870) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const BOT_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

const TEST_PASSWORD = 'AnalyticsTestPass123!';
const CONSENT_COOKIE = 'ovlink_redirect_consent=analytics';
const createdShorts = [];
const createdUserIds = [];
let hasPostgres = false;

function uniqueShort(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

test.before(async () => {
  try {
    await helpers.dbGetAsync('SELECT 1');
    hasPostgres = true;
  } catch {
    hasPostgres = false;
  }

  if (hasPostgres) {
    // Tests import server.js, which skips the bootstrap block; run the idempotent
    // migrations so the analytics schema is guaranteed to exist.
    ensureDbTables();
    const deadline = Date.now() + 20000;
    while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

test.after(async () => {
  for (const short of createdShorts) {
    try { await helpers.dbRunAsync('DELETE FROM clicks WHERE url_id IN (SELECT id FROM urls WHERE short = ?)', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM click_uniques WHERE url_id IN (SELECT id FROM urls WHERE short = ?)', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM link_stats_daily WHERE url_id IN (SELECT id FROM urls WHERE short = ?)', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM urls WHERE short = ?', [short]); } catch {}
  }
  for (const userId of createdUserIds) {
    try { await helpers.dbRunAsync('DELETE FROM api_keys WHERE user_id = ?', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM user_sessions WHERE user_id = ?', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [userId]); } catch {}
  }

  const deadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { await helpers.closeDbPool(); } catch {}
});

// ---------------------------------------------------------------------------
// Attribution helpers (no database required)
// ---------------------------------------------------------------------------

test('AN-01: device type is derived from the User-Agent', () => {
  assert.equal(analytics.detectDeviceType(CHROME_UA), 'desktop');
  assert.equal(analytics.detectDeviceType(IPHONE_UA), 'mobile');
  assert.equal(analytics.detectDeviceType(IPAD_UA), 'tablet');
  assert.equal(analytics.detectDeviceType(ANDROID_TABLET_UA), 'tablet');
  assert.equal(analytics.detectDeviceType(''), 'unknown');
});

test('AN-02: automation is flagged instead of being silently counted as human', () => {
  assert.equal(analytics.isBotUserAgent(BOT_UA), true);
  assert.equal(analytics.isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
  assert.equal(analytics.isBotUserAgent('curl/8.4.0'), true);
  assert.equal(analytics.isBotUserAgent(''), true, 'a request without UA is automation');
  assert.equal(analytics.isBotUserAgent(CHROME_UA), false);
  assert.equal(analytics.isBotUserAgent(IPHONE_UA), false);
});

test('AN-03: referrer host keeps external sources and drops self-references', () => {
  assert.equal(analytics.getReferrerHost('https://www.google.com/search?q=x', ['ovlink.sbs']), 'www.google.com');
  assert.equal(analytics.getReferrerHost('https://ovlink.sbs/dashboard', ['ovlink.sbs']), '');
  assert.equal(analytics.getReferrerHost('https://app.ovlink.sbs/x', ['ovlink.sbs']), '');
  assert.equal(analytics.getReferrerHost('https://localhost:3000/x', ['ovlink.sbs']), '', 'loopback traffic is never a source');
  assert.equal(analytics.getReferrerHost('', ['ovlink.sbs']), '');
  assert.equal(analytics.getReferrerHost('not a url', ['ovlink.sbs']), '');
});

test('AN-04: UTM parameters are normalized and bounded', () => {
  const utm = analytics.getUtmParams({ utm_source: ['LinkedIn'], utm_medium: ' Social ', utm_campaign: 'Spring Sale' });
  assert.equal(utm.source, 'linkedin');
  assert.equal(utm.medium, 'social');
  assert.equal(utm.campaign, 'spring sale');

  const long = analytics.getUtmParams({ utm_source: 'x'.repeat(500) });
  assert.equal(long.source.length, analytics.UTM_LENGTH);
  assert.equal(analytics.getUtmParams(null).source, '');
});

test('AN-05: essential consent stores no attribution and no visitor hash', () => {
  const record = analytics.buildClickRecord({
    consentMode: 'essential',
    req: {
      ip: '203.0.113.9',
      headers: { 'user-agent': CHROME_UA, referer: 'https://news.example/post', host: 'ovlink.sbs' },
      query: { utm_source: 'linkedin' },
      get(name) { return this.headers[String(name).toLowerCase()] || ''; },
    },
  });

  assert.equal(record.analyticsAllowed, false);
  assert.equal(record.ipHash, null);
  assert.equal(record.referrerHost, null);
  assert.equal(record.utmSource, null);
  assert.equal(record.browser, 'consent_essential');
});

test('AN-06: analytics consent captures attribution, device and visitor hash', () => {
  const record = analytics.buildClickRecord({
    consentMode: 'analytics',
    req: {
      ip: '203.0.113.9',
      headers: { 'user-agent': CHROME_UA, referer: 'https://news.example/post', host: 'ovlink.sbs' },
      query: { utm_source: 'linkedin', utm_campaign: 'spring' },
      get(name) { return this.headers[String(name).toLowerCase()] || ''; },
    },
  });

  assert.equal(record.analyticsAllowed, true);
  assert.equal(record.browser, 'Chrome');
  assert.equal(record.os, 'Windows');
  assert.equal(record.deviceType, 'desktop');
  assert.equal(record.isBot, 0);
  assert.equal(record.referrerHost, 'news.example');
  assert.equal(record.utmSource, 'linkedin');
  assert.equal(record.utmCampaign, 'spring');
  assert.ok(record.ipHash && record.ipHash.length > 0, 'visitor hash must be present');
  assert.notEqual(record.ipHash, '203.0.113.9', 'raw IP must never be persisted');
});

test('AN-07: the daily rollup statement increments every counter in one write', () => {
  const statement = analytics.buildRollupStatement(
    { clickTime: '2026-10-31T10:20:30.000Z', isBot: 1 },
    42,
    1
  );
  assert.ok(statement.sql.includes('ON CONFLICT (url_id, day) DO UPDATE'));
  assert.equal(statement.params.length, 6);
  assert.equal(statement.params[0], 42);
  assert.equal(statement.params[1], '2026-10-31');
  assert.equal(statement.params[2], 1);
  assert.equal(statement.params[3], 1);
});

test('AN-09: conversion goals are normalized and bounded', () => {
  assert.equal(analytics.normalizeGoal('Signup'), 'signup');
  assert.equal(analytics.normalizeGoal('newsletter-2026'), 'newsletter-2026');
  assert.equal(analytics.normalizeGoal('lead_form'), 'lead_form');
  assert.equal(analytics.normalizeGoal('bad goal!'), 'default');
  assert.equal(analytics.normalizeGoal(''), 'default');
  assert.equal(analytics.normalizeGoal(undefined), 'default');
  assert.equal(analytics.normalizeGoal('x'.repeat(41)), 'default');
});

test('AN-11: bots never record conversions', async () => {
  const result = await analytics.recordConversion({
    urlId: 5,
    goal: 'signup',
    req: { headers: { 'user-agent': 'curl/8.4.0' } },
  });
  assert.equal(result.recorded, false, 'a bot pixel hit must not count');
  assert.equal(result.reason, 'bot');

  const missingAgent = await analytics.recordConversion({
    urlId: 5,
    goal: 'signup',
    req: { headers: {} },
  });
  assert.equal(missingAgent.recorded, false, 'a UA-less request is automation too');
});

// Regression: the stats service referenced an undeclared range variable, which
// turned every /api/stats call into a 500. It must build a payload even when no
// database is reachable (queries then resolve to empty sets).
test('AN-12: loadLinkStats always resolves a payload', async () => {
  const payload = await linkStats.loadLinkStats({
    urlRow: { id: 1, short: 'abc123', original: 'https://example.com', created_at: null, max_clicks: null, disabled: 0 },
    query: { days: 7 },
  });

  assert.equal(payload.short, 'abc123');
  assert.equal(payload.range.days, 7);
  assert.ok(Array.isArray(payload.clicks_by_day));
  assert.ok(payload.clicks_by_day.length >= 7, 'the day series must cover the window');
  assert.equal(typeof payload.conversion_pixel_path, 'string');
  assert.equal(payload.conversion_pixel_path, '/c/abc123.gif');
});

// ---------------------------------------------------------------------------
// End-to-end capture + stats API
// ---------------------------------------------------------------------------

test('AN-08: clicks are attributed, deduplicated per visitor and served by /api/stats', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }

  const email = `analytics-${Date.now()}@example.com`;
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), passwordHash, 'free', 'active', new Date().toISOString()]
  );
  const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  assert.ok(user && user.id, 'test user must exist');
  createdUserIds.push(user.id);

  const short = uniqueShort('anl');
  const inserted = await helpers.dbRunAsync(
    'INSERT INTO urls (original, short, created_at, user_id) VALUES (?, ?, ?, ?)',
    ['https://example.com/destination', short, new Date().toISOString(), user.id]
  );
  createdShorts.push(short);
  const urlId = inserted.lastID;

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function click(headers) {
    const res = await fetch(`${baseUrl}/${short}${headers.query || ''}`, {
      headers: {
        Cookie: CONSENT_COOKIE,
        'user-agent': headers.userAgent || CHROME_UA,
        ...(headers.referer ? { referer: headers.referer } : {}),
      },
      redirect: 'manual',
    });
    return res;
  }

  async function waitForClicks(expected) {
    const deadline = Date.now() + 8000;
    let count = 0;
    while (Date.now() < deadline) {
      const row = await helpers.dbGetAsync('SELECT COUNT(*) AS c FROM clicks WHERE url_id = ?', [urlId]);
      count = row ? Number(row.c || 0) : 0;
      if (count >= expected) return count;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return count;
  }

  async function getCsrfSession() {
    const res = await fetch(`${baseUrl}/api/csrf`);
    const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
    const sidCookie = setCookies
      .map((c) => (c ? c.split(';')[0] : ''))
      .find((c) => c.startsWith('connect.sid='));
    const { csrfToken } = await res.json();
    return { cookie: sidCookie, csrfToken };
  }

  async function loginSession() {
    const { cookie, csrfToken } = await getCsrfSession();
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ email, password: TEST_PASSWORD, lang: 'en' }),
    });
    assert.equal(res.status, 200, 'login must succeed');
    const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
    const sidCookie = setCookies
      .map((c) => (c ? c.split(';')[0] : ''))
      .find((c) => c.startsWith('connect.sid='));
    const finalCookie = sidCookie || cookie;
    // The CSRF token is bound to the session id, which login rotated.
    const csrfRes = await fetch(`${baseUrl}/api/csrf`, { headers: { Cookie: finalCookie } });
    const { csrfToken: freshToken } = await csrfRes.json().catch(() => ({}));
    return { cookie: finalCookie, csrfToken: freshToken || '' };
  }

  try {
    await t.test('1. the redirect records attribution without storing the raw IP', async () => {
      const res = await click({
        query: '?utm_source=LinkedIn&utm_campaign=Spring',
        referer: 'https://news.example/article',
      });
      assert.equal(res.status, 302);
      const count = await waitForClicks(1);
      assert.equal(count, 1, 'one click row must be written');

      const row = await helpers.dbGetAsync('SELECT * FROM clicks WHERE url_id = ? ORDER BY id DESC LIMIT 1', [urlId]);
      assert.equal(row.referrer_host, 'news.example');
      assert.equal(row.utm_source, 'linkedin');
      assert.equal(row.utm_campaign, 'spring');
      assert.equal(row.device_type, 'desktop');
      assert.equal(Number(row.is_bot), 0);
      assert.equal(row.ip, null, 'raw IP must never be stored');
      assert.ok(row.ip_hash, 'visitor hash must be stored');
    });

    await t.test('2. the same visitor counts once per day, bots are flagged', async () => {
      await click({ userAgent: IPHONE_UA });
      await click({ userAgent: BOT_UA });
      const count = await waitForClicks(3);
      assert.equal(count, 3);

      // The rollup is written after the click row, so poll for it instead of
      // assuming both statements landed before the count above.
      let rollup = null;
      const rollupDeadline = Date.now() + 5000;
      while (Date.now() < rollupDeadline) {
        rollup = await helpers.dbGetAsync('SELECT clicks, uniques, bots FROM link_stats_daily WHERE url_id = ?', [urlId]);
        if (rollup && Number(rollup.clicks) >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(rollup, 'daily rollup row must exist');
      assert.equal(Number(rollup.clicks), 3);
      assert.equal(Number(rollup.uniques), 1, 'repeat visits from one network are one unique');
      assert.equal(Number(rollup.bots), 1, 'the bot click must be counted separately');

      const mobileRow = await helpers.dbGetAsync(
        "SELECT device_type, is_bot FROM clicks WHERE url_id = ? AND device_type = 'mobile' ORDER BY id DESC LIMIT 1",
        [urlId]
      );
      assert.ok(mobileRow, 'mobile click must be attributed as mobile');
      assert.equal(Number(mobileRow.is_bot), 0);
    });

    await t.test('3. /api/stats serves real unique visitors, sources and ranges', async () => {
      const { cookie } = await loginSession();

      const res = await fetch(`${baseUrl}/api/stats/${short}`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      const stats = await res.json();

      assert.equal(stats.short, short);
      assert.equal(stats.clicks_total, 3);
      assert.equal(stats.total_clicks, 3);
      assert.equal(stats.unique_visitors, 1, 'unique visitors must be real, not a ratio of clicks');
      assert.equal(stats.bots_total, 1);
      assert.ok(Array.isArray(stats.uniques_by_day) && stats.uniques_by_day.length >= 1);
      assert.equal(stats.sources['news.example'], 1);
      assert.equal(stats.sources.direct, 2, 'clicks without a referrer are direct traffic');
      assert.equal(stats.campaigns['spring'], 1);
      assert.equal(stats.devices.mobile, 1);
      assert.ok(stats.devices.desktop >= 1);
      assert.equal(stats.raw_clicks.length, 3);
      assert.equal(stats.raw_clicks_has_more, false);
      assert.ok(Array.isArray(stats.top_referrers) && stats.top_referrers.length >= 2);
      assert.equal(stats.top_referrers[0].name, 'direct');
      assert.ok(stats.top_referrers.some((item) => item.name === 'news.example'));
      assert.equal(stats.range.bots, 'include');
    });

    await t.test('4. bots can be excluded from the reported numbers', async () => {
      const { cookie } = await loginSession();
      const res = await fetch(`${baseUrl}/api/stats/${short}?bots=exclude&days=1`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      const stats = await res.json();
      assert.equal(stats.total_clicks, 2, 'the bot click must be filtered out');
      assert.equal(stats.range.bots, 'exclude');
      assert.equal(stats.range.days, 1);
      assert.equal(stats.clicks_total, 3, 'all-time totals stay intact');
    });

    await t.test('5. another user cannot read the stats', async () => {
      const otherEmail = `analytics-other-${Date.now()}@example.com`;
      await helpers.dbRunAsync(
        'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
        [encryptAES256GCM(otherEmail), blindIndex(otherEmail), await bcrypt.hash(TEST_PASSWORD, 10), 'free', 'active', new Date().toISOString()]
      );
      const other = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(otherEmail)]);
      createdUserIds.push(other.id);

      const { cookie, csrfToken } = await getCsrfSession();
      const loginRes = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ email: otherEmail, password: TEST_PASSWORD, lang: 'en' }),
      });
      assert.equal(loginRes.status, 200);
      const setCookies = (typeof loginRes.headers.getSetCookie === 'function' ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')]) || [];
      const sidCookie = setCookies
        .map((c) => (c ? c.split(';')[0] : ''))
        .find((c) => c.startsWith('connect.sid='));

      const res = await fetch(`${baseUrl}/api/stats/${short}`, { headers: { Cookie: sidCookie || cookie } });
      assert.equal(res.status, 404, 'foreign links must not leak statistics');
    });

    await t.test('6. unknown short codes are rejected', async () => {
      const { cookie } = await loginSession();
      const res = await fetch(`${baseUrl}/api/stats/${uniqueShort('nope')}`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 404);
    });

    await t.test('7. click-level CSV export is available to the owner', async () => {
      const { cookie } = await loginSession();
      const res = await fetch(`${baseUrl}/api/stats/${short}/export?format=csv&days=all`, {
        headers: { Cookie: cookie },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/csv/);
      const body = await res.text();
      const lines = body.replace(/^\uFEFF/, '').trim().split('\r\n');
      assert.equal(lines.length, 4, 'header + three click rows');
      assert.ok(lines[0].includes('utm_campaign'), 'header must document attribution columns');
      assert.ok(body.includes('news.example'), 'referrer must be exported');
    });

    await t.test('8. the Pro API exposes the same numbers to an API key', async () => {
      await helpers.dbRunAsync(
        "UPDATE users SET plan_tier = 'pro', plan_status = 'active', pro_expires_at = ? WHERE id = ?",
        [new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), user.id]
      );

      const rawKey = `ovk_${crypto.randomBytes(32).toString('base64url')}`;
      await helpers.dbRunAsync(
        'INSERT INTO api_keys (user_id, name, scopes, key_hash, hash_version, key_prefix, last4, created_at) VALUES (?, ?, ?, ?, 2, ?, ?, ?)',
        [
          user.id,
          'analytics-test',
          'account:read,shorten:write,webhooks:read,webhooks:write',
          helpers.hashApiKeyValue(rawKey),
          rawKey.slice(0, 12),
          rawKey.slice(-4),
          new Date().toISOString(),
        ]
      );

      const res = await fetch(`${baseUrl}/api/pro/v1/links/${short}/stats?days=30`, {
        headers: { 'x-api-key': rawKey },
      });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.clicks_total, 3);
      assert.equal(payload.unique_visitors, 1);
      assert.equal(payload.sources['news.example'], 1);
      assert.equal(payload.raw_clicks, undefined, 'the Pro API must not ship raw rows by default');

      const clicksRes = await fetch(`${baseUrl}/api/pro/v1/links/${short}/clicks?format=json`, {
        headers: { 'x-api-key': rawKey },
      });
      assert.equal(clicksRes.status, 200);
      const clicksPayload = await clicksRes.json();
      assert.equal(clicksPayload.count, 3);

      const otherShort = await fetch(`${baseUrl}/api/pro/v1/links/${uniqueShort('nope')}/stats`, {
        headers: { 'x-api-key': rawKey },
      });
      assert.equal(otherShort.status, 404, 'unknown links must not leak through the API');
    });
    await t.test('9. the conversion pixel records deduplicated goals', async () => {
      const first = await fetch(`${baseUrl}/c/${short}.gif?goal=signup`, {
        headers: { 'user-agent': CHROME_UA },
      });
      assert.equal(first.status, 200);
      assert.match(first.headers.get('content-type') || '', /image\/gif/);

      // Same visitor again: must dedupe, not double count.
      const second = await fetch(`${baseUrl}/c/${short}.gif?goal=signup`, {
        headers: { 'user-agent': CHROME_UA },
      });
      assert.equal(second.status, 200);

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const row = await helpers.dbGetAsync('SELECT COUNT(*) AS c FROM link_conversions WHERE url_id = ?', [urlId]);
        if (row && Number(row.c) >= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const convRow = await helpers.dbGetAsync('SELECT COUNT(*) AS c FROM link_conversions WHERE url_id = ?', [urlId]);
      assert.equal(Number(convRow.c), 1, 'repeat pixel hits from one visitor must dedupe');

      const { cookie } = await loginSession();
      const res = await fetch(`${baseUrl}/api/stats/${short}?days=30`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.conversions_total, 1);
      assert.equal(payload.conversions_range, 1);
      assert.equal(payload.goals.signup, 1);
      assert.ok(payload.conversion_rate > 0, 'conversion rate must be computed');
      assert.equal(payload.conversion_pixel_path, `/c/${short}.gif`);
    });

    await t.test('10. shared report links are expiring, read-only and revocable', async () => {
      const { cookie, csrfToken } = await loginSession();

      const createRes = await fetch(`${baseUrl}/api/stats/${short}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ days: 7 }),
      });
      assert.equal(createRes.status, 200, 'share creation must succeed');
      const share = await createRes.json();
      assert.ok(share.url && share.embed_url && share.embed_code, 'share payload must include urls + embed code');
      assert.equal(share.days, 7);

      const shareToken = new URL(share.url).searchParams.get('token');
      assert.ok(shareToken && shareToken.length >= 20, 'share token must be present');

      const publicRes = await fetch(`${baseUrl}/api/stats/shared/${short}?token=${encodeURIComponent(shareToken)}`);
      assert.equal(publicRes.status, 200);
      const publicPayload = await publicRes.json();
      assert.equal(publicPayload.clicks_total, 3);
      assert.equal(publicPayload.raw_clicks, undefined, 'shared payload must never ship click rows');
      assert.equal(publicPayload.range.days, 7, 'shared link is pinned to its own window');

      const badToken = await fetch(`${baseUrl}/api/stats/shared/${short}?token=not-a-real-token-value`);
      assert.equal(badToken.status, 404, 'invalid tokens must not resolve');

      const pageRes = await fetch(`${baseUrl}/stats/shared/${short}?token=${encodeURIComponent(shareToken)}`);
      assert.equal(pageRes.status, 200);
      assert.match(pageRes.headers.get('content-type') || '', /text\/html/);
      assert.ok((await pageRes.text()).includes('Ovlink Analytics'));

      const embedRes = await fetch(`${baseUrl}/embed/${short}?token=${encodeURIComponent(shareToken)}`);
      assert.equal(embedRes.status, 200);
      assert.ok((await embedRes.text()).includes('Powered by Ovlink'));
      assert.match(embedRes.headers.get('content-security-policy') || '', /frame-ancestors \*/);

      const revokeRes = await fetch(`${baseUrl}/api/stats/${short}/share/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ id: share.id }),
      });
      assert.equal(revokeRes.status, 200);

      const afterRevoke = await fetch(`${baseUrl}/api/stats/shared/${short}?token=${encodeURIComponent(shareToken)}`);
      assert.equal(afterRevoke.status, 404, 'revoked shares must stop working immediately');
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
