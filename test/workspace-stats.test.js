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
const workspaceStats = require('../src/lib/workspace-stats');

const TEST_PASSWORD = 'WsStats!2026x';
const createdUsers = [];
const createdWorkspaces = [];
const createdShorts = [];
let hasPostgres = false;

function uniqueShort(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function dayIso(offsetDays) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function seedUser(plan) {
  const email = `ws-stats-${plan}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const proExpires = plan === 'pro' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null;
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, pro_expires_at, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), await bcrypt.hash(TEST_PASSWORD, 10), plan, 'active', proExpires, new Date().toISOString()]
  );
  const row = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdUsers.push(row.id);
  return { id: row.id, email };
}

async function seedWorkspace(ownerId, name) {
  const inserted = await helpers.dbRunAsync(
    'INSERT INTO workspaces (name, owner_user_id, created_at) VALUES (?, ?, ?)',
    [name, ownerId, new Date().toISOString()]
  );
  const workspaceId = inserted.lastID;
  createdWorkspaces.push(workspaceId);
  await helpers.dbRunAsync(
    'INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
    [workspaceId, ownerId, 'owner', new Date().toISOString()]
  );
  return workspaceId;
}

async function seedLink({ userId, workspaceId = null, clicks = 0, uniques = 0, conversions = 0, day = dayIso(-1) }) {
  const short = uniqueShort('wss');
  const inserted = await helpers.dbRunAsync(
    'INSERT INTO urls (original, short, created_at, user_id, workspace_id) VALUES (?, ?, ?, ?, ?)',
    ['https://example.com/landing', short, new Date().toISOString(), userId, workspaceId]
  );
  createdShorts.push({ short, urlId: inserted.lastID });
  if (clicks || uniques || conversions) {
    await helpers.dbRunAsync(
      'INSERT INTO link_stats_daily (url_id, day, clicks, uniques, bots, conversions, first_click_at, last_click_at) ' +
        'VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
      [inserted.lastID, day, clicks, uniques, conversions, new Date().toISOString(), new Date().toISOString()]
    );
  }
  return inserted.lastID;
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
  return freshSid || sid;
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
  for (const link of createdShorts) {
    try { await helpers.dbRunAsync('DELETE FROM link_stats_daily WHERE url_id = ?', [link.urlId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM clicks WHERE url_id = ?', [link.urlId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM urls WHERE short = ?', [link.short]); } catch {}
  }
  for (const workspaceId of createdWorkspaces) {
    try { await helpers.dbRunAsync('UPDATE urls SET workspace_id = NULL WHERE workspace_id = ?', [workspaceId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM workspace_members WHERE workspace_id = ?', [workspaceId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM workspaces WHERE id = ?', [workspaceId]); } catch {}
  }
  for (const userId of createdUsers) {
    try { await helpers.dbRunAsync('DELETE FROM workspace_members WHERE user_id = ?', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM user_sessions WHERE user_id = ?', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [userId]); } catch {}
  }
  const deadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { await helpers.closeDbPool(); } catch {}
});

test('WS-STAT-01: range parsing is a strict allow-list', () => {
  assert.equal(workspaceStats.normalizeWorkspaceDays(7), 7);
  assert.equal(workspaceStats.normalizeWorkspaceDays('90'), 90);
  assert.equal(workspaceStats.normalizeWorkspaceDays('365'), 365);
  assert.equal(workspaceStats.normalizeWorkspaceDays('all'), 30);
  assert.equal(workspaceStats.normalizeWorkspaceDays('-5'), 30);
  assert.equal(workspaceStats.normalizeWorkspaceDays(undefined), 30);
});

test('WS-STAT-02: the rollup only counts links of the requested workspace', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }

  const owner = await seedUser('pro');
  const workspaceId = await seedWorkspace(owner.id, `Analytics Co ${Date.now()}`);

  await seedLink({ userId: owner.id, workspaceId, clicks: 10, uniques: 6, conversions: 2, day: dayIso(-1) });
  await seedLink({ userId: owner.id, workspaceId, clicks: 5, uniques: 3, conversions: 1, day: dayIso(-2) });
  // Personal link must never leak into the workspace rollup.
  await seedLink({ userId: owner.id, workspaceId: null, clicks: 99, uniques: 99, conversions: 9, day: dayIso(-1) });

  const payload = await workspaceStats.loadWorkspaceStats(workspaceId, { days: 30 });
  assert.ok(payload);
  assert.equal(payload.totals.clicks, 15);
  assert.equal(payload.totals.uniques, 9);
  assert.equal(payload.totals.conversions, 3);
  assert.equal(payload.totals.conversion_rate, 20);
  assert.equal(payload.period.from <= dayIso(-2), true);
  assert.equal(payload.series.length, 30);
  assert.equal(payload.top_links.length, 2);
  assert.equal(payload.top_links[0].clicks, 10);
  assert.equal(payload.sources.length, 0, 'no raw clicks were seeded');

  const narrowed = await workspaceStats.loadWorkspaceStats(workspaceId, { days: 7 });
  assert.equal(narrowed.days, 7);
  assert.equal(narrowed.series.length, 7);
  assert.equal(narrowed.totals.clicks, 15);

  assert.equal(await workspaceStats.loadWorkspaceStats('nope', {}), null);
  assert.equal(await workspaceStats.loadWorkspaceStats(0, {}), null);
});

test('WS-STAT-03: the endpoint enforces membership and the Pro gate', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }

  const owner = await seedUser('pro');
  const freeOwner = await seedUser('free');
  const outsider = await seedUser('free');
  const workspaceId = await seedWorkspace(owner.id, `Endpoint Co ${Date.now()}`);
  const freeWorkspaceId = await seedWorkspace(freeOwner.id, `Free Co ${Date.now()}`);
  await seedLink({ userId: owner.id, workspaceId, clicks: 4, uniques: 2, conversions: 0, day: dayIso(-1) });

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const unauth = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/stats`);
    assert.equal(unauth.status, 401);

    const ownerCookie = await login(baseUrl, owner.email);
    const ok = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/stats?days=7`, { headers: { Cookie: ownerCookie } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.days, 7);
    assert.equal(body.totals.clicks, 4);
    assert.ok(Array.isArray(body.top_links));
    assert.ok(Array.isArray(body.sources));

    const outsiderCookie = await login(baseUrl, outsider.email);
    const denied = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/stats`, { headers: { Cookie: outsiderCookie } });
    assert.equal(denied.status, 403);

    const missing = await fetch(`${baseUrl}/api/workspaces/99999999/stats`, { headers: { Cookie: ownerCookie } });
    assert.equal(missing.status, 404);

    const freeCookie = await login(baseUrl, freeOwner.email);
    const gated = await fetch(`${baseUrl}/api/workspaces/${freeWorkspaceId}/stats`, { headers: { Cookie: freeCookie } });
    assert.equal(gated.status, 403, 'workspace analytics is a Pro feature');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
