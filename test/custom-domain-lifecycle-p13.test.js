'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const customDomain = require('../src/lib/custom-domain');
const dnsVerify = require('../src/lib/dns-verify');

const safe = /^postgresql:\/\/ovlinkqa:[^@]+@localhost:55491\/ovlink_p02_qa$/.test(process.env.DATABASE_URL || '')
  && process.env.NODE_ENV === 'test';

test('P13 sandbox DNS/TLS verifier and state machine without live DNS', async () => {
  const token = 'abc123verifytoken';
  const target = 'ovlink.sbs';

  // 1. TXT missing -> pending_verification
  const r1 = await dnsVerify.verifyCustomDomainDns('go.brand.example', token, {
    expectedTarget: target,
    resolver: { resolveTxt: async () => [], resolveCname: async () => [], resolveAddresses: async () => [] },
  });
  assert.equal(r1.reasonCode, 'txt_missing');
  assert.deepEqual(dnsVerify.classifyDomainVerification(r1, { previousStatus: 'pending_verification' }), { status: 'pending_verification', degraded: false });

  // 2. TXT mismatch -> txt_mismatch
  const r2 = await dnsVerify.verifyCustomDomainDns('go.brand.example', token, {
    expectedTarget: target,
    resolver: { resolveTxt: async () => ['wrong-token'], resolveCname: async () => [], resolveAddresses: async () => [] },
  });
  assert.equal(r2.reasonCode, 'txt_mismatch');

  // 3. TXT valid, routing missing -> pending_routing
  const r3 = await dnsVerify.verifyCustomDomainDns('go.brand.example', token, {
    expectedTarget: target,
    resolver: { resolveTxt: async () => [`ovlink-verify=${token}`], resolveCname: async () => [], resolveAddresses: async () => [] },
  });
  assert.equal(r3.reasonCode, 'routing_missing');
  assert.deepEqual(dnsVerify.classifyDomainVerification(r3, { previousStatus: 'pending_verification' }), { status: 'pending_routing', degraded: false });

  // 4. TXT + CNAME + TLS valid -> active
  const r4 = await dnsVerify.verifyCustomDomainDns('go.brand.example', token, {
    expectedTarget: target,
    resolver: { resolveTxt: async () => [token], resolveCname: async () => [target], resolveAddresses: async () => [] },
    tlsProbe: async () => ({ ok: true }),
  });
  assert.equal(r4.reasonCode, 'ok');
  assert.equal(r4.tlsOk, true);
  assert.deepEqual(dnsVerify.classifyDomainVerification(r4, { previousStatus: 'pending_routing' }), { status: 'active', degraded: false });

  // 5. Previously active domain fails TLS -> degraded
  const r5 = await dnsVerify.verifyCustomDomainDns('go.brand.example', token, {
    expectedTarget: target,
    resolver: { resolveTxt: async () => [token], resolveCname: async () => [target], resolveAddresses: async () => [] },
    tlsProbe: async () => ({ ok: false }),
  });
  assert.equal(r5.reasonCode, 'tls_failed');
  assert.deepEqual(dnsVerify.classifyDomainVerification(r5, { previousStatus: 'active' }), { status: 'degraded', degraded: true });

  // 6. Localized AZ/TR/EN guidance exists for all reason codes
  for (const code of ['ok', 'txt_missing', 'txt_mismatch', 'routing_missing', 'tls_failed']) {
    for (const lang of ['az', 'tr', 'en']) {
      const msg = dnsVerify.describeDomainStatus(code, lang, { degraded: code !== 'ok' });
      assert.ok(typeof msg === 'string' && msg.length > 10);
    }
  }
});

test('P13 inactive/degraded custom domain never redirects to misconfigured host', () => {
  customDomain.replaceCustomDomainCache(['go.active.example']);
  try {
    // Active custom domain: allowed on matching host, canonical redirect from default host
    assert.deepEqual(customDomain.getShortHostAccess({ domain_host: 'go.active.example' }, 'go.active.example'), { allowed: true, redirectHost: null });
    assert.deepEqual(customDomain.getShortHostAccess({ domain_host: 'go.active.example' }, 'ovlink.sbs'), { allowed: false, redirectHost: 'go.active.example' });

    // Degraded / inactive custom domain: MUST NOT redirect to broken host
    const inactive = customDomain.getShortHostAccess({ domain_host: 'go.broken.example' }, 'ovlink.sbs');
    assert.equal(inactive.allowed, false);
    assert.equal(inactive.redirectHost, null);
    assert.equal(inactive.reason, 'domain_inactive');
  } finally {
    customDomain.resetCustomDomainCacheState();
  }
});

