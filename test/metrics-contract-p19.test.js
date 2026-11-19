const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const contract = require('../src/lib/metrics-contract');

test('P19 unit: Analytics Data Contract v1 definitions, privacy disclaimers and reconciliation rules', () => {
  const full = contract.getFullAnalyticsContract();
  assert.equal(full.version, 'v1');
  assert.equal(full.timezone, 'UTC');
  assert.equal(full.hashes_are_real_identities, false);

  for (const key of ['clicks', 'uniques', 'bots', 'conversions', 'conversion_rate', 'qr_scans', 'lead', 'revenue']) {
    assert.ok(full.metrics[key], `missing metric definition: ${key}`);
    assert.equal(full.metrics[key].timezone, 'UTC');
  }

  assert.equal(full.metrics.uniques.accuracy, 'estimated');
  assert.match(full.metrics.uniques.identity_disclaimer, /not|never/i);
  assert.equal(full.metrics.revenue.accuracy, 'unknown');
  assert.ok(full.event_handling.consent_declined.includes('0'));

  const aligned = contract.reconcileRawVsRollup({ raw: { clicks: 10, bots: 2 }, rollup: { clicks: 10, bots: 2 } });
  assert.equal(aligned.reconciled, true);
  assert.equal(aligned.status, 'exact_match');

  const drifted = contract.reconcileRawVsRollup({ raw: { clicks: 12, bots: 2 }, rollup: { clicks: 10, bots: 1 } });
  assert.equal(drifted.reconciled, false);
  assert.equal(drifted.status, 'drift_detected');
  assert.equal(drifted.authoritative_source, 'raw_events_clicks_table');
  assert.deepEqual(drifted.delta, { clicks: 2, bots: 1 });
});

