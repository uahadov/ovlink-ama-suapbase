const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const {
  evaluateQrContrast,
  normalizeExportOptions,
  renderPrintQr,
  buildQrMetricsPayload,
  buildLifecycleNotice,
  LOGO_SAFE_ZONE,
} = require('../src/lib/qr-assets');

test('P14 unit: contrast ratio, inverted color rejection, print export options and SVG/PNG rendering', async () => {
  const high = evaluateQrContrast('#111111', '#ffffff', 'az');
  assert.equal(high.valid, true);
  assert.equal(high.print_ready, true);
  assert.ok(high.contrast_ratio >= 18);

  const low = evaluateQrContrast('#cccccc', '#ffffff', 'en');
  assert.equal(low.valid, false);
  assert.equal(low.code, 'low_contrast');
  assert.match(low.message, /too low/i);

  const inverted = evaluateQrContrast('#ffffff', '#111111', 'tr');
  assert.equal(inverted.valid, false);
  assert.equal(inverted.inverted, true);
  assert.equal(inverted.code, 'inverted_contrast');

  const defaults = normalizeExportOptions({});
  assert.deepEqual(defaults, { format: 'svg', size: 1024, ecc: 'H', margin: 4 });
  assert.equal(normalizeExportOptions({ margin: '2' }).code, 'invalid_margin');
  assert.equal(normalizeExportOptions({ size: '123' }).code, 'invalid_size');
  assert.equal(normalizeExportOptions({ ecc: 'L' }).code, 'invalid_ecc');
  assert.equal(normalizeExportOptions({ format: 'jpg' }).code, 'invalid_format');

  const svgOut = await renderPrintQr({
    url: 'https://ovlink.az/q/abcdef123456',
    format: 'svg',
    size: 1024,
    ecc: 'H',
    margin: 4,
    colorDark: '#0f172a',
    colorLight: '#ffffff',
  });
  assert.match(svgOut.contentType, /^image\/svg\+xml/);
  assert.match(svgOut.body, /<svg[\s>]/i);
  assert.equal(svgOut.spec.quiet_zone_modules, 4);
  assert.equal(svgOut.spec.logo_safe_zone.max_area_ratio, LOGO_SAFE_ZONE.max_area_ratio);

  const pngOut = await renderPrintQr({
    url: 'https://ovlink.az/q/abcdef123456',
    format: 'png',
    size: 1024,
    ecc: 'H',
    margin: 4,
  });
  assert.equal(pngOut.contentType, 'image/png');
  assert.ok(Buffer.isBuffer(pngOut.body));
  assert.equal(pngOut.body.subarray(0, 4).toString('hex'), '89504e47');

  const metrics = buildQrMetricsPayload({
    qrRow: { id: 1, slug: 'abcdef123456', short: 'promo', label: 'A4 Poster', scans: 12 },
    dailyRows: [{ day: '2026-11-19', scans: 12 }],
    linkClicks: 45,
    scanUrl: 'https://ovlink.az/q/abcdef123456',
    campaign: { id: 7, name: 'Baku Autumn' },
    lang: 'az',
  });
  assert.equal(metrics.metrics.qr_scans_total, 12);
  assert.equal(metrics.metrics.link_clicks_total, 45);
  assert.equal(metrics.methodology.metrics_separated, true);
  assert.equal(metrics.methodology.claims_sales_conversion, false);
  assert.equal(metrics.lifecycle_policy.pro_expiry_preserves_assets, true);
  assert.ok(buildLifecycleNotice('soft_deleted', 'az').length > 20);
  assert.ok(buildLifecycleNotice('pro_expired', 'en').length > 20);
});

