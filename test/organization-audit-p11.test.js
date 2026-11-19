'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const express = require('express');
const { pool } = require('../src/db/pool');
const {
  migrateOrganizationModel,
  migrateOrganizationRoles,
  migrateOrganizationTeam,
  migrateOrganizationClients,
  migrateOrganizationAudit,
  organizationAuditEnabled,
} = require('../src/db/organization-model');
const {
  CRITICAL_AUDIT_ACTIONS,
  sanitizeAuditSummary,
  recordBusinessAudit,
} = require('../src/lib/organization-audit');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');

const safe = /^postgresql:\/\/ovlinkqa:[^@]+@localhost:55491\/ovlink_p02_qa$/.test(process.env.DATABASE_URL || '')
  && process.env.NODE_ENV === 'test';

test('P11 quintuple opt-in is default OFF and dependency gated', () => {
  assert.equal(organizationAuditEnabled({}), false);
  assert.equal(organizationAuditEnabled({
    ENABLE_ORGANIZATION_MODEL: '1',
    ENABLE_ORGANIZATION_RBAC_V2: '1',
    ENABLE_ORGANIZATION_TEAM_V1: '1',
    ENABLE_ORGANIZATION_CLIENTS_V1: '1',
  }), false);
  assert.equal(organizationAuditEnabled({
    ENABLE_ORGANIZATION_MODEL: '1',
    ENABLE_ORGANIZATION_RBAC_V2: '1',
    ENABLE_ORGANIZATION_TEAM_V1: '1',
    ENABLE_ORGANIZATION_CLIENTS_V1: '1',
    ENABLE_ORGANIZATION_AUDIT_V1: '1',
  }), true);
});

test('P11 audit catalog has >=12 critical actions and scrubber strips secrets/tokens/PII', () => {
  assert.ok(CRITICAL_AUDIT_ACTIONS.length >= 12);
  const cleaned = sanitizeAuditSummary({
    role: 'manager',
    password: 'super-secret-password',
    api_key: 'ovk_123',
    token: 'raw-invite-token',
    webhook_secret: 'whsec_abc',
    email: 'private@example.invalid',
    nested: { authorization: 'Bearer xyz', safe_field: 'ok' },
    long_note: 'x'.repeat(500),
  });
  assert.equal(cleaned.role, 'manager');
  assert.equal(cleaned.password, undefined);
  assert.equal(cleaned.api_key, undefined);
  assert.equal(cleaned.token, undefined);
  assert.equal(cleaned.webhook_secret, undefined);
  assert.equal(cleaned.email, undefined);
  assert.equal(cleaned.nested.authorization, undefined);
  assert.equal(cleaned.nested.safe_field, 'ok');
  assert.equal(cleaned.long_note.length, 200);
});

for (const lang of ['az', 'tr', 'en']) {
  test(`P11 audit UI renders accessible ${lang} EJS with valid compiled JS`, async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/organization-audit.ejs'), {
      orgId: '5f72b11f-407f-4290-9f32-c9b338dcb984',
      lang,
      csrfToken: 'qa-csrf',
      nonce: 'qa-nonce',
    });
    assert.ok(html.includes(`lang="${lang}"`));
    assert.ok(html.includes('dir="ltr"'));
    assert.ok(html.includes('href="#mainContent"'));
    assert.ok(html.includes('id="mainContent"'));
    const m = /<script nonce="qa-nonce">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m && m[1]);
    new vm.Script(m[1]);
  });
}