test('P19 integration: API, CSV export and raw-vs-rollup reconciliation agree on synthetic dataset', async (t) => {
  const { app, helpers } = require('../server');
  const { blindIndex, encryptAES256GCM } = require('../utils/crypto');

  let hasPostgres = false;
  try {
    await helpers.dbGetAsync('SELECT 1');
    hasPostgres = true;
  } catch {
    hasPostgres = false;
  }
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }

  const deadline = Date.now() + 20000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const createdUserIds = [];
  const createdCampaignIds = [];
  const createdShorts = [];

  t.after(async () => {
    for (const short of createdShorts) {
      try {
        const u = await helpers.dbGetAsync('SELECT id FROM urls WHERE short = ?', [short]);
        if (u) {
          await helpers.dbRunAsync('DELETE FROM clicks WHERE url_id = ?', [u.id]);
          await helpers.dbRunAsync('DELETE FROM link_stats_daily WHERE url_id = ?', [u.id]);
        }
        await helpers.dbRunAsync('DELETE FROM urls WHERE short = ?', [short]);
      } catch {}
    }
    for (const cid of createdCampaignIds) {
      try { await helpers.dbRunAsync('DELETE FROM campaigns WHERE id = ?', [cid]); } catch {}
    }
    for (const uid of createdUserIds) {
      try {
        await helpers.dbRunAsync('DELETE FROM analytics_audit_log WHERE user_id = ?', [uid]);
        await helpers.dbRunAsync('DELETE FROM user_sessions WHERE user_id = ?', [uid]);
        await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [uid]);
      } catch {}
    }
    try { await helpers.closeDbPool(); } catch {}
  });

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const password = 'P19Metrics!2026';
  const email = `p19-met-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const passwordHash = await bcrypt.hash(password, 10);
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), passwordHash, 'pro', 'active', new Date().toISOString()]
  );
  const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdUserIds.push(user.id);

  // 1. Public methodology contract endpoint
  const methRes = await fetch(`${baseUrl}/api/analytics/methodology`);
  assert.equal(methRes.status, 200);
  const meth = await methRes.json();
  assert.equal(meth.version, 'v1');
  assert.equal(meth.hashes_are_real_identities, false);
  assert.equal(meth.metrics.revenue.accuracy, 'unknown');

  // Login
  const bootstrap = await fetch(`${baseUrl}/api/csrf`);
  const cookies = (typeof bootstrap.headers.getSetCookie === 'function' ? bootstrap.headers.getSetCookie() : [bootstrap.headers.get('set-cookie')]) || [];
  const sid = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid='));
  const { csrfToken } = await bootstrap.json();

  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { cookie: sid, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, lang: 'en' }),
  });
  assert.equal(loginRes.status, 200);
  const after = (typeof loginRes.headers.getSetCookie === 'function' ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')]) || [];
  const authCookie = after.map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid=')) || sid;
  const csrfRes = await fetch(`${baseUrl}/api/csrf`, { headers: { cookie: authCookie } });
  const { csrfToken: freshCsrf } = await csrfRes.json();

  // 2. Seed synthetic campaign + link + 3 aligned raw clicks (2 unique humans, 1 bot) + daily rollup
  const cmpRes = await fetch(`${baseUrl}/api/campaigns`, {
    method: 'POST',
    headers: { cookie: authCookie, 'x-csrf-token': freshCsrf, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'P19 Contract Campaign', goal: 'signup' }),
  });
  assert.equal(cmpRes.status, 201);
  const cmp = (await cmpRes.json()).campaign;
  createdCampaignIds.push(cmp.id);

  const short = `p19m${Date.now().toString(36)}`;
  createdShorts.push(short);
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);
  const link = await helpers.dbGetAsync(
    'INSERT INTO urls (short, original, user_id, campaign_id, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [short, 'https://example.com/p19', user.id, cmp.id, nowIso]
  );

  await helpers.dbRunAsync(
    'INSERT INTO clicks (url_id, click_time, ip_hash, is_bot) VALUES (?, ?, ?, 0), (?, ?, ?, 0), (?, ?, ?, 1)',
    [link.id, nowIso, 'hash_a', link.id, nowIso, 'hash_b', link.id, nowIso, 'hash_bot']
  );
  await helpers.dbRunAsync(
    'INSERT INTO link_stats_daily (url_id, day, clicks, uniques, bots, conversions, first_click_at, last_click_at) VALUES (?, ?, 3, 2, 1, 0, ?, ?)',
    [link.id, today, nowIso, nowIso]
  );

  // 3. API JSON (all clicks) + CSV export + reconciliation all agree
  const statsAll = await (await fetch(`${baseUrl}/api/campaigns/${cmp.id}?days=30&bots=include`, { headers: { cookie: authCookie } })).json();
  assert.equal(statsAll.clicks, 3);
  assert.equal(statsAll.uniques, 2);
  assert.equal(statsAll.bots, 1);
  assert.equal(statsAll.data_contract.version, 'v1');
  assert.equal(statsAll.data_contract.accuracy.uniques, 'estimated');
  assert.equal(statsAll.data_contract.accuracy.revenue, 'unknown');

  const statsHuman = await (await fetch(`${baseUrl}/api/campaigns/${cmp.id}?days=30&bots=exclude`, { headers: { cookie: authCookie } })).json();
  assert.equal(statsHuman.clicks, 2);
  assert.equal(statsHuman.uniques, 2);
  assert.equal(statsHuman.bots, 0);

  const csvRes = await fetch(`${baseUrl}/api/campaigns/${cmp.id}/export.csv?days=30&bots=include`, { headers: { cookie: authCookie } });
  assert.equal(csvRes.status, 200);
  const csvText = await csvRes.text();
  assert.match(csvText, /"Clicks","3"/);
  assert.match(csvText, /"Analytics contract","v1 \(UTC\)"/);
  assert.match(csvText, /"Uniques accuracy","estimated"/);
  assert.match(csvText, /"Revenue status","unknown"/);

  const recAligned = await (await fetch(`${baseUrl}/api/campaigns/${cmp.id}/reconcile`, { headers: { cookie: authCookie } })).json();
  assert.equal(recAligned.reconciled, true);
  assert.equal(recAligned.status, 'exact_match');

  // 4. Introduce rollup drift and verify reconciliation flags raw clicks as authoritative
  await helpers.dbRunAsync('UPDATE link_stats_daily SET clicks = 1 WHERE url_id = ?', [link.id]);
  const recDrift = await (await fetch(`${baseUrl}/api/campaigns/${cmp.id}/reconcile`, { headers: { cookie: authCookie } })).json();
  assert.equal(recDrift.reconciled, false);
  assert.equal(recDrift.status, 'drift_detected');
  assert.equal(recDrift.authoritative_source, 'raw_events_clicks_table');
  assert.equal(recDrift.delta.clicks, 2);
});
