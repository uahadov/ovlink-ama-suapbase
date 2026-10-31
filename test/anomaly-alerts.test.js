const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '4f9a1c2b8e7d6053a1f0c9b82d7e4156a3c8f0d2b6e4917c5a0d3f8e2b4c6a9d';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.ALERT_WEBHOOK_URL = '';

const { app, helpers } = require('../server');
const { ensureDbTables } = require('../src/db/migrate');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');
const anomalyAlerts = require('../src/lib/anomaly-alerts');

const TEST_PASSWORD = 'AnomalyTestPass123!';
const createdUserIds = [];
const createdShorts = [];
let hasPostgres = false;

function uniqueShort(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function dayIso(offsetDays) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Builds a series of `days` baseline points plus today. */
function buildSeries(baselineClicks, todayClicks, days = 7) {
  const series = [];
  for (let offset = days; offset >= 1; offset -= 1) {
    series.push({ day: dayIso(-offset), clicks: baselineClicks });
  }
  series.push({ day: dayIso(0), clicks: todayClicks });
  return series;
}

function atUtcHour(hour) {
  const now = new Date();
  now.setUTCHours(hour, 0, 0, 0);
  return now;
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
    try { await helpers.dbRunAsync('DELETE FROM notifications WHERE link_short = ?', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM clicks WHERE url_id IN (SELECT id FROM urls WHERE short = ?)', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM link_stats_daily WHERE url_id IN (SELECT id FROM urls WHERE short = ?)', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM urls WHERE short = ?', [short]); } catch {}
  }
  for (const userId of createdUserIds) {
    try { await helpers.dbRunAsync('DELETE FROM notifications WHERE user_id = ?', [userId]); } catch {}
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

test('AL-01: a spike needs both an absolute floor and a multiple of the baseline', () => {
  const now = atUtcHour(20);

  const spike = anomalyAlerts.detectSeriesAnomalies(buildSeries(4, 40), {}, { now });
  assert.ok(spike.some((flag) => flag.kind === 'spike'), 'a 10x jump must be flagged');
  const flag = spike.find((item) => item.kind === 'spike');
  assert.equal(flag.clicks, 40);
  assert.equal(flag.baseline_average, 4);
  assert.equal(flag.delta_percent, 900);

  // Same ratio, but under the absolute floor: small links stay quiet.
  const quiet = anomalyAlerts.detectSeriesAnomalies(buildSeries(1, 6), {}, { now });
  assert.equal(quiet.some((item) => item.kind === 'spike'), false);

  // No history at all: nothing to compare against, so nothing is claimed.
  const noBaseline = anomalyAlerts.detectSeriesAnomalies(buildSeries(0, 60), {}, { now });
  assert.equal(noBaseline.length, 0);

  // A new link (only two points) cannot be judged yet.
  const tooShort = anomalyAlerts.detectSeriesAnomalies(buildSeries(4, 40, 1), {}, { now });
  assert.equal(tooShort.length, 0);
});

test('AL-02: drops are only reported once the day is mature', () => {
  const early = atUtcHour(6);
  const late = atUtcHour(20);

  const earlyFlags = anomalyAlerts.detectSeriesAnomalies(buildSeries(20, 2), {}, { now: early });
  assert.equal(earlyFlags.some((item) => item.kind === 'drop'), false, 'morning scans must not cry drop');

  const lateFlags = anomalyAlerts.detectSeriesAnomalies(buildSeries(20, 2), {}, { now: late });
  const drop = lateFlags.find((item) => item.kind === 'drop');
  assert.ok(drop, 'a 90% drop after midday must be flagged');
  assert.equal(drop.severity, 'critical');
  assert.equal(drop.delta_percent, -90);

  // Historical (non-today) days are judged without the time-of-day gate.
  const historical = anomalyAlerts.detectSeriesAnomalies(
    [
      { day: dayIso(-9), clicks: 20 },
      { day: dayIso(-8), clicks: 20 },
      { day: dayIso(-7), clicks: 20 },
      { day: dayIso(-6), clicks: 1 },
      { day: dayIso(-5), clicks: 20 },
      { day: dayIso(-4), clicks: 20 },
      { day: dayIso(-3), clicks: 20 },
    ],
    {},
    { now: early }
  );
  assert.ok(historical.some((item) => item.kind === 'drop' && item.day === dayIso(-6)));
});

test('AL-03: payloads are localized and dedupe keys are per link per day', () => {
  const spike = anomalyAlerts.buildAnomalyPayload(
    { kind: 'spike', day: '2026-10-31', clicks: 40, baseline_average: 4, delta_percent: 900 },
    { short: 'abc123' }
  );
  assert.equal(spike.titleEn, 'Click spike');
  assert.ok(spike.bodyEn.includes('40'));
  assert.ok(spike.bodyAz.includes('40'));
  assert.ok(spike.bodyTr.includes('40'));
  assert.equal(spike.eventKey, 'anomaly_spike_abc123_2026-10-31');

  const sameDayAgain = anomalyAlerts.buildAnomalyPayload(
    { kind: 'spike', day: '2026-10-31', clicks: 41, baseline_average: 4, delta_percent: 925 },
    { short: 'abc123' }
  );
  assert.equal(sameDayAgain.eventKey, spike.eventKey, 'the key must not depend on the count');

  const nextDay = anomalyAlerts.buildAnomalyPayload(
    { kind: 'spike', day: '2026-11-01', clicks: 40, baseline_average: 4, delta_percent: 900 },
    { short: 'abc123' }
  );
  assert.notEqual(nextDay.eventKey, spike.eventKey);

  const limit = anomalyAlerts.buildAnomalyPayload(
    { kind: 'limit', day: '2026-10-31', percent: 85, clicks: 85, baseline_average: 100 },
    { short: 'abc123' }
  );
  assert.equal(limit.eventKey, 'anomaly_limit_abc123_2026-10-31');
  assert.ok(limit.bodyEn.includes('85%'));

  const health = anomalyAlerts.buildAnomalyPayload(
    { kind: 'health', day: '2026-10-31', reason: 'http_404' },
    { short: 'abc123' }
  );
  assert.equal(health.eventKey, 'anomaly_health_abc123_2026-10-31');
  assert.ok(health.bodyEn.includes('http_404'));

  assert.equal(anomalyAlerts.buildAnomalyPayload({ kind: 'unknown' }, { short: 'abc' }), null);
});

test('AL-04: destination probes refuse private targets and classify statuses', async () => {
  assert.equal(await anomalyAlerts.resolveDestinationTarget('http://127.0.0.1/admin'), null);
  assert.equal(await anomalyAlerts.resolveDestinationTarget('http://localhost:3000/'), null);
  assert.equal(await anomalyAlerts.resolveDestinationTarget('http://169.254.169.254/latest/meta-data/'), null);
  assert.equal(await anomalyAlerts.resolveDestinationTarget('file:///etc/passwd'), null);
  assert.equal(await anomalyAlerts.resolveDestinationTarget('not a url'), null);

  const blocked = await anomalyAlerts.probeDestination('http://127.0.0.1:6379/');
  assert.equal(blocked.ok, null, 'unprobeable targets must never be reported as down');
  assert.equal(blocked.reason, 'not_probeable');

  assert.deepEqual(anomalyAlerts.classifyStatus(204), { ok: true, status: 204, reason: '' });
  assert.deepEqual(anomalyAlerts.classifyStatus(301), { ok: true, status: 301, reason: '' });
  assert.deepEqual(anomalyAlerts.classifyStatus(404), { ok: false, status: 404, reason: 'http_404' });
  assert.deepEqual(anomalyAlerts.classifyStatus(503), { ok: false, status: 503, reason: 'http_503' });
  assert.equal(anomalyAlerts.classifyStatus(0).ok, false);
});

test('AL-05: invalid owners are rejected before any write', async () => {
  assert.equal(await anomalyAlerts.insertAnomalyNotification(0, { eventKey: 'x' }), false);
  assert.equal(await anomalyAlerts.insertAnomalyNotification('nope', { eventKey: 'x' }), false);
  assert.equal(await anomalyAlerts.insertAnomalyNotification(1, null), false);
  assert.equal(await anomalyAlerts.insertAnomalyNotification(1, { eventKey: '' }), false);
});

test('AL-06: the scan notifies the owner exactly once per anomaly', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }

  const email = `anomaly-${Date.now()}@example.com`;
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), await bcrypt.hash(TEST_PASSWORD, 10), 'free', 'active', new Date().toISOString()]
  );
  const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdUserIds.push(user.id);

  const short = uniqueShort('ano');
  const inserted = await helpers.dbRunAsync(
    'INSERT INTO urls (original, short, created_at, user_id, disabled) VALUES (?, ?, ?, ?, 0)',
    ['https://example.com/landing', short, new Date().toISOString(), user.id]
  );
  createdShorts.push(short);
  const urlId = inserted.lastID;

  const now = atUtcHour(20);
  const insertRollup = (day, clicks) =>
    helpers.dbRunAsync(
      'INSERT INTO link_stats_daily (url_id, day, clicks, uniques, bots, conversions, first_click_at, last_click_at) ' +
        'VALUES (?, ?, ?, ?, 0, 0, ?, ?)',
      [urlId, day, clicks, clicks, new Date().toISOString(), new Date().toISOString()]
    );

  for (let offset = 7; offset >= 1; offset -= 1) {
    await insertRollup(dayIso(-offset), 4);
  }
  await insertRollup(dayIso(0), 40);

  const settings = { healthEnabled: false };
  const first = await anomalyAlerts.runAnomalyScan({ now, settings });
  assert.ok(first.clicks.scanned >= 1);

  const rows = await helpers.dbAllAsync(
    "SELECT id, type, event_key, title_en, body_en, link_short FROM notifications WHERE user_id = ? AND type = 'anomaly' ORDER BY id ASC",
    [user.id]
  );
  assert.equal(rows.length, 1, 'one spike => one notification');
  assert.equal(rows[0].event_key, `anomaly_spike_${short}_${dayIso(0)}`);
  assert.ok(rows[0].body_en.includes('40'));

  // A second scan the same day must not duplicate the row.
  await anomalyAlerts.runAnomalyScan({ now, settings });
  const again = await helpers.dbAllAsync(
    "SELECT id FROM notifications WHERE user_id = ? AND type = 'anomaly'",
    [user.id]
  );
  assert.equal(again.length, 1, 'dedupe via event_key must hold');

  // Insights are read-only and mirror the stored rollup.
  const insights = await anomalyAlerts.loadLinkAnomalyInsights(urlId, { days: 14, now });
  assert.ok(insights.series.length >= 8);
  assert.ok(insights.anomalies.some((flag) => flag.kind === 'spike' && flag.day === dayIso(0)));
  assert.equal(insights.thresholds.baseline_days, 7);
});

