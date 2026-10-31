const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');

const TEST_PASSWORD = 'QrTest!2026x';
const createdUserIds = [];
const createdShorts = [];
const createdQrIds = [];

let hasPostgres = false;

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
  if (!hasPostgres) return;
  const tableDeadline = Date.now() + 20000;
  while (Date.now() < tableDeadline) {
    const rows = await helpers.dbAllAsync(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('qr_codes', 'qr_scan_daily')"
    );
    if (rows.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
});

test.after(async () => {
  for (const id of createdQrIds) {
    try {
      await helpers.dbRunAsync('DELETE FROM qr_scan_daily WHERE qr_id = ?', [id]);
      await helpers.dbRunAsync('DELETE FROM qr_codes WHERE id = ?', [id]);
    } catch {}
  }
  for (const short of createdShorts) {
    try { await helpers.dbRunAsync('DELETE FROM urls WHERE short = ?', [short]); } catch {}
  }
  for (const userId of createdUserIds) {
    try {
      await helpers.dbRunAsync('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [userId]);
    } catch {}
  }
  const deadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { await helpers.closeDbPool(); } catch {}
});

async function seedUser() {
  const email = `qr-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, created_at) VALUES (?, ?, ?, 1, ?, ?, ?) RETURNING id',
    [encryptAES256GCM(email), blindIndex(email), passwordHash, 'pro', 'active', new Date().toISOString()]
  );
  const row = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdUserIds.push(row.id);
  return { id: row.id, email };
}

async function seedLink(userId, short) {
  createdShorts.push(short);
  await helpers.dbRunAsync(
    'INSERT INTO urls (short, original, user_id, created_at) VALUES (?, ?, ?, ?)',
    [short, 'https://example.com/qr-test', userId, new Date().toISOString()]
  );
  const row = await helpers.dbGetAsync('SELECT id, short FROM urls WHERE short = ?', [short]);
  return row;
}

test('qr: CRUD, ownership isolation and /q/:slug scan counting', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function loginSession(email) {
    const bootstrap = await fetch(`${baseUrl}/api/csrf`);
    const cookies = (typeof bootstrap.headers.getSetCookie === 'function' ? bootstrap.headers.getSetCookie() : [bootstrap.headers.get('set-cookie')]) || [];
    const sid = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid='));
    const { csrfToken } = await bootstrap.json();

    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { cookie: sid, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: TEST_PASSWORD, lang: 'en' }),
    });
    assert.equal(res.status, 200, 'login must succeed');
    const after = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
    const newSid = after.map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid=')) || sid;
    const csrfRes = await fetch(`${baseUrl}/api/csrf`, { headers: { cookie: newSid } });
    const { csrfToken: fresh } = await csrfRes.json();
    return { cookie: newSid, csrfToken: fresh };
  }

  const api = (session) => ({
    async json(method, path, body) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { cookie: session.cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      return { res, data: await res.json().catch(() => ({})) };
    },
    async raw(method, path) {
      return fetch(`${baseUrl}${path}`, { method, headers: { cookie: session.cookie }, redirect: 'manual' });
    },
  });

  const owner = await seedUser();
  const other = await seedUser();
  const ownerSession = await loginSession(owner.email);
  const otherSession = await loginSession(other.email);

  const ownLink = await seedLink(owner.id, `qrun${Date.now().toString(36)}`);
  const foreignLink = await seedLink(other.id, `qrfn${Date.now().toString(36)}`);

  await t.test('creating a QR for somebody else\'s link is a 404', async () => {
    const { res } = await api(ownerSession).json('POST', '/api/qr', { short: foreignLink.short });
    assert.equal(res.status, 404);
  });

  await t.test('invalid short code and colours are rejected before any write', async () => {
    assert.equal((await api(ownerSession).json('POST', '/api/qr', { short: 'not valid!!' })).res.status, 400);
    assert.equal((await api(ownerSession).json('POST', '/api/qr', { short: ownLink.short, colorDark: 'red' })).res.status, 400);
  });

  let created;
  await t.test('POST /api/qr persists the row and returns a /q/ scan url', async () => {
    const { res, data } = await api(ownerSession).json('POST', '/api/qr', {
      short: ownLink.short,
      label: 'Poster',
      colorDark: '#111111',
      colorLight: '#FFFFFF',
    });
    assert.equal(res.status, 201);
    created = data.qrCode;
    assert.ok(created && created.id, 'qr id returned');
    createdQrIds.push(created.id);
    assert.equal(created.scans, 0);
    assert.match(created.scanUrl, /\/q\/[0-9a-f]{12}$/);
    assert.equal(created.label, 'Poster');
  });

  await t.test('GET /api/qr only lists the caller\'s codes', async () => {
    const { res, data } = await api(otherSession).json('GET', '/api/qr');
    assert.equal(res.status, 200);
    assert.equal((data.qrCodes || []).some((row) => row.id === created.id), false);

    const mine = await api(ownerSession).json('GET', '/api/qr');
    assert.ok((mine.data.qrCodes || []).some((row) => row.id === created.id));
  });

  await t.test('another user cannot patch or delete the code', async () => {
    assert.equal((await api(otherSession).json('PATCH', `/api/qr/${created.id}`, { label: 'hijack' })).res.status, 404);
    assert.equal((await api(otherSession).json('DELETE', `/api/qr/${created.id}`)).res.status, 404);
  });

  await t.test('PATCH updates label and colours for the owner', async () => {
    const { res, data } = await api(ownerSession).json('PATCH', `/api/qr/${created.id}`, { label: 'Sticker', colorDark: '#0000ff' });
    assert.equal(res.status, 200);
    assert.equal(data.qrCode.label, 'Sticker');
    assert.equal(data.qrCode.colorDark, '#0000ff');
  });

  await t.test('GET /q/:slug 302s to the link and counts one scan', async () => {
    const before = await helpers.dbGetAsync('SELECT scans FROM qr_codes WHERE id = ?', [created.id]);
    const res = await api(ownerSession).raw('GET', created.scanUrl.replace(/^https?:\/\/[^/]+/, ''));
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `/${ownLink.short}`, 'must hand off to the canonical redirect pipeline');

    const deadline = Date.now() + 2000;
    let after = before;
    while (Date.now() < deadline) {
      after = await helpers.dbGetAsync('SELECT scans FROM qr_codes WHERE id = ?', [created.id]);
      if (Number(after.scans) > Number(before.scans)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(Number(after.scans) > Number(before.scans), 'qr_codes.scans must increase');

    const dayRows = await helpers.dbAllAsync('SELECT day, scans FROM qr_scan_daily WHERE qr_id = ?', [created.id]);
    assert.ok(dayRows.length >= 1, 'a daily counter row must exist');
    assert.match(dayRows[0].day, /^\d{4}-\d{2}-\d{2}$/);
  });

  await t.test('an unknown slug falls through to the normal router', async () => {
    const res = await api(ownerSession).raw('GET', '/q/deadbeefdead');
    assert.notEqual(res.status, 302, 'unknown QR must not redirect through the QR handler');
  });

  await t.test('DELETE soft-deletes so scan history survives', async () => {
    const { res, data } = await api(ownerSession).json('DELETE', `/api/qr/${created.id}`);
    assert.equal(res.status, 200);
    assert.equal(data.deleted, true);

    const row = await helpers.dbGetAsync('SELECT deleted_at FROM qr_codes WHERE id = ?', [created.id]);
    assert.ok(row && row.deleted_at, 'row is kept with deleted_at set');

    const listed = await api(ownerSession).json('GET', '/api/qr');
    assert.equal((listed.data.qrCodes || []).some((r) => r.id === created.id), false);
  });

  await t.test('unauthenticated calls are rejected', async () => {
    const res = await fetch(`${baseUrl}/api/qr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.ok(res.status === 401 || res.status === 403, `expected auth failure, got ${res.status}`);
  });
});
