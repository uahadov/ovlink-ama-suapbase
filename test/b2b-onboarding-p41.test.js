'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const b2bOnboarding = require('../src/lib/b2b-onboarding');
const { dbRunAsync } = require('../src/db/helpers');

function requestJson(baseUrl, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, baseUrl);
    const payload = body !== null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { json = null; }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('P41 DB + HTTP: real DB-backed 5-step B2B activation, skip/resume, <15m TTV & drop-off analytics', async () => {
  await b2bOnboarding.ensureB2bOnboardingTables();
  const suffix = crypto.randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();

  const uRes = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, created_at) VALUES (?, 1, 'free', 'active', ?)",
    [`p41-${suffix}@example.com`, nowIso]
  );
  const userId = Number(uRes.lastID);

  let activeUserId = userId;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = activeUserId ? { userId: activeUserId } : {};
    next();
  });
  app.use(require('../src/routes/api/onboarding'));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let wsId = null;
  let campId = null;

  try {
    // 1. Fresh account: 0/5 completed (zero fake completion)
    const s0 = await requestJson(baseUrl, 'GET', '/api/user/b2b-onboarding?lang=az');
    assert.equal(s0.status, 200);
    assert.equal(s0.body.completed_steps, 0);
    assert.equal(s0.body.completed, false);
    assert.equal(s0.body.no_repeated_popups, true);

    // 2. Save short 2-field profile
    const prof = await requestJson(baseUrl, 'POST', '/api/user/b2b-onboarding/profile', {
      account_type: 'agency',
      primary_goal: 'client_reporting',
    });
    assert.equal(prof.status, 200);
    assert.equal(prof.body.saved, true);

    // 3. Skip & Resume flow
    const sk = await requestJson(baseUrl, 'POST', '/api/user/b2b-onboarding/skip', {});
    assert.equal(sk.status, 200);
    assert.equal(sk.body.skipped, true);
    const sSkipped = await requestJson(baseUrl, 'GET', '/api/user/b2b-onboarding?lang=en');
    assert.equal(sSkipped.body.show_banner, false);

    const rs = await requestJson(baseUrl, 'POST', '/api/user/b2b-onboarding/resume', {});
    assert.equal(rs.status, 200);
    assert.equal(rs.body.skipped, false);

    // 4. Complete all 5 real DB milestones
    const ws = await dbRunAsync(
      'INSERT INTO workspaces (name, owner_user_id, created_at) VALUES (?, ?, ?)',
      [`P41 Agency ${suffix}`, userId, nowIso]
    );
    wsId = Number(ws.lastID);

    await dbRunAsync(
      "INSERT INTO custom_domains (user_id, domain, status, verification_token, created_at) VALUES (?, ?, 'active', ?, ?)",
      [userId, `go-${suffix}.example.az`, `tok_${suffix}`, nowIso]
    );

    const camp = await dbRunAsync(
      'INSERT INTO campaigns (user_id, workspace_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)',
      [userId, wsId, `P41 Camp ${suffix}`, `p41-camp-${suffix}`, nowIso]
    );
    campId = Number(camp.lastID);

    await dbRunAsync(
      'INSERT INTO urls (short, original, user_id, workspace_id, created_at) VALUES (?, ?, ?, ?, ?)',
      [`p41a${suffix.slice(0, 4)}`, 'https://example.com/a', userId, wsId, nowIso]
    );
    await dbRunAsync(
      'INSERT INTO urls (short, original, user_id, workspace_id, created_at) VALUES (?, ?, ?, ?, ?)',
      [`p41b${suffix.slice(0, 4)}`, 'https://example.com/b', userId, wsId, nowIso]
    );

    await dbRunAsync(
      `INSERT INTO report_snapshots (snapshot_id, campaign_id, owner_user_id, actor_user_id, workspace_id, report_type, surface, scope_hash, content_hash, revision, generated_at, provenance_json, summary_json)
       VALUES (?, ?, ?, ?, ?, 'campaign_decision', 'portal', ?, ?, 1, ?, '{}', '{}')`,
      [`snap_${suffix}`, campId, userId, userId, wsId, 'b'.repeat(64), 'a'.repeat(64), nowIso]
    );

    // 5. Verify 5/5 real activation + within 15m TTV
    const sDone = await requestJson(baseUrl, 'GET', '/api/user/b2b-onboarding?lang=tr');
    assert.equal(sDone.status, 200);
    assert.equal(sDone.body.completed_steps, 5);
    assert.equal(sDone.body.completed, true);
    assert.equal(sDone.body.within_15m_target, true);

    // 6. Drop-off analytics endpoint
    const analytics = await requestJson(baseUrl, 'GET', '/api/user/b2b-onboarding/analytics');
    assert.equal(analytics.status, 200);
    assert.ok(analytics.body.event_counts.profile_saved >= 1);
    assert.ok(analytics.body.event_counts.onboarding_activated >= 1);

    // 7. Unauthenticated rejected with 401
    activeUserId = null;
    const unauth = await requestJson(baseUrl, 'GET', '/api/user/b2b-onboarding');
    assert.equal(unauth.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await dbRunAsync('DELETE FROM report_snapshots WHERE owner_user_id = ?', [userId]).catch(() => {});
    await dbRunAsync('DELETE FROM urls WHERE user_id = ?', [userId]).catch(() => {});
    if (campId) await dbRunAsync('DELETE FROM campaigns WHERE id = ?', [campId]).catch(() => {});
    await dbRunAsync('DELETE FROM custom_domains WHERE user_id = ?', [userId]).catch(() => {});
    if (wsId) await dbRunAsync('DELETE FROM workspaces WHERE id = ?', [wsId]).catch(() => {});
    await dbRunAsync('DELETE FROM onboarding_events WHERE user_id = ?', [userId]).catch(() => {});
    await dbRunAsync('DELETE FROM user_onboarding_profiles WHERE user_id = ?', [userId]).catch(() => {});
    await dbRunAsync('DELETE FROM users WHERE id = ?', [userId]).catch(() => {});
  }
});
