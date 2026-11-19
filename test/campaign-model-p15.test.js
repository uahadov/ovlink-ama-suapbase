const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const {
  evaluateStatusTransition,
  resolveEffectiveStatus,
  validateUtcInterval,
  normalizeBudget,
  generateCampaignEventId,
} = require('../src/lib/campaign-model');

test('P15 unit: deterministic status transitions, UTC intervals, strict real budget and legacy row compatibility', () => {
  assert.match(generateCampaignEventId(), /^cmp_[0-9a-f]{12}$/);

  // Legacy rows without status column
  assert.equal(resolveEffectiveStatus({ status: null, archived_at: null }), 'active');
  assert.equal(resolveEffectiveStatus({ status: null, archived_at: '2026-11-01T00:00:00.000Z' }), 'archived');

  // Idempotent transitions
  assert.deepEqual(evaluateStatusTransition('active', 'active'), {
    allowed: true,
    changed: false,
    from: 'active',
    status: 'active',
  });

  // Valid lifecycle chain
  assert.equal(evaluateStatusTransition('draft', 'active').allowed, true);
  assert.equal(evaluateStatusTransition('active', 'paused').allowed, true);
  assert.equal(evaluateStatusTransition('paused', 'completed').allowed, true);
  assert.equal(evaluateStatusTransition('completed', 'archived').allowed, true);
  assert.equal(evaluateStatusTransition('archived', 'active').allowed, true);

  // Disallowed direct transitions
  const badDraft = evaluateStatusTransition('draft', 'completed');
  assert.equal(badDraft.allowed, false);
  assert.equal(badDraft.code, 'invalid_status_transition');
  assert.deepEqual(badDraft.allowed_next, ['active', 'archived']);

  assert.equal(evaluateStatusTransition('active', 'unknown').code, 'invalid_status');

  // UTC interval validation
  const okInterval = validateUtcInterval('2026-11-20T08:00:00Z', '2026-12-20T20:00:00Z');
  assert.equal(okInterval.starts_at, '2026-11-20T08:00:00.000Z');
  assert.equal(okInterval.ends_at, '2026-12-20T20:00:00.000Z');
  assert.equal(validateUtcInterval('2026-12-20T20:00:00Z', '2026-11-20T08:00:00Z').error, 'invalid_interval');
  assert.equal(validateUtcInterval('not-a-date', null).error, 'invalid_datetime');

  // Strict real budget
  assert.deepEqual(normalizeBudget(null, null), { budget_amount: null, budget_currency: null });
  assert.deepEqual(normalizeBudget(1250.567, 'azn'), { budget_amount: 1250.57, budget_currency: 'AZN' });
  assert.equal(normalizeBudget(-50, 'USD').error, 'invalid_budget');
  assert.equal(normalizeBudget('free', 'USD').error, 'invalid_budget');
  assert.equal(normalizeBudget(500, 'BTC').error, 'invalid_currency');
});

