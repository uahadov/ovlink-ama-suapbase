'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const redirectSlo = require('../src/lib/redirect-slo');

const safe = /^postgresql:\/\/ovlinkqa:[^@]+@localhost:55491\/ovlink_p02_qa$/.test(process.env.DATABASE_URL || '')
  && process.env.NODE_ENV === 'test';

test('P12 redirect SLO ring buffer computes p50/p95/p99 and tracks analytics failures', () => {
  redirectSlo.reset();
  for (let i = 1; i <= 100; i += 1) {
    redirectSlo.recordOutcome('delivered', i);
  }
  redirectSlo.recordOutcome('consent_redirects', 5);
  redirectSlo.recordAnalyticsFailure();
  const snap = redirectSlo.snapshot();
  assert.equal(snap.delivered, 100);
  assert.equal(snap.consent_redirects, 1);
  assert.equal(snap.analytics_failures, 1);
  assert.equal(snap.p50_ms, 50);
  assert.equal(snap.p95_ms, 95);
  assert.equal(snap.p99_ms, 99);
  redirectSlo.reset();
});

test('P12 real PG redirect reliability: consent decline=0 clicks, analytics failure resilience, multi-channel routing, gates, destination update & p95/p99 SLO', { skip: !safe && 'Disposable PG only', timeout: 60000 }, async () => {
  const { Client } = require('pg');
  const { pool } = require('../src/db/pool');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  const redirectRouter = require('../src/routes/redirect');
  const healthRouter = require('../src/routes/health');
  const analyticsLib = require('../src/lib/analytics');
  const { REDIRECT_CONSENT_COOKIE, REDIRECT_CONSENT_MODES } = require('../src/lib/consent');

  const suffix = crypto.randomBytes(5).toString('hex');
  const shortMain = `p12m${suffix}`;
  const shortDisabled = `p12d${suffix}`;
  const shortExpired = `p12e${suffix}`;
  const shortMulti = `p12u${suffix}`;
  const shortDanger = `p12w${suffix}`;
  const createdIds = [];
  let server;
  const prevHealthToken = process.env.HEALTH_TOKEN;
  const prevRecordClickSafe = analyticsLib.recordClickSafe;

  await db.connect();
  try {
    process.env.HEALTH_TOKEN = 'p12-qa-health-token';
    redirectSlo.reset();

    async function insertLink(row) {
      const res = await db.query(
        `INSERT INTO urls(original, short, created_at, disabled, expires_at, ios_url, android_url, original_b, ab_split_percent, dangerous)
         VALUES($1,$2,now(),$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          row.original,
          row.short,
          row.disabled || 0,
          row.expires_at || null,
          row.ios_url || null,
          row.android_url || null,
          row.original_b || null,
          row.ab_split_percent ?? null,
          row.dangerous || 0,
        ]
      );
      createdIds.push(res.rows[0].id);
      return res.rows[0].id;
    }

    const mainId = await insertLink({ short: shortMain, original: 'https://example.com/v1' });
    await insertLink({ short: shortDisabled, original: 'https://example.com/dis', disabled: 1 });
    await insertLink({ short: shortExpired, original: 'https://example.com/exp', expires_at: new Date(Date.now() - 60000).toISOString() });
    await insertLink({
      short: shortMulti,
      original: 'https://example.com/desktop-a',
      original_b: 'https://example.com/desktop-b',
      ab_split_percent: 0,
      ios_url: 'https://example.com/ios-app',
      android_url: 'https://example.com/android-app',
    });
    await insertLink({ short: shortDanger, original: 'https://example.com/warn', dangerous: 1 });

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => {
      res.locals._csrf = 'qa-csrf';
      req.session = { save: (cb) => cb && cb() };
      res.render = (view, locals) => res.json({ view, short: locals?.short || locals?.shortCode || null, confirmUrl: locals?.confirmUrl || null, consentView: locals?.consentView || null });
      next();
    });
    app.use(healthRouter);
    app.use(redirectRouter);

    server = app.listen(0, '127.0.0.1');
    await new Promise((done) => server.once('listening', done));
    const base = `http://127.0.0.1:${server.address().port}`;
    const consentCookie = `${REDIRECT_CONSENT_COOKIE}=${REDIRECT_CONSENT_MODES.ANALYTICS}`;

    // 1. No consent -> redirects to /consent/redirect/:short (and /consent/redirect/:short renders without ReferenceError!)
    const noConsent = await fetch(`${base}/${shortMain}`, { redirect: 'manual' });
    assert.equal(noConsent.status, 302);
    assert.equal(noConsent.headers.get('location'), `/consent/redirect/${shortMain}`);

    const consentPage = await fetch(`${base}/consent/redirect/${shortMain}`, { redirect: 'manual' });
    assert.equal(consentPage.status, 200);
    const consentBody = await consentPage.json();
    assert.equal(consentBody.view, 'redirect-consent');

    // 2. Consent decline -> redirects to ?view=declined, NEVER redirects to target, ZERO clicks recorded
    const declined = await fetch(`${base}/consent/redirect/${shortMain}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'no', next: 'redirect' }),
    });
    assert.equal(declined.status, 303);
    assert.ok((declined.headers.get('location') || '').includes('view=declined'));
    const clicksAfterDecline = (await db.query('SELECT COUNT(*)::int AS c FROM clicks WHERE url_id=$1', [mainId])).rows[0].c;
    assert.equal(clicksAfterDecline, 0, 'consent decline must record zero clicks');

    // 3. Analytics failure resilience (sync throw AND async reject NEVER block valid 302 redirect)
    analyticsLib.recordClickSafe = () => { throw new Error('simulated sync analytics outage'); };
    const rSync = await fetch(`${base}/${shortMain}`, { redirect: 'manual', headers: { cookie: consentCookie } });
    assert.equal(rSync.status, 302, 'sync analytics crash must not break redirect');
    assert.equal(rSync.headers.get('location'), 'https://example.com/v1');

    analyticsLib.recordClickSafe = () => Promise.reject(new Error('simulated async analytics outage'));
    const rAsync = await fetch(`${base}/${shortMain}`, { redirect: 'manual', headers: { cookie: consentCookie } });
    assert.equal(rAsync.status, 302, 'async analytics rejection must not break redirect');
    assert.equal(rAsync.headers.get('location'), 'https://example.com/v1');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(redirectSlo.snapshot().analytics_failures >= 2, 'analytics failures counted in SLO');

    // Restore real analytics
    analyticsLib.recordClickSafe = prevRecordClickSafe;

    // 4. Immutable short-code contract: destination update keeps same short code working immediately
    await db.query('UPDATE urls SET original=$1 WHERE id=$2', ['https://example.com/v2-updated', mainId]);
    const rUpdated = await fetch(`${base}/${shortMain}`, { redirect: 'manual', headers: { cookie: consentCookie } });
    assert.equal(rUpdated.status, 302);
    assert.equal(rUpdated.headers.get('location'), 'https://example.com/v2-updated');

    // 5. Multi-channel routing: iOS, Android, Desktop A/B split
    const rIos = await fetch(`${base}/${shortMulti}`, {
      redirect: 'manual',
      headers: { cookie: consentCookie, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
    });
    assert.equal(rIos.headers.get('location'), 'https://example.com/ios-app');

    const rAndroid = await fetch(`${base}/${shortMulti}`, {
      redirect: 'manual',
      headers: { cookie: consentCookie, 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' },
    });
    assert.equal(rAndroid.headers.get('location'), 'https://example.com/android-app');

    const rDesktopB = await fetch(`${base}/${shortMulti}`, {
      redirect: 'manual',
      headers: { cookie: consentCookie, 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
    });
    assert.equal(rDesktopB.headers.get('location'), 'https://example.com/desktop-b');

    // 6. Delivery gates: disabled (410), expired (410), dangerous (warning -> confirm token -> 302)
    assert.equal((await fetch(`${base}/${shortDisabled}`, { redirect: 'manual', headers: { cookie: consentCookie } })).status, 410);
    assert.equal((await fetch(`${base}/${shortExpired}`, { redirect: 'manual', headers: { cookie: consentCookie } })).status, 410);

    const warnRes = await fetch(`${base}/${shortDanger}`, { redirect: 'manual', headers: { cookie: consentCookie } });
    assert.equal(warnRes.status, 200);
    const warnBody = await warnRes.json();
    assert.equal(warnBody.view, 'error-warning');
    assert.ok(warnBody.confirmUrl && warnBody.confirmUrl.includes('confirm='));

    const confirmedRes = await fetch(`${base}${warnBody.confirmUrl}`, { redirect: 'manual', headers: { cookie: consentCookie } });
    assert.equal(confirmedRes.status, 302);
    assert.equal(confirmedRes.headers.get('location'), 'https://example.com/warn');

    // 7. Measure p95/p99 over 25 real PG redirects & verify privileged /api/health SLO telemetry
    for (let i = 0; i < 25; i += 1) {
      const r = await fetch(`${base}/${shortMain}`, { redirect: 'manual', headers: { cookie: consentCookie } });
      assert.equal(r.status, 302);
    }

    const publicHealth = await (await fetch(`${base}/api/health`)).json();
    assert.equal(publicHealth.checks.redirect_slo, undefined, 'redirect_slo hidden from unauthenticated /api/health');

    const privHealth = await (await fetch(`${base}/api/health`, { headers: { 'x-health-token': 'p12-qa-health-token' } })).json();
    assert.ok(privHealth.checks.redirect_slo);
    assert.ok(privHealth.checks.redirect_slo.delivered >= 25);
    assert.ok(privHealth.checks.redirect_slo.p95_ms < 500, `expected local p95 < 500ms, got ${privHealth.checks.redirect_slo.p95_ms}`);
    assert.ok(privHealth.checks.redirect_slo.p99_ms < 500, `expected local p99 < 500ms, got ${privHealth.checks.redirect_slo.p99_ms}`);
  } finally {
    analyticsLib.recordClickSafe = prevRecordClickSafe;
    if (prevHealthToken === undefined) delete process.env.HEALTH_TOKEN;
    else process.env.HEALTH_TOKEN = prevHealthToken;
    if (server) await new Promise((r) => server.close(r));
    for (const id of createdIds) {
      await db.query('DELETE FROM clicks WHERE url_id=$1', [id]).catch(() => {});
      await db.query('DELETE FROM urls WHERE id=$1', [id]).catch(() => {});
    }
    await db.end();
    await pool.end().catch(() => {});
  }
});
