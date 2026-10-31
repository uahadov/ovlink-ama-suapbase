const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');
const { beat, snapshot, reset } = require('../src/lib/worker-heartbeat');

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
  if (!hasPostgres) return;
  try { await helpers.closeDbPool(); } catch {}
});

test('worker heartbeat: records beats without any I/O', () => {
  reset();
  beat('demo');
  beat('demo');
  const snap = snapshot();
  assert.equal(snap.demo.runs, 2);
  assert.ok(snap.demo.ageMs >= 0);
  assert.ok(snap.demo.lastBeatAt);
  reset();
  assert.deepEqual(snapshot(), {});
});

test('health: liveness answers without creating a session', async () => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${baseUrl}/health`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime_s, 'number');
    assert.ok(body.version);

    const setCookies = (typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')]) || [];
    assert.equal(
      setCookies.filter(Boolean).some((cookie) => cookie.startsWith('connect.sid=')),
      false,
      'health probe must not set a session cookie'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('health: request id is echoed and readiness reports db', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { 'x-request-id': 'probe-12345678' },
      redirect: 'manual',
    });
    assert.equal(res.headers.get('x-request-id'), 'probe-12345678');
    const body = await res.json();
    if (!hasPostgres) {
      t.skip('PostgreSQL not reachable in test environment');
      return;
    }
    assert.equal(res.status, 200);
    assert.equal(body.checks.db.ok, true);
    assert.equal(typeof body.checks.db.latencyMs, 'number');
    assert.equal(typeof body.checks.redis.configured, 'boolean');
    // Deep pool counters are gated behind HEALTH_TOKEN.
    assert.equal(body.checks.pool, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
