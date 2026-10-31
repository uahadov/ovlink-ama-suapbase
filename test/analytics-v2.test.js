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
const audit = require('../src/lib/analytics-audit');
const campaigns = require('../src/lib/campaigns');

const TEST_PASSWORD = 'AnalyticsV2Pass123!';
const createdShorts = [];
const createdUserIds = [];
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
  if (!hasPostgres) return;
  ensureDbTables();
  const deadline = Date.now() + 20000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test.after(async () => {
  for (const short of createdShorts) {
    try { await helpers.dbRunAsync('DELETE FROM clicks WHERE url_id IN (SELECT id FROM urls WHERE short = ?)', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM click_uniques WHERE url_id IN (SELECT id FROM urls WHERE short = ?)', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM link_stats_daily WHERE url_id IN (SELECT id FROM urls WHERE short = ?)', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM link_funnel_steps WHERE url_id IN (SELECT id FROM urls WHERE short = ?)', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM link_alert_settings WHERE url_id IN (SELECT id FROM urls WHERE short = ?)', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM analytics_audit_log WHERE short = ?', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM urls WHERE short = ?', [short]); } catch {}
  }
  for (const userId of createdUserIds) {
    try { await helpers.dbRunAsync('DELETE FROM saved_segments WHERE user_id = ?', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM user_sessions WHERE user_id = ?', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [userId]); } catch {}
  }
  const deadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { await helpers.closeDbPool(); } catch {}
});

async function seedUser(plan = 'free') {
  const email = `av2-${plan}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const proExpires = plan === 'pro' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null;
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, pro_expires_at, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), await bcrypt.hash(TEST_PASSWORD, 10), plan, 'active', proExpires, new Date().toISOString()]
  );
  const row = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdUserIds.push(row.id);
  return { id: row.id, email };
}

async function seedLink(userId, prefix = 'av2') {
  const short = uniqueShort(prefix);
  const inserted = await helpers.dbRunAsync(
    'INSERT INTO urls (original, short, created_at, user_id) VALUES (?, ?, ?, ?)',
    ['https://example.com/landing', short, new Date().toISOString(), userId]
  );
  createdShorts.push(short);
  return { short, id: inserted.lastID };
}

async function login(baseUrl, email) {
  const csrfRes = await fetch(`${baseUrl}/api/csrf`);
  const cookies = (typeof csrfRes.headers.getSetCookie === 'function' ? csrfRes.headers.getSetCookie() : [csrfRes.headers.get('set-cookie')]) || [];
  const sid = cookies.map((c) => (c ? c.split(';')[0] : '')).find((c) => c.startsWith('connect.sid='));
  const { csrfToken } = await csrfRes.json();
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sid, 'x-csrf-token': csrfToken },
    body: JSON.stringify({ email, password: TEST_PASSWORD, lang: 'en' }),
  });
  assert.equal(res.status, 200);
  const loginCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
  const freshSid = loginCookies.map((c) => (c ? c.split(';')[0] : '')).find((c) => c.startsWith('connect.sid='));
  const finalCookie = freshSid || sid;
  const freshCsrf = await fetch(`${baseUrl}/api/csrf`, { headers: { Cookie: finalCookie } });
  const { csrfToken: token } = await freshCsrf.json().catch(() => ({}));
  return { cookie: finalCookie, csrfToken: token || '' };
}

test('AV2-01: campaign goal progress is computed and clamped', () => {
  const progress = campaigns.computeGoalProgress({ actual: 40, target: 100 });
  assert.equal(progress.percent, 40);
  assert.equal(progress.bar_percent, 40);
  assert.equal(progress.remaining, 60);
  assert.equal(progress.achieved, false);

  const overshoot = campaigns.computeGoalProgress({ actual: 150, target: 100 });
  assert.equal(overshoot.percent, 150);
  assert.equal(overshoot.bar_percent, 100);
  assert.equal(overshoot.achieved, true);

  assert.equal(campaigns.computeGoalProgress({ actual: 5, target: null }).percent, null);
  assert.equal(campaigns.normalizeGoalTarget('-3'), null);
  assert.equal(campaigns.normalizeGoalTarget('42'), 42);
});

test('AV2-02: funnel pixel, visitor split, live feed, thresholds, segments and audit', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }

  const user = await seedUser('free');
  const link = await seedLink(user.id);

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const session = await login(baseUrl, user.email);
    const auth = { Cookie: session.cookie };

    await t.test('1. the pixel records deduplicated funnel steps', async () => {
      const first = await fetch(`${baseUrl}/c/${link.short}.gif?goal=signup&step=1`, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/122.0.0.0' } });
      assert.equal(first.status, 200);
      const second = await fetch(`${baseUrl}/c/${link.short}.gif?goal=signup&step=2`, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/122.0.0.0' } });
      assert.equal(second.status, 200);

      const deadline = Date.now() + 5000;
      let rows = [];
      while (Date.now() < deadline) {
        rows = await helpers.dbAllAsync('SELECT step FROM link_funnel_steps WHERE url_id = ? ORDER BY step ASC', [link.id]);
        if (rows.length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.deepEqual(rows.map((row) => Number(row.step)), [1, 2]);

      const res = await fetch(`${baseUrl}/api/stats/${link.short}/funnel?days=7`, { headers: auth });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.available, true);
      assert.equal(payload.steps.length, 2);
      assert.equal(payload.steps[1].drop_from_previous, 0);
    });

    await t.test('2. new vs returning uses the visitor hashes', async () => {
      await helpers.dbRunAsync('INSERT INTO click_uniques (url_id, day, ip_hash, created_at) VALUES (?, ?, ?, ?)', [link.id, dayIso(-10), 'hash-a', new Date().toISOString()]);
      await helpers.dbRunAsync('INSERT INTO click_uniques (url_id, day, ip_hash, created_at) VALUES (?, ?, ?, ?)', [link.id, dayIso(-1), 'hash-a', new Date().toISOString()]);
      await helpers.dbRunAsync('INSERT INTO click_uniques (url_id, day, ip_hash, created_at) VALUES (?, ?, ?, ?)', [link.id, dayIso(-1), 'hash-b', new Date().toISOString()]);

      const res = await fetch(`${baseUrl}/api/stats/${link.short}/visitors?days=7`, { headers: auth });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.available, true);
      assert.equal(payload.visitors, 2);
      assert.equal(payload.returning_visitors, 1);
      assert.equal(payload.new_visitors, 1);
    });

    await t.test('3. the live feed returns only newer rows and never a hash', async () => {
      const first = await helpers.dbRunAsync(
        'INSERT INTO clicks (url_id, click_time, browser, os, country, device_type, is_bot, ip_hash) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
        [link.id, new Date().toISOString(), 'Chrome', 'Linux', 'AZ', 'desktop', 'secret-hash']
      );

      const res = await fetch(`${baseUrl}/api/stats/${link.short}/live?after_id=${Number(first.lastID) - 1}`, { headers: auth });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.ok(Array.isArray(payload.clicks));
      assert.equal(JSON.stringify(payload).includes('secret-hash'), false, 'the visitor hash must never be exposed');
      assert.ok(payload.next_after_id >= Number(first.lastID));

      const anonymous = await fetch(`${baseUrl}/api/stats/${link.short}/live`);
      assert.equal(anonymous.status, 401);

      const foreign = await fetch(`${baseUrl}/api/stats/${uniqueShort('nope')}/live`, { headers: auth });
      assert.equal(foreign.status, 404);
    });

    await t.test('4. alert thresholds round-trip and win over the default', async () => {
      const patch = await fetch(`${baseUrl}/api/user/alert-thresholds`, {
        method: 'PATCH',
        headers: { ...auth, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
        body: JSON.stringify({ spike_multiplier: 6, spike_min_clicks: 30 }),
      });
      assert.equal(patch.status, 200);
      const patched = await patch.json();
      assert.equal(patched.settings.spike_multiplier.value, 6);
      assert.equal(patched.settings.spike_multiplier.source, 'user');

      const linkPatch = await fetch(`${baseUrl}/api/stats/${link.short}/alert-thresholds`, {
        method: 'PATCH',
        headers: { ...auth, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
        body: JSON.stringify({ spike_multiplier: 9 }),
      });
      assert.equal(linkPatch.status, 200);
      const linkPayload = await linkPatch.json();
      assert.equal(linkPayload.settings.spike_multiplier.value, 9);
      assert.equal(linkPayload.settings.spike_multiplier.source, 'link');

      const insights = await fetch(`${baseUrl}/api/stats/${link.short}/anomalies?days=14`, { headers: auth });
      assert.equal(insights.status, 200);
      const insightPayload = await insights.json();
      assert.equal(insightPayload.thresholds.spike_multiplier, 9, 'the worker and the panel share the resolution order');
    });

    await t.test('5. saved segments are scoped to the owner', async () => {
      const create = await fetch(`${baseUrl}/api/segments`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
        body: JSON.stringify({ name: 'Mobile AZ', filters: { days: 7, country: 'az', device: 'mobile' } }),
      });
      assert.equal(create.status, 201);
      const created = await create.json();
      assert.equal(created.segment.filters.country, 'AZ');

      const duplicate = await fetch(`${baseUrl}/api/segments`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
        body: JSON.stringify({ name: 'Mobile AZ', filters: {} }),
      });
      assert.equal(duplicate.status, 409);

      const list = await fetch(`${baseUrl}/api/segments`, { headers: auth });
      assert.equal(list.status, 200);
      assert.equal((await list.json()).segments.length, 1);

      const stranger = await seedUser('free');
      const strangerSession = await login(baseUrl, stranger.email);
      const foreignList = await fetch(`${baseUrl}/api/segments`, { headers: { Cookie: strangerSession.cookie } });
      assert.deepEqual((await foreignList.json()).segments, []);

      const remove = await fetch(`${baseUrl}/api/segments/${created.segment.id}`, {
        method: 'DELETE',
        headers: { ...auth, 'x-csrf-token': session.csrfToken },
      });
      assert.equal(remove.status, 200);
    });

    await t.test('6. statistics reads are written to the access log', async () => {
      await fetch(`${baseUrl}/api/stats/${link.short}?days=7`, { headers: auth });
      await audit.flushAuditQueue();

      const entries = await helpers.dbAllAsync(
        "SELECT action FROM analytics_audit_log WHERE url_id = ? AND action = 'stats.view' LIMIT 5",
        [link.id]
      );
      assert.ok(entries.length >= 1, 'a stats view must be recorded');

      const res = await fetch(`${baseUrl}/api/stats/${link.short}/audit`, { headers: auth });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.ok(Array.isArray(payload.entries));
      assert.ok(payload.entries.length >= 1);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