test('P13 real PG custom domain lifecycle: ownership collision 409, reserved host 400, verify->active->degraded, safe detach & delete', { skip: !safe && 'Disposable PG only', timeout: 60000 }, async () => {
  const { Client } = require('pg');
  const { pool } = require('../src/db/pool');
  const { encryptAES256GCM, blindIndex } = require('../utils/crypto');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  const router = require('../src/routes/api/custom-domains');

  const suffix = crypto.randomBytes(5).toString('hex');
  const domainName = `go-${suffix}.brand.example`;
  const users = [];
  const urlIds = [];
  let server;
  const prevVerify = dnsVerify.verifyCustomDomainDns;

  await db.connect();
  try {
    async function mkUser(label) {
      const email = `p13-${label}-${suffix}@example.invalid`;
      const row = (await db.query(
        "INSERT INTO users(email,email_hash,email_verified,plan_tier,plan_status) VALUES($1,$2,1,'pro','active') RETURNING id",
        [encryptAES256GCM(email), blindIndex(email)]
      )).rows[0];
      users.push(row.id);
      return row.id;
    }

    const userA = await mkUser('a');
    const userB = await mkUser('b');

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const id = Number(req.get('x-test-user') || 0);
      req.session = id > 0 ? { userId: id } : {};
      next();
    });
    app.use(router);

    server = app.listen(0, '127.0.0.1');
    await new Promise((done) => server.once('listening', done));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function call(uid, method, route, body) {
      const r = await fetch(base + route, {
        method,
        headers: { 'content-type': 'application/json', 'x-test-user': String(uid) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }

    // 1. Reserved/internal hosts rejected (400)
    assert.equal((await call(userA, 'POST', '/api/domains/add', { domain: 'localhost', lang: 'az' })).status, 400);
    assert.equal((await call(userA, 'POST', '/api/domains/add', { domain: 'sub.ovlink.sbs', lang: 'az' })).status, 400);

    // 2. User A adds branded domain
    const added = await call(userA, 'POST', '/api/domains/add', { domain: domainName, lang: 'az' });
    assert.equal(added.status, 200);
    assert.equal(added.body.domain.status, 'pending_verification');
    const domainId = added.body.domain.id;

    // 3. Ownership collision: User B cannot claim same domain (409)
    const collision = await call(userB, 'POST', '/api/domains/add', { domain: domainName.toUpperCase(), lang: 'en' });
    assert.equal(collision.status, 409);

    // 4. Sandbox DNS verify -> active
    dnsVerify.verifyCustomDomainDns = async () => ({
      txtHost: `_ovlink-challenge.${domainName}`,
      txtValues: [added.body.domain.verification_token],
      cnameValues: ['ovlink.sbs'],
      domainAddresses: [],
      expectedTarget: 'ovlink.sbs',
      expectedTargetAddresses: [],
      ownershipVerified: true,
      routingReady: true,
      tlsOk: true,
      reasonCode: 'ok',
    });
    const verified = await call(userA, 'POST', '/api/domains/verify', { domain_id: domainId, lang: 'az' });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.domain.status, 'active');
    assert.equal(verified.body.diagnostics.reason_code, 'ok');
    assert.equal(verified.body.diagnostics.degraded, false);

    // 5. DNS breaks on active domain -> transitions to degraded with warning
    dnsVerify.verifyCustomDomainDns = async () => ({
      txtHost: `_ovlink-challenge.${domainName}`,
      txtValues: [added.body.domain.verification_token],
      cnameValues: [],
      domainAddresses: [],
      expectedTarget: 'ovlink.sbs',
      expectedTargetAddresses: [],
      ownershipVerified: true,
      routingReady: false,
      tlsOk: null,
      reasonCode: 'routing_missing',
    });
    const degraded = await call(userA, 'POST', '/api/domains/verify', { domain_id: domainId, lang: 'az' });
    assert.equal(degraded.status, 200);
    assert.equal(degraded.body.domain.status, 'degraded');
    assert.equal(degraded.body.diagnostics.degraded, true);
    assert.equal(degraded.body.diagnostics.reason_code, 'routing_missing');

    // 6. Safe detach moves link back to default host without deleting link or domain
    const shortCode = `p13l${suffix}`;
    const uRow = (await db.query(
      'INSERT INTO urls(original,short,created_at,user_id,domain_host) VALUES($1,$2,now(),$3,$4) RETURNING id',
      ['https://example.com/branded', shortCode, userA, domainName]
    )).rows[0];
    urlIds.push(uRow.id);

    const detached = await call(userA, 'POST', '/api/domains/detach', { domain_id: domainId, lang: 'az' });
    assert.equal(detached.status, 200);
    assert.equal(detached.body.detached_links, 1);
    const linkAfterDetach = (await db.query('SELECT short, domain_host FROM urls WHERE id=$1', [uRow.id])).rows[0];
    assert.equal(linkAfterDetach.short, shortCode);
    assert.equal(linkAfterDetach.domain_host, null);

    // 7. Delete domain succeeds cleanly and preserves link
    const deleted = await call(userA, 'POST', '/api/domains/delete', { domain_id: domainId, lang: 'az' });
    assert.equal(deleted.status, 200);
    const linkAfterDelete = (await db.query('SELECT short FROM urls WHERE id=$1', [uRow.id])).rows[0];
    assert.equal(linkAfterDelete.short, shortCode);
  } finally {
    dnsVerify.verifyCustomDomainDns = prevVerify;
    customDomain.resetCustomDomainCacheState();
    if (server) await new Promise((r) => server.close(r));
    for (const id of urlIds) await db.query('DELETE FROM urls WHERE id=$1', [id]).catch(() => {});
    for (const id of users) {
      await db.query('DELETE FROM custom_domains WHERE user_id=$1', [id]).catch(() => {});
      await db.query('DELETE FROM users WHERE id=$1', [id]).catch(() => {});
    }
    await db.end();
    await pool.end().catch(() => {});
  }
});
