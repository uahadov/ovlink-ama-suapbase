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
const proV1 = require('../src/routes/api/pro-v1');

const TEST_PASSWORD = 'ProV1Pass123!';
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
  if (!hasPostgres) return;
  ensureDbTables();
  const deadline = Date.now() + 20000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test.after(async () => {
  for (const short of createdShorts) {
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

async function seedProUser() {
  const email = `papi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, pro_expires_at, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), await bcrypt.hash(TEST_PASSWORD, 10), 'pro', 'active', new Date(Date.now() + 7 * 86400000).toISOString(), new Date().toISOString()]
  );
  const row = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdUserIds.push(row.id);

  const rawKey = `ovk_${crypto.randomBytes(32).toString('base64url')}`;
  await helpers.dbRunAsync(
    'INSERT INTO api_keys (user_id, name, scopes, key_hash, hash_version, key_prefix, last4, created_at) VALUES (?, ?, ?, ?, 2, ?, ?, ?)',
    [row.id, 'pro-v1-test', 'account:read,shorten:write', helpers.hashApiKeyValue(rawKey), rawKey.slice(0, 12), rawKey.slice(-4), new Date().toISOString()]
  );
  return { id: row.id, key: rawKey };
}

test('PV1-01: cursors round-trip and reject garbage', () => {
  const encoded = proV1.encodeCursor({ created_at: '2026-10-31T10:00:00.000Z', id: 42 });
  assert.ok(encoded && encoded.length > 5);
  assert.deepEqual(proV1.decodeCursor(encoded), { createdAt: '2026-10-31T10:00:00.000Z', id: 42 });

  assert.equal(proV1.decodeCursor('not-a-cursor'), null);
  assert.equal(proV1.decodeCursor(Buffer.from('2026-10-31|abc').toString('base64url')), null);
  assert.equal(proV1.decodeCursor(''), null);
});

test('PV1-02: list query clamps limit and sanitises the search prefix', () => {
  const parsed = proV1.parseListQuery({ limit: '999', q: "ab%c'; DROP", days: '90' });
  assert.equal(parsed.limit, 100);
  assert.equal(parsed.search, 'abcDROP');
  assert.equal(parsed.days, 90);

  const invalid = proV1.parseListQuery({ cursor: 'garbage' });
  assert.equal(invalid.error, 'invalid_cursor');

  assert.equal(proV1.parseListQuery({ limit: '0' }).limit, 1);
  assert.equal(proV1.parseListQuery({}).limit, 25);
});

test('PV1-03: listing is owner-scoped with working cursor pagination', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }

  const user = await seedProUser();
  const other = await seedProUser();

  const shorts = [];
  for (let index = 0; index < 3; index += 1) {
    const short = uniqueShort('pv1');
    shorts.push(short);
    createdShorts.push(short);
    await helpers.dbRunAsync(
      'INSERT INTO urls (original, short, created_at, user_id) VALUES (?, ?, ?, ?)',
      ['https://example.com/x', short, new Date(Date.now() + index * 1000).toISOString(), user.id]
    );
    await helpers.dbRunAsync(
      'INSERT INTO link_stats_daily (url_id, day, clicks, uniques, bots, conversions) SELECT id, ?, 3, 2, 0, 1 FROM urls WHERE short = ?',
      [new Date().toISOString().slice(0, 10), short]
    );
  }
  // Another account's link must never appear in this key's list.
  const foreignShort = uniqueShort('pvf');
  createdShorts.push(foreignShort);
  await helpers.dbRunAsync(
    'INSERT INTO urls (original, short, created_at, user_id) VALUES (?, ?, ?, ?)',
    ['https://example.com/foreign', foreignShort, new Date().toISOString(), other.id]
  );

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const headers = { 'x-api-key': user.key };

    const first = await fetch(`${baseUrl}/api/pro/v1/links?limit=2&days=7`, { headers });
    assert.equal(first.status, 200);
    const page1 = await first.json();
    assert.equal(page1.links.length, 2);
    assert.equal(page1.has_more, true);
    assert.ok(page1.next_cursor);
    assert.equal(page1.links.some((item) => item.short === foreignShort), false);
    assert.ok(page1.links[0].stats.clicks >= 3);

    const second = await fetch(`${baseUrl}/api/pro/v1/links?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`, { headers });
    assert.equal(second.status, 200);
    const page2 = await second.json();
    assert.equal(page2.links.length, 1);
    assert.equal(page2.has_more, false);
    assert.equal(page2.next_cursor, null);

    const ordered = [page1.links[0].short, page1.links[1].short, page2.links[0].short];
    assert.equal(new Set(ordered).size, 3, 'pages must not repeat links');

    const badCursor = await fetch(`${baseUrl}/api/pro/v1/links?cursor=garbage`, { headers });
    assert.equal(badCursor.status, 400);

    const noKey = await fetch(`${baseUrl}/api/pro/v1/links`);
    assert.equal(noKey.status, 401);

    const wrongMethod = await fetch(`${baseUrl}/api/pro/v1/links`, { method: 'POST', headers });
    assert.equal(wrongMethod.status, 405);

    const campaignsRes = await fetch(`${baseUrl}/api/pro/v1/campaigns`, { headers });
    assert.equal(campaignsRes.status, 200);
    assert.ok(Array.isArray((await campaignsRes.json()).campaigns));

    const openapi = await fetch(`${baseUrl}/api/pro/v1/openapi.json`);
    assert.equal(openapi.status, 200);
    const doc = await openapi.json();
    assert.equal(doc.openapi, '3.1.0');
    assert.ok(doc.paths['/api/pro/v1/links']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