test('P11 real PG business audit: idempotent migration, 5-role RBAC, filtering, pagination, fail-closed CSV export & tenant isolation', { skip: !safe && 'Disposable PG only', timeout: 60000 }, async () => {
  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  const users = [];
  const orgs = [];
  let server;
  const savedEnv = {
    ENABLE_ORGANIZATION_MODEL: process.env.ENABLE_ORGANIZATION_MODEL,
    ENABLE_ORGANIZATION_RBAC_V2: process.env.ENABLE_ORGANIZATION_RBAC_V2,
    ENABLE_ORGANIZATION_TEAM_V1: process.env.ENABLE_ORGANIZATION_TEAM_V1,
    ENABLE_ORGANIZATION_CLIENTS_V1: process.env.ENABLE_ORGANIZATION_CLIENTS_V1,
    ENABLE_ORGANIZATION_AUDIT_V1: process.env.ENABLE_ORGANIZATION_AUDIT_V1,
  };

  await db.connect();
  try {
    const env = {
      ENABLE_ORGANIZATION_MODEL: '1',
      ENABLE_ORGANIZATION_RBAC_V2: '1',
      ENABLE_ORGANIZATION_TEAM_V1: '1',
      ENABLE_ORGANIZATION_CLIENTS_V1: '1',
      ENABLE_ORGANIZATION_AUDIT_V1: '1',
    };
    Object.assign(process.env, env);
    await migrateOrganizationModel();
    await migrateOrganizationRoles({ env });
    await migrateOrganizationTeam({ env });
    await migrateOrganizationClients({ env });
    await migrateOrganizationAudit({ env });
    await migrateOrganizationAudit({ env }); // idempotent replay

    const suffix = crypto.randomBytes(6).toString('hex');
    async function mkUser(label) {
      const email = `p11-${label}-${suffix}@example.invalid`;
      const row = (await db.query(
        "INSERT INTO users(email,email_hash,email_verified,plan_tier,plan_status) VALUES($1,$2,1,'pro','active') RETURNING id",
        [encryptAES256GCM(email), blindIndex(email)]
      )).rows[0];
      users.push(row.id);
      return { id: row.id, email };
    }

    const owner = await mkUser('owner');
    const admin = await mkUser('admin');
    const manager = await mkUser('manager');
    const analyst = await mkUser('analyst');
    const viewer = await mkUser('viewer');
    const outsider = await mkUser('outsider');

    async function mkOrg(name, orgOwner) {
      const row = (await db.query(
        'INSERT INTO organizations(display_name,owner_user_id) VALUES($1,$2) RETURNING id',
        [name, orgOwner.id]
      )).rows[0];
      orgs.push(row.id);
      await db.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')", [row.id, orgOwner.id]);
      await db.query('INSERT INTO organization_billing(organization_id,billing_owner_user_id) VALUES($1,$2)', [row.id, orgOwner.id]);
      return row.id;
    }

    const orgA = await mkOrg('Audit Alpha', owner);
    const orgB = await mkOrg('Audit Beta', outsider);
    for (const [u, role] of [[admin, 'admin'], [manager, 'manager'], [analyst, 'analyst'], [viewer, 'client_viewer']]) {
      await db.query('INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)', [orgA, u.id, role]);
    }

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const id = Number(req.get('x-test-user') || 0);
      req.session = id > 0 ? { userId: id } : {};
      next();
    });
    app.use(require('../src/routes/api/organization-clients'));
    app.use(require('../src/routes/api/organization-audit'));
    app.use((_req, res, next) => {
      res.locals._csrf = 'qa-csrf';
      res.render = (view, locals) => res.status(200).json({ view, ...locals });
      next();
    });
    app.use(require('../src/routes/public'));

    server = app.listen(0, '127.0.0.1');
    await new Promise((done) => server.once('listening', done));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function call(actor, method, route, body) {
      const headers = { 'content-type': 'application/json', 'x-request-id': 'req-p11-' + suffix };
      if (actor) headers['x-test-user'] = String(actor.id);
      const r = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let parsed = text;
      try { parsed = JSON.parse(text); } catch {}
      return { status: r.status, body: parsed, text };
    }

    // Create client + export CSV (must write fail-closed organization.client.report_exported audit row)
    const cRes = await call(owner, 'POST', `/api/organizations/${orgA}/clients`, { name: '=HYPERLINK("https://evil.test")' });
    assert.equal(cRes.status, 201);
    const clientId = cRes.body.client.id;
    const csvRep = await call(owner, 'GET', `/api/organizations/${orgA}/clients/${clientId}/report.csv`);
    assert.equal(csvRep.status, 200);

    // Record structured audit entry with sensitive keys that MUST be scrubbed
    const { withTransaction } = require('../src/db/helpers');
    await withTransaction(async (tx) => {
      await recordBusinessAudit(tx, {
        organizationId: orgA,
        actorUserId: admin.id,
        action: 'organization.billing.updated',
        resourceType: 'billing',
        resourceId: orgA,
        requestId: 'req-scrub-' + suffix,
        result: 'denied',
        summary: { plan: 'agency', secret_token: 'MUST_NOT_LEAK', password: 'NOPE' },
      });
      await recordBusinessAudit(tx, {
        organizationId: orgB,
        actorUserId: outsider.id,
        action: 'organization.created',
        resourceType: 'organization',
        resourceId: orgB,
        result: 'success',
        summary: { note: 'orgB-only' },
      });
    });

    // RBAC on audit-log API & UI: Owner/Admin 200; Manager/Analyst/Viewer/Outsider 404
    assert.equal((await call(owner, 'GET', `/api/organizations/${orgA}/audit-log`)).status, 200);
    assert.equal((await call(admin, 'GET', `/api/organizations/${orgA}/audit-log`)).status, 200);
    assert.equal((await call(manager, 'GET', `/api/organizations/${orgA}/audit-log`)).status, 404);
    assert.equal((await call(analyst, 'GET', `/api/organizations/${orgA}/audit-log`)).status, 404);
    assert.equal((await call(viewer, 'GET', `/api/organizations/${orgA}/audit-log`)).status, 404);
    assert.equal((await call(outsider, 'GET', `/api/organizations/${orgA}/audit-log`)).status, 404);

    assert.equal((await call(owner, 'GET', `/organizations/${orgA}/audit`)).status, 200);
    assert.equal((await call(manager, 'GET', `/organizations/${orgA}/audit`)).status, 404);

    // Verify filtering, scrubbing, and tenant isolation
    const allA = await call(owner, 'GET', `/api/organizations/${orgA}/audit-log?limit=2`);
    assert.equal(allA.body.events.length, 2);
    assert.ok(allA.body.next_before_id, 'cursor pagination returns next_before_id');
    assert.equal(allA.body.events.some((e) => e.summary?.note === 'orgB-only'), false, 'strict tenant isolation');

    const deniedOnly = await call(owner, 'GET', `/api/organizations/${orgA}/audit-log?result=denied`);
    assert.equal(deniedOnly.body.events.length, 1);
    assert.equal(deniedOnly.body.events[0].action, 'organization.billing.updated');
    assert.equal(deniedOnly.body.events[0].summary.secret_token, undefined, 'secret_token scrubbed');
    assert.equal(deniedOnly.body.events[0].summary.password, undefined, 'password scrubbed');

    const repExported = await call(owner, 'GET', `/api/organizations/${orgA}/audit-log?action=organization.client.report_exported`);
    assert.equal(repExported.body.events.length, 1, 'fail-closed client CSV export recorded');

    // Audit CSV export itself records organization.audit.exported
    const auditCsv = await call(owner, 'GET', `/api/organizations/${orgA}/audit-log.csv`);
    assert.equal(auditCsv.status, 200);
    assert.ok(auditCsv.text.includes('organization.client.report_exported'));
    const exportAuditCheck = await call(owner, 'GET', `/api/organizations/${orgA}/audit-log?action=organization.audit.exported`);
    assert.equal(exportAuditCheck.body.events.length, 1, 'audit CSV export self-audited');
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (server) await new Promise((r) => server.close(r));
    for (const id of orgs.reverse()) await db.query('DELETE FROM organizations WHERE id=$1', [id]).catch(() => {});
    for (const id of users.reverse()) await db.query('DELETE FROM users WHERE id=$1', [id]).catch(() => {});
    await db.end();
    await pool.end().catch(() => {});
  }
});
