const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '4f9a1c2b8e7d6053a1f0c9b82d7e4156a3c8f0d2b6e4917c5a0d3f8e2b4c6a9d';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');
const { ensureDbTables } = require('../src/db/migrate');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');
const { buildStatsReportContent } = require('../src/lib/email');
const statsReport = require('../src/lib/stats-report');

const TEST_PASSWORD = 'ReportTestPass123!';
const createdUserIds = [];
const createdShorts = [];
let hasPostgres = false;

function uniqueShort(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function dayIso(offsetDays) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

test.before(async () => {
  try {
    await helpers.dbGetAsync('SELECT 1');
    hasPostgres = true;
  } catch {
    hasPostgres = false;
  }
  if (hasPostgres) {
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
    try { await helpers.dbRunAsync('DELETE FROM link_stats_daily WHERE url_id IN (SELECT id FROM urls WHERE short = ?)', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM urls WHERE short = ?', [short]); } catch {}
  }
  for (const userId of createdUserIds) {
    try { await helpers.dbRunAsync('DELETE FROM link_stats_daily WHERE url_id IN (SELECT id FROM urls WHERE user_id = ?)', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM clicks WHERE url_id IN (SELECT id FROM urls WHERE user_id = ?)', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM urls WHERE user_id = ?', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM user_sessions WHERE user_id = ?', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [userId]); } catch {}
  }
  const deadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { await helpers.closeDbPool(); } catch {}
});

test('SR-01: the weekly report e-mail escapes user data and shows the delta', () => {
  const summary = {
    days: 7,
    period_from: '2026-10-24',
    period_to: '2026-10-31',
    clicks: 42,
    uniques: 17,
    conversions: 5,
    conversion_rate: 11.9,
    previous: { clicks: 21, uniques: 9 },
    deltas: { clicks_percent: 100, uniques_percent: 88.9 },
    top_links: [{ short: '<script>alert(1)</script>', clicks: 12, uniques: 5 }],
    top_source: 'linkedin.com',
    dashboard_url: 'https://ovlink.sbs/dashboard',
  };

  const en = buildStatsReportContent(summary, 'en');
  assert.equal(en.subject, 'Ovlink weekly report: 42 clicks');
  assert.ok(en.html.includes('+100%'), 'delta must be rendered');
  assert.ok(en.html.includes('11.9%'), 'conversion rate must be rendered');
  assert.ok(en.html.includes('linkedin.com'), 'top source must be rendered');
  assert.equal(en.html.includes('<script>alert(1)</script>'), false, 'short codes must be escaped');
  assert.ok(en.html.includes('&lt;script&gt;'), 'escaped short code must be present');
  assert.ok(en.text.includes('Clicks: 42'));

  const az = buildStatsReportContent(summary, 'az');
  assert.ok(az.subject.includes('42'), 'localized subject must include the count');

  const empty = buildStatsReportContent({ ...summary, clicks: 0, top_links: [] }, 'en');
  assert.ok(empty.html.includes('No clicks in this period.'), 'empty state must be explicit');
});

test('SR-02: opt-in flags are parsed strictly', () => {
  assert.equal(statsReport.readReportFlag(true), true);
  assert.equal(statsReport.readReportFlag('true'), true);
  assert.equal(statsReport.readReportFlag('1'), true);
  assert.equal(statsReport.readReportFlag('on'), true);
  assert.equal(statsReport.readReportFlag(false), false);
  assert.equal(statsReport.readReportFlag('false'), false);
  assert.equal(statsReport.readReportFlag('0'), false);
  assert.equal(statsReport.readReportFlag(undefined), false);
});

test('SR-03: the weekly summary aggregates the rollup and compares windows', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }

  const email = `report-${Date.now()}@example.com`;
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), await bcrypt.hash(TEST_PASSWORD, 10), 'free', 'active', new Date().toISOString()]
  );
  const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdUserIds.push(user.id);

  const short = uniqueShort('rep');
  const inserted = await helpers.dbRunAsync(
    'INSERT INTO urls (original, short, created_at, user_id) VALUES (?, ?, ?, ?)',
    ['https://example.com/destination', short, new Date().toISOString(), user.id]
  );
  createdShorts.push(short);
  const urlId = inserted.lastID;

  const insertRollup = (day, clicks, uniques, conversions) =>
    helpers.dbRunAsync(
      'INSERT INTO link_stats_daily (url_id, day, clicks, uniques, bots, conversions, first_click_at, last_click_at) ' +
        'VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
      [urlId, day, clicks, uniques, conversions, new Date().toISOString(), new Date().toISOString()]
    );

  await insertRollup(dayIso(-1), 3, 2, 1);
  await insertRollup(dayIso(-4), 2, 1, 1);
  await insertRollup(dayIso(-9), 1, 1, 0); // previous window

  await helpers.dbRunAsync(
    'INSERT INTO clicks (url_id, click_time, browser, os, country, referrer_host, is_bot) VALUES (?, ?, ?, ?, ?, ?, 0)',
    [urlId, new Date().toISOString(), 'Chrome', 'Linux', 'AZ', 'news.example']
  );

  const summary = await statsReport.loadWeeklySummary(user.id);
  assert.ok(summary, 'summary must be produced');
  assert.equal(summary.clicks, 5, 'only the current window counts');
  assert.equal(summary.uniques, 3);
  assert.equal(summary.conversions, 2);
  assert.equal(summary.conversion_rate, 40);
  assert.equal(summary.previous.clicks, 1, 'previous window is included for the delta');
  assert.equal(summary.deltas.clicks_percent, 400);
  assert.equal(summary.top_links.length, 1);
  assert.equal(summary.top_links[0].short, short);
  assert.equal(summary.top_source, 'news.example');
});

test('SR-04: users can opt in and out of the weekly digest', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }

  const email = `report-toggle-${Date.now()}@example.com`;
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), await bcrypt.hash(TEST_PASSWORD, 10), 'free', 'active', new Date().toISOString()]
  );
  const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdUserIds.push(user.id);

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

  async function login() {
    const { cookie, csrfToken } = await getCsrfSession();
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ email, password: TEST_PASSWORD, lang: 'en' }),
    });
    assert.equal(res.status, 200);
    const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
    const sidCookie = setCookies
      .map((c) => (c ? c.split(';')[0] : ''))
      .find((c) => c.startsWith('connect.sid='));
    const finalCookie = sidCookie || cookie;
    const csrfRes = await fetch(`${baseUrl}/api/csrf`, { headers: { Cookie: finalCookie } });
    const { csrfToken: fresh } = await csrfRes.json().catch(() => ({}));
    return { cookie: finalCookie, csrfToken: fresh || '' };
  }

  try {
    const { cookie, csrfToken } = await login();

    const initial = await fetch(`${baseUrl}/api/user/stats-report`, { headers: { Cookie: cookie } });
    assert.equal(initial.status, 200);
    assert.equal((await initial.json()).enabled, false, 'digest is opt-in');

    const enable = await fetch(`${baseUrl}/api/user/stats-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(enable.status, 200);
    assert.equal((await enable.json()).enabled, true);

    const afterEnable = await fetch(`${baseUrl}/api/user/stats-report`, { headers: { Cookie: cookie } });
    assert.equal((await afterEnable.json()).enabled, true);

    const disable = await fetch(`${baseUrl}/api/user/stats-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disable.status, 200);
    assert.equal((await disable.json()).enabled, false);

    const unauth = await fetch(`${baseUrl}/api/user/stats-report`);
    assert.equal(unauth.status, 401, 'anonymous callers must be rejected');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