test('AL-07: GET /api/stats/:short/anomalies is owner scoped', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }

  const email = `anomaly-api-${Date.now()}@example.com`;
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), await bcrypt.hash(TEST_PASSWORD, 10), 'free', 'active', new Date().toISOString()]
  );
  const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdUserIds.push(user.id);

  const short = uniqueShort('anoapi');
  const inserted = await helpers.dbRunAsync(
    'INSERT INTO urls (original, short, created_at, user_id) VALUES (?, ?, ?, ?)',
    ['https://example.com/landing', short, new Date().toISOString(), user.id]
  );
  createdShorts.push(short);
  await helpers.dbRunAsync(
    'INSERT INTO link_stats_daily (url_id, day, clicks, uniques, bots, conversions, first_click_at, last_click_at) ' +
      'VALUES (?, ?, 3, 2, 0, 0, ?, ?)',
    [inserted.lastID, dayIso(-1), new Date().toISOString(), new Date().toISOString()]
  );

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function login() {
    const csrfRes = await fetch(`${baseUrl}/api/csrf`);
    const setCookies = (typeof csrfRes.headers.getSetCookie === 'function' ? csrfRes.headers.getSetCookie() : [csrfRes.headers.get('set-cookie')]) || [];
    const sidCookie = setCookies.map((c) => (c ? c.split(';')[0] : '')).find((c) => c.startsWith('connect.sid='));
    const { csrfToken } = await csrfRes.json();
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sidCookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ email, password: TEST_PASSWORD, lang: 'en' }),
    });
    assert.equal(res.status, 200);
    const loginCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
    const freshSid = loginCookies.map((c) => (c ? c.split(';')[0] : '')).find((c) => c.startsWith('connect.sid='));
    return freshSid || sidCookie;
  }

  try {
    const unauth = await fetch(`${baseUrl}/api/stats/${short}/anomalies`);
    assert.equal(unauth.status, 401);

    const cookie = await login();
    const res = await fetch(`${baseUrl}/api/stats/${short}/anomalies?days=14`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.series));
    assert.ok(Array.isArray(body.anomalies));
    assert.ok(body.destination && typeof body.destination === 'object');
    assert.equal(body.thresholds.baseline_days, 7);

    const missing = await fetch(`${baseUrl}/api/stats/doesnotexist999/anomalies`, { headers: { Cookie: cookie } });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
