const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const {
  validateWizardDraft,
  appendCampaignUtm,
  normalizeChannel,
  normalizeHttpUrl,
} = require('../src/lib/campaign-wizard');

test('P16 unit: wizard draft validation, channel normalization and UTM preview', () => {
  assert.equal(normalizeChannel('Print QR!'), 'print_qr');
  assert.equal(normalizeChannel('x'), null);
  assert.equal(normalizeHttpUrl('javascript:alert(1)'), null);
  assert.equal(normalizeHttpUrl('https://ovlink.az/promo'), 'https://ovlink.az/promo');

  const tagged = appendCampaignUtm('https://ovlink.az/offer', {
    channel: 'instagram',
    campaignSlug: 'qis-satisi',
    medium: 'campaign',
  });
  assert.match(tagged, /utm_source=instagram/);
  assert.match(tagged, /utm_medium=campaign/);
  assert.match(tagged, /utm_campaign=qis-satisi/);

  const invalid = validateWizardDraft({ name: 'A' });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errors[0].code, 'invalid_name');

  const valid = validateWizardDraft({
    name: 'Qış Satışı',
    goal: 'leads',
    channels: ['instagram', 'print_qr', 'instagram'],
    links: [
      { channel: 'instagram', url: 'https://example.com/ig', generate_qr: false },
      { channel: 'print_qr', url: 'https://example.com/qr', generate_qr: true },
    ],
  });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.channels, ['instagram', 'print_qr']);
  assert.equal(valid.links_preview.length, 2);
  assert.equal(valid.links_preview[1].valid, true);
  assert.match(valid.links_preview[1].tagged_url, /utm_medium=qr/);
});

test('P16 integration: wizard preview, full launch (201), partial failure tracking (207) and campaigns UI markup', async (t) => {
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
      try { await helpers.dbRunAsync('DELETE FROM urls WHERE short = ?', [short]); } catch {}
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
  const password = 'P16Wizard!2026';
  const email = `p16-wiz-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
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

  // 1. Preview endpoint (read-only)
  const preview = await apiJson('POST', '/api/campaigns/wizard-preview', {
    name: 'Novruz Launch',
    goal: 'signup',
    channels: ['instagram', 'print_qr'],
    links: [
      { channel: 'instagram', url: 'https://example.com/novruz-ig', generate_qr: false },
      { channel: 'print_qr', url: 'https://example.com/novruz-qr', generate_qr: true },
    ],
  });
  assert.equal(preview.res.status, 200);
  assert.equal(preview.data.valid, true);
  assert.equal(preview.data.links_preview.length, 2);

  // 2. Full launch (201 completed)
  const launchOk = await apiJson('POST', '/api/campaigns/launch', {
    name: 'Novruz Launch',
    goal: 'signup',
    status: 'active',
    budget_amount: 1500,
    budget_currency: 'AZN',
    channels: ['instagram', 'print_qr'],
    links: [
      { channel: 'instagram', url: 'https://example.com/novruz-ig', generate_qr: false },
      { channel: 'print_qr', url: 'https://example.com/novruz-qr', generate_qr: true },
    ],
  });
  assert.equal(launchOk.res.status, 201, JSON.stringify(launchOk.data));
  assert.equal(launchOk.data.launch_status, 'completed');
  assert.equal(launchOk.data.summary.created_links, 2);
  assert.equal(launchOk.data.summary.created_qrs, 1);
  assert.equal(launchOk.data.summary.failed_count, 0);
  createdCampaignIds.push(launchOk.data.campaign.id);
  for (const a of launchOk.data.assets) {
    createdShorts.push(a.link.short);
    if (a.qr) createdQrIds.push(a.qr.id);
  }

  // 3. Partial failure tracking (207 partial)
  const takenShort = launchOk.data.assets[0].link.short;
  const launchPartial = await apiJson('POST', '/api/campaigns/launch', {
    name: 'Partial Launch Test',
    channels: ['whatsapp', 'telegram', 'web'],
    links: [
      { channel: 'whatsapp', url: 'https://example.com/ok', generate_qr: false },
      { channel: 'telegram', url: 'javascript:alert(1)', generate_qr: false },
      { channel: 'web', url: 'https://example.com/clash', custom_short: takenShort },
    ],
  });
  assert.equal(launchPartial.res.status, 207, JSON.stringify(launchPartial.data));
  assert.equal(launchPartial.data.launch_status, 'partial');
  assert.equal(launchPartial.data.summary.created_links, 1);
  assert.equal(launchPartial.data.summary.failed_count, 2);
  assert.deepEqual(
    launchPartial.data.failures.map((f) => f.error_code),
    ['invalid_url', 'short_taken']
  );
  createdCampaignIds.push(launchPartial.data.campaign.id);
  for (const a of launchPartial.data.assets) {
    createdShorts.push(a.link.short);
  }

  // 4. Campaigns page renders wizard shell & script cleanly
  const pageRes = await fetch(`${baseUrl}/campaigns`, { headers: { cookie: authCookie } });
  assert.equal(pageRes.status, 200);
  const html = await pageRes.text();
  assert.match(html, /id="openWizardBtn"/);
  assert.match(html, /id="wizardSection"/);
  assert.match(html, /campaigns-wizard\.js/);
});
