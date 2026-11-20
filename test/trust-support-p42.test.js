'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const trustSupport = require('../src/lib/trust-support');
const { dbGetAsync, dbRunAsync } = require('../src/db/helpers');

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

test('P42 DB + HTTP: trust status (zero fake certs), support tickets, verified data export & deletion work end-to-end', async () => {
  await trustSupport.ensureTrustSupportTables();
  const suffix = crypto.randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();

  const uRes = await dbRunAsync(
    "INSERT INTO users (email, password, email_verified, plan_tier, plan_status, created_at) VALUES (?, ?, 1, 'free', 'active', ?)",
    [`p42-${suffix}@example.com`, '$2b$10$secretHashMustNeverLeak', nowIso]
  );
  const userId = Number(uRes.lastID);

  await dbRunAsync(
    'INSERT INTO urls (short, original, user_id, created_at) VALUES (?, ?, ?, ?)',
    [`p42${suffix.slice(0, 5)}`, 'https://example.com/privacy-test', userId, nowIso]
  );

  let activeUserId = userId;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = activeUserId ? { userId: activeUserId } : {};
    next();
  });
  app.use(require('../src/routes/api/campaigns'));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    // 1. Public trust/status endpoint — honest zero unverified certifications
    const st = await requestJson(baseUrl, 'GET', '/api/public/trust-status?lang=az');
    assert.equal(st.status, 200);
    assert.equal(st.body.overall_status, 'operational');
    assert.equal(st.body.troubleshooting.length, 4);
    assert.deepEqual(st.body.trust_disclosures.certifications_claimed, []);
    assert.ok(st.body.trust_disclosures.legal_review_checklist_az.length >= 3);

    // 2. Create & list support ticket
    const tCreate = await requestJson(baseUrl, 'POST', '/api/support/tickets', {
      category: 'custom_domain',
      subject: 'DNS TXT verification help',
      message: 'Please verify why our TXT record has not propagated yet.',
    });
    assert.equal(tCreate.status, 201);
    assert.match(tCreate.body.ticket_ref, /^SUP-/);

    const tList = await requestJson(baseUrl, 'GET', '/api/support/tickets');
    assert.equal(tList.status, 200);
    assert.equal(tList.body.tickets.length, 1);

    // 3. Self-serve data export (includes user's link & ticket, NEVER leaks password hash)
    const exp = await requestJson(baseUrl, 'GET', '/api/privacy/data-export');
    assert.equal(exp.status, 200);
    assert.equal(exp.body.contract_version, 'data-export-v1');
    assert.equal(exp.body.urls.length, 1);
    assert.equal(exp.body.support_tickets.length, 1);
    assert.equal(exp.body.account.password, undefined);
    assert.ok(!JSON.stringify(exp.body).includes('secretHashMustNeverLeak'));

    // 4. Deletion requires explicit DELETE confirmation
    const badDel = await requestJson(baseUrl, 'POST', '/api/privacy/data-delete', { confirm_text: 'no' });
    assert.equal(badDel.status, 400);

    // 5. Verified deletion removes user & personal rows and logs DSR audit record
    const del = await requestJson(baseUrl, 'POST', '/api/privacy/data-delete', { confirm_text: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, true);
    assert.match(del.body.request_ref, /^DSR-DEL-/);

    const userAfter = await dbGetAsync('SELECT id FROM users WHERE id = ?', [userId]);
    assert.equal(userAfter, undefined);

    // 6. Unauthenticated rejected with 401
    activeUserId = null;
    const unauth = await requestJson(baseUrl, 'GET', '/api/privacy/data-export');
    assert.equal(unauth.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await dbRunAsync('DELETE FROM data_subject_requests WHERE user_id = ?', [userId]).catch(() => {});
    await dbRunAsync('DELETE FROM support_tickets WHERE user_id = ?', [userId]).catch(() => {});
    await dbRunAsync('DELETE FROM urls WHERE user_id = ?', [userId]).catch(() => {});
    await dbRunAsync('DELETE FROM users WHERE id = ?', [userId]).catch(() => {});
  }
});
