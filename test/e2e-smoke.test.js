const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');

let hasPostgres = false;
const createdShorts = [];

test.before(async () => {
  try {
    await helpers.dbGetAsync('SELECT 1');
    hasPostgres = true;
  } catch (err) {
    hasPostgres = false;
  }
  const deadline = Date.now() + 20000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test.after(async () => {
  for (const short of createdShorts) {
    try { await helpers.dbRunAsync('DELETE FROM urls WHERE short = ?', [short]); } catch {}
  }
  if (!hasPostgres) return;
  try { await helpers.closeDbPool(); } catch {}
});

function pollFor(fn, { timeoutMs = 2000, intervalMs = 50 } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = async () => {
      try {
        const value = await fn();
        if (value) return resolve(value);
      } catch (err) {
        return reject(err);
      }
      if (Date.now() - startedAt > timeoutMs) return resolve(null);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

test('smoke: public pages, redirect hot path and health endpoint', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // Static / public surface must answer without any session.
    for (const pathname of ['/', '/robots.txt', '/sitemap.xml']) {
      const res = await fetch(`${baseUrl}${pathname}`, { redirect: 'manual' });
      assert.equal(res.status, 200, `${pathname} must answer 200`);
      await res.arrayBuffer();
    }

    // AGENTS.md is an internal ops document and must never be served.
    const agentsRes = await fetch(`${baseUrl}/agents.md`, { redirect: 'manual' });
    assert.equal(agentsRes.status, 404);
    await agentsRes.arrayBuffer();

    // Health endpoint is process-only and must not create a session.
    const healthRes = await fetch(`${baseUrl}/health`, { redirect: 'manual' });
    assert.equal(healthRes.status, 200, '/health must answer 200');
    const setCookies = (typeof healthRes.headers.getSetCookie === 'function'
      ? healthRes.headers.getSetCookie()
      : [healthRes.headers.get('set-cookie')]) || [];
    assert.equal(
      setCookies.filter(Boolean).some((cookie) => cookie.startsWith('connect.sid=')),
      false,
      '/health must not start a session'
    );
    await healthRes.arrayBuffer();

    if (!hasPostgres) {
      t.diagnostic('PostgreSQL not reachable: redirect + rollup assertions skipped');
      return;
    }

    const short = `smoke${Date.now().toString(36)}`;
    createdShorts.push(short);
    await helpers.dbRunAsync(
      'INSERT INTO urls (original, short, created_at, reports, dangerous) VALUES (?, ?, ?, 0, 0)',
      ['https://example.com/smoke-target', short, new Date().toISOString()]
    );
    const row = await helpers.dbGetAsync('SELECT id FROM urls WHERE short = ?', [short]);
    assert.ok(row && row.id, 'seed link must exist');

    const redirectRes = await fetch(`${baseUrl}/${short}`, { redirect: 'manual' });
    assert.equal(redirectRes.status, 302, 'redirect must answer 302');
    assert.match(redirectRes.headers.get('location') || '', /example\.com\/smoke-target/);
    await redirectRes.arrayBuffer();

    // Click persistence is fire-and-forget by design: poll instead of sleeping.
    const clickRow = await pollFor(async () => {
      const found = await helpers.dbGetAsync('SELECT id FROM clicks WHERE url_id = ?', [row.id]);
      return found || null;
    });
    assert.ok(clickRow, 'click row must be persisted for the redirect');

    const rollupRow = await pollFor(async () => {
      const found = await helpers.dbGetAsync('SELECT clicks FROM link_stats_daily WHERE url_id = ?', [row.id]);
      return found || null;
    });
    assert.ok(rollupRow, 'daily rollup row must be persisted');
    assert.ok(Number(rollupRow.clicks) >= 1, 'rollup must count the click');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
