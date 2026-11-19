const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const utm = require('../src/lib/utm');

test('P17 unit: idempotent UTM application, case-variant deduplication, locale transliteration and channel presets', () => {
  const preset = {
    utm_source: 'Instagram',
    utm_medium: 'Paid Social',
    utm_campaign: 'Yay Satışı 2026',
    convention: { separator: '_', case_mode: 'lower', transliterate_locale: true },
  };

  // First application over mixed-case existing UTM param + fragment
  const once = utm.applyUtmPreset('https://ovlink.az/promo?ref=bio&UTM_SOURCE=OLD#hero', preset);
  assert.match(once, /ref=bio/);
  assert.match(once, /utm_source=instagram/);
  assert.match(once, /utm_medium=paid_social/);
  assert.match(once, /utm_campaign=yay_satisi_2026/);
  assert.ok(once.endsWith('#hero'));
  assert.equal((once.match(/utm_source=/gi) || []).length, 1, 'case-variant duplicate utm_source must be removed');

  // Second application is strictly idempotent (zero duplicate params)
  const twice = utm.applyUtmPreset(once, preset);
  assert.equal(twice, once);

  // Sample Instagram / TikTok / Telegram channel preview + CSV export
  const preview = utm.buildChannelUtmPreview({
    baseUrl: 'https://ovlink.az/shop',
    preset,
    channels: ['Instagram', 'TikTok', 'Telegram'],
    campaignSlug: 'Qış Kampaniyası',
  });
  assert.equal(preview.rows.length, 3);
  assert.deepEqual(preview.rows.map((r) => r.utm_source), ['instagram', 'tiktok', 'telegram']);
  assert.ok(preview.rows.every((r) => r.tagged_url.includes('utm_campaign=qis_kampaniyasi')));
  assert.match(preview.csv, /^channel,utm_source,utm_medium,utm_campaign,utm_term,utm_content,tagged_url/);
  assert.match(preview.csv, /"tiktok"/);
});

test('P17 integration: saved agency/client UTM presets CRUD, preview/export and audit trail', async (t) => {
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
  const createdPresetIds = [];

  t.after(async () => {
    for (const id of createdPresetIds) {
      try { await helpers.dbRunAsync('DELETE FROM utm_presets WHERE id = ?', [id]); } catch {}
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
  const password = 'P17UtmTest!2026';
  const email = `p17-utm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
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
    body: JSON.stringify({ email, password, lang: 'az' }),
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

  // 1. Create client-scoped UTM preset with underscore + locale transliteration convention
  const created = await apiJson('POST', '/api/utm-presets', {
    name: 'Acme Agency Social',
    client_id: 'client-acme-01',
    utm_source: 'Instagram',
    utm_medium: 'Paid Social',
    utm_campaign: 'Yay Satışı',
    convention: { separator: '_', case_mode: 'lower', transliterate_locale: true },
  });
  assert.equal(created.res.status, 201, JSON.stringify(created.data));
  const preset = created.data.preset;
  createdPresetIds.push(preset.id);
  assert.equal(preset.utm_medium, 'paid_social');
  assert.equal(preset.utm_campaign, 'yay_satisi');
  assert.equal(preset.client_id, 'client-acme-01');

  // 2. Filter by client_id
  const listed = await apiJson('GET', '/api/utm-presets?client_id=client-acme-01');
  assert.equal(listed.res.status, 200);
  assert.equal(listed.data.presets.length, 1);

  // 3. Preview Instagram/TikTok/Telegram URLs + CSV using saved preset_id
  const preview = await apiJson('POST', '/api/utm-presets/preview', {
    preset_id: preset.id,
    base_url: 'https://example.com/offer',
    channels: ['instagram', 'tiktok', 'telegram'],
  });
  assert.equal(preview.res.status, 200);
  assert.equal(preview.data.rows.length, 3);
  assert.match(preview.data.rows[1].tagged_url, /utm_source=tiktok/);
  assert.match(preview.data.rows[2].tagged_url, /utm_source=telegram/);
  assert.match(preview.data.csv, /utm_medium/);

  // 4. Update preset & verify audit log
  const updated = await apiJson('PATCH', `/api/utm-presets/${preset.id}`, {
    utm_content: 'Hero Banner',
  });
  assert.equal(updated.res.status, 200);
  assert.equal(updated.data.preset.utm_content, 'hero_banner');

  const del = await apiJson('DELETE', `/api/utm-presets/${preset.id}`);
  assert.equal(del.res.status, 200);
  assert.equal(del.data.deleted, true);

  const audits = await helpers.dbAllAsync(
    'SELECT action FROM analytics_audit_log WHERE user_id = ?',
    [user.id]
  );
  const actions = audits.map((a) => a.action);
  assert.ok(actions.includes('utm_preset.created'));
  assert.ok(actions.includes('utm_preset.updated'));
  assert.ok(actions.includes('utm_preset.deleted'));
});