test('P14 integration: dynamic QR re-pointing, campaign filter, SVG/PNG export, metrics separation and Pro expiry safety', async (t) => {
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

  const createdQrIds = [];
  const createdShorts = [];
  const createdCampaignIds = [];
  const createdUserIds = [];

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
  const password = 'P14QrTest!2026';
  const email = `p14-qr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const passwordHash = await bcrypt.hash(password, 10);
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), passwordHash, 'pro', 'active', new Date().toISOString()]
  );
  const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdUserIds.push(user.id);

  // Create campaign and two links (one campaign-bound, one standalone)
  const campaign = await helpers.dbGetAsync(
    'INSERT INTO campaigns (user_id, name, slug, created_at) VALUES (?, ?, ?, ?) RETURNING id, name',
    [user.id, 'P14 Print Campaign', `p14-print-${Date.now().toString(36)}`, new Date().toISOString()]
  );
  createdCampaignIds.push(campaign.id);

  const shortA = `p14a${Date.now().toString(36)}`;
  const shortB = `p14b${Date.now().toString(36)}`;
  createdShorts.push(shortA, shortB);

  const linkA = await helpers.dbGetAsync(
    'INSERT INTO urls (short, original, user_id, campaign_id, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [shortA, 'https://example.com/menu-v1', user.id, campaign.id, new Date().toISOString()]
  );
  const linkB = await helpers.dbGetAsync(
    'INSERT INTO urls (short, original, user_id, created_at) VALUES (?, ?, ?, ?) RETURNING id',
    [shortB, 'https://example.com/menu-v2', user.id, new Date().toISOString()]
  );
  for (let i = 0; i < 3; i += 1) {
    await helpers.dbRunAsync(
      'INSERT INTO clicks (url_id, click_time) VALUES (?, ?)',
      [linkB.id, new Date().toISOString()]
    );
  }
  assert.ok(linkA && linkA.id);

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
      redirect: 'manual',
    });
    return { res, data: await res.json().catch(() => ({})) };
  };

  // 1. Reject unreadable contrast colors
  const badContrast = await apiJson('POST', '/api/qr', {
    short: shortA,
    label: 'Unreadable',
    colorDark: '#dddddd',
    colorLight: '#ffffff',
  });
  assert.equal(badContrast.res.status, 400);
  assert.equal(badContrast.data.code, 'low_contrast');

  const inverted = await apiJson('POST', '/api/qr', {
    short: shortA,
    label: 'Inverted',
    colorDark: '#ffffff',
    colorLight: '#111111',
  });
  assert.equal(inverted.res.status, 400);
  assert.equal(inverted.data.code, 'inverted_contrast');

  // 2. Create print-ready QR bound to campaign link
  const createdRes = await apiJson('POST', '/api/qr', {
    short: shortA,
    label: 'A4 Table Tent',
    colorDark: '#0f172a',
    colorLight: '#ffffff',
  });
  assert.equal(createdRes.res.status, 201);
  const qr = createdRes.data.qrCode;
  createdQrIds.push(qr.id);
  assert.equal(qr.campaignId, campaign.id);
  assert.equal(qr.campaignName, 'P14 Print Campaign');
  assert.equal(qr.printReady, true);
  assert.ok(qr.contrastRatio >= 15);
  assert.ok(qr.exportUrls && qr.exportUrls.svg && qr.exportUrls.png);

  // 3. Campaign filter on GET /api/qr
  const filtered = await apiJson('GET', `/api/qr?campaign_id=${campaign.id}`);
  assert.equal(filtered.res.status, 200);
  assert.equal(filtered.data.qrCodes.length, 1);
  assert.equal(filtered.data.qrCodes[0].id, qr.id);

  const emptyFilter = await apiJson('GET', '/api/qr?campaign_id=999999');
  assert.equal(emptyFilter.res.status, 200);
  assert.equal(emptyFilter.data.qrCodes.length, 0);

  // 4. Print-safe SVG and 1024px PNG exports
  const svgRes = await fetch(`${baseUrl}/api/qr/${qr.id}/export?format=svg&size=1024&ecc=H&margin=4`, {
    headers: { cookie: authCookie },
  });
  assert.equal(svgRes.status, 200);
  assert.match(svgRes.headers.get('content-type') || '', /image\/svg\+xml/);
  assert.equal(svgRes.headers.get('x-qr-ecc'), 'H');
  assert.equal(svgRes.headers.get('x-qr-quiet-zone'), '4');
  const svgBody = await svgRes.text();
  assert.match(svgBody, /<svg[\s>]/i);

  const pngRes = await fetch(`${baseUrl}/api/qr/${qr.id}/export?format=png&size=1024&ecc=H&margin=4`, {
    headers: { cookie: authCookie },
  });
  assert.equal(pngRes.status, 200);
  assert.equal(pngRes.headers.get('content-type'), 'image/png');
  const pngBytes = Buffer.from(await pngRes.arrayBuffer());
  assert.equal(pngBytes.subarray(0, 4).toString('hex'), '89504e47');

  // 5. Scan /q/:slug before re-pointing
  const scanPath = qr.scanUrl.replace(/^https?:\/\/[^/]+/, '');
  const scan1 = await fetch(`${baseUrl}${scanPath}`, { redirect: 'manual' });
  assert.equal(scan1.status, 302);
  assert.equal(scan1.headers.get('location'), `/${shortA}`);

  // 6. Dynamic target re-pointing: switch same printed QR (/q/:slug) to shortB without changing slug
  const repoint = await apiJson('PATCH', `/api/qr/${qr.id}`, { short: shortB, label: 'A4 Table Tent v2' });
  assert.equal(repoint.res.status, 200);
  assert.equal(repoint.data.qrCode.slug, qr.slug);
  assert.equal(repoint.data.qrCode.short, shortB);
  assert.equal(repoint.data.qrCode.scanUrl, qr.scanUrl);

  const scan2 = await fetch(`${baseUrl}${scanPath}`, { redirect: 'manual' });
  assert.equal(scan2.status, 302);
  assert.equal(scan2.headers.get('location'), `/${shortB}`);

  // Wait briefly for fire-and-forget scan increment
  const scanWait = Date.now() + 2000;
  let stats;
  while (Date.now() < scanWait) {
    const statsRes = await apiJson('GET', `/api/qr/${qr.id}/stats?days=30`);
    assert.equal(statsRes.res.status, 200);
    stats = statsRes.data;
    if (stats.metrics.qr_scans_total >= 2) break;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  assert.ok(stats.metrics.qr_scans_total >= 2);
  assert.equal(stats.metrics.link_clicks_total, 3);
  assert.equal(stats.methodology.metrics_separated, true);
  assert.equal(stats.methodology.claims_sales_conversion, false);
  assert.equal(stats.lifecycle_policy.pro_expiry_preserves_assets, true);

  // 7. Pro expiry does NOT delete QR assets or break existing /q/:slug scans
  await helpers.dbRunAsync(
    "UPDATE users SET plan_tier = 'free', plan_status = 'expired' WHERE id = ?",
    [user.id]
  );
  const scanAfterExpiry = await fetch(`${baseUrl}${scanPath}`, { redirect: 'manual' });
  assert.equal(scanAfterExpiry.status, 302);
  assert.equal(scanAfterExpiry.headers.get('location'), `/${shortB}`);

  // 8. Soft delete stops scanning, preserves history & preserves underlying link
  const delRes = await apiJson('DELETE', `/api/qr/${qr.id}?lang=az`);
  assert.equal(delRes.res.status, 200);
  assert.equal(delRes.data.deleted, true);
  assert.equal(delRes.data.historical_scans_preserved, true);
  assert.equal(delRes.data.link_preserved, true);
  assert.ok(delRes.data.notice && delRes.data.notice.length > 10);

  const scanAfterDelete = await fetch(`${baseUrl}${scanPath}`, { redirect: 'manual' });
  assert.notEqual(scanAfterDelete.status, 302);

  const preservedQr = await helpers.dbGetAsync('SELECT scans, deleted_at FROM qr_codes WHERE id = ?', [qr.id]);
  assert.ok(preservedQr.deleted_at);
  assert.ok(Number(preservedQr.scans) >= 2);
  const preservedLink = await helpers.dbGetAsync('SELECT id FROM urls WHERE short = ?', [shortB]);
  assert.ok(preservedLink && preservedLink.id);
});