test('P15 integration: legacy migration safety, 20-campaign portfolio, status machine, assets bundle and audit trail', async (t) => {
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
  const createdQrIds = [];

  t.after(async () => {
    for (const id of createdQrIds) {
      try {
        await helpers.dbRunAsync('DELETE FROM qr_scan_daily WHERE qr_id = ?', [id]);
        await helpers.dbRunAsync('DELETE FROM qr_codes WHERE id = ?', [id]);
      } catch {}
    }
    for (const short of createdShorts) {
      try {
        const u = await helpers.dbGetAsync('SELECT id FROM urls WHERE short = ?', [short]);
        if (u) await helpers.dbRunAsync('DELETE FROM clicks WHERE url_id = ?', [u.id]);
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
  const password = 'P15Campaign!2026';
  const email = `p15-cmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const passwordHash = await bcrypt.hash(password, 10);
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), passwordHash, 'pro', 'active', new Date().toISOString()]
  );
  const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdUserIds.push(user.id);

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

  const apiJson = async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { cookie: authCookie, 'x-csrf-token': freshCsrf, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { res, data: await res.json().catch(() => ({})) };
  };

  // 1. Legacy campaign compatibility (inserted without P15 fields)
  const legacy = await helpers.dbGetAsync(
    'INSERT INTO campaigns (user_id, name, slug, created_at) VALUES (?, ?, ?, ?) RETURNING id',
    [user.id, 'Legacy 2025 Launch', `legacy-2025-${Date.now().toString(36)}`, new Date().toISOString()]
  );
  createdCampaignIds.push(legacy.id);

  // 2. Reject invalid budget & invalid interval
  const badBudget = await apiJson('POST', '/api/campaigns', {
    name: 'Bad Budget Campaign',
    budget_amount: -100,
    budget_currency: 'AZN',
  });
  assert.equal(badBudget.res.status, 400);

  const badInterval = await apiJson('POST', '/api/campaigns', {
    name: 'Bad Interval Campaign',
    starts_at: '2026-12-20T00:00:00Z',
    ends_at: '2026-11-20T00:00:00Z',
  });
  assert.equal(badInterval.res.status, 400);

  // 3. Create structured draft campaign with UTC window & real budget
  const created = await apiJson('POST', '/api/campaigns', {
    name: 'Baku Winter Promo',
    goal: 'leads',
    status: 'draft',
    starts_at: '2026-12-01T00:00:00Z',
    ends_at: '2026-12-31T23:59:59Z',
    budget_amount: 2500.75,
    budget_currency: 'AZN',
  });
  assert.equal(created.res.status, 201, JSON.stringify(created.data));
  const cmp = created.data.campaign;
  createdCampaignIds.push(cmp.id);
  assert.equal(cmp.status, 'draft');
  assert.match(cmp.event_id, /^cmp_[0-9a-f]{12}$/);
  assert.equal(cmp.budget_amount, 2500.75);
  assert.equal(cmp.budget_currency, 'AZN');

  // 4. Deterministic & idempotent status transitions
  const disallowed = await apiJson('PATCH', `/api/campaigns/${cmp.id}`, { status: 'completed' });
  assert.equal(disallowed.res.status, 409);
  assert.equal(disallowed.data.code, 'invalid_status_transition');

  const toActive = await apiJson('PATCH', `/api/campaigns/${cmp.id}`, { status: 'active' });
  assert.equal(toActive.res.status, 200);
  assert.equal(toActive.data.campaign.status, 'active');

  const idempotentActive = await apiJson('PATCH', `/api/campaigns/${cmp.id}`, { status: 'active' });
  assert.equal(idempotentActive.res.status, 200);
  assert.equal(idempotentActive.data.campaign.status, 'active');

  const toPaused = await apiJson('PATCH', `/api/campaigns/${cmp.id}`, { status: 'paused' });
  assert.equal(toPaused.res.status, 200);
  assert.equal(toPaused.data.campaign.status, 'paused');

  const toArchived = await apiJson('PATCH', `/api/campaigns/${cmp.id}`, { status: 'archived' });
  assert.equal(toArchived.res.status, 200);
  assert.equal(toArchived.data.campaign.status, 'archived');
  assert.ok(toArchived.data.campaign.archived_at);

  const reopen = await apiJson('PATCH', `/api/campaigns/${cmp.id}`, { status: 'active' });
  assert.equal(reopen.res.status, 200);
  assert.equal(reopen.data.campaign.status, 'active');
  assert.equal(reopen.data.campaign.archived_at, null);

  // 5. Link + QR assets bound to campaign
  const shortCode = `p15l${Date.now().toString(36)}`;
  createdShorts.push(shortCode);
  const linkRow = await helpers.dbGetAsync(
    'INSERT INTO urls (short, original, user_id, campaign_id, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [shortCode, 'https://example.com/baku-winter', user.id, cmp.id, new Date().toISOString()]
  );
  const qrRes = await apiJson('POST', '/api/qr', { short: shortCode, label: 'Winter Billboard' });
  assert.equal(qrRes.res.status, 201);
  createdQrIds.push(qrRes.data.qrCode.id);

  const assets = await apiJson('GET', `/api/campaigns/${cmp.id}/assets`);
  assert.equal(assets.res.status, 200);
  assert.equal(assets.data.campaign.event_id, cmp.event_id);
  assert.equal(assets.data.summary.links_count, 1);
  assert.equal(assets.data.summary.qr_codes_count, 1);
  assert.equal(assets.data.links[0].short, shortCode);
  assert.equal(assets.data.qr_codes[0].id, qrRes.data.qrCode.id);

  // 6. 20-campaign portfolio test + status filter + legacy row intact
  for (let i = 1; i <= 18; i += 1) {
    const res = await apiJson('POST', '/api/campaigns', {
      name: `Portfolio Launch ${i}`,
      status: i % 2 === 0 ? 'draft' : 'active',
      budget_amount: i * 100,
      budget_currency: 'AZN',
    });
    assert.equal(res.res.status, 201);
    createdCampaignIds.push(res.data.campaign.id);
  }

  const allActiveAndDraft = await apiJson('GET', '/api/campaigns');
  assert.equal(allActiveAndDraft.res.status, 200);
  assert.equal(allActiveAndDraft.data.campaigns.length, 20);
  assert.ok(allActiveAndDraft.data.campaigns.some((c) => c.id === legacy.id && c.status === 'active'));

  const onlyDrafts = await apiJson('GET', '/api/campaigns?status=draft');
  assert.equal(onlyDrafts.res.status, 200);
  assert.equal(onlyDrafts.data.campaigns.length, 9);
  assert.ok(onlyDrafts.data.campaigns.every((c) => c.status === 'draft'));

  // 7. Audit log recorded campaign lifecycle mutations
  const auditRows = await helpers.dbAllAsync(
    'SELECT action FROM analytics_audit_log WHERE user_id = ?',
    [user.id]
  );
  const actions = auditRows.map((r) => r.action);
  assert.ok(actions.includes('campaign.created'));
  assert.ok(actions.includes('campaign.status_changed'));
  assert.ok(linkRow && linkRow.id);
});
