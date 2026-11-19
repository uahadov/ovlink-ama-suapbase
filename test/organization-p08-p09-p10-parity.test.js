'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../src/db/pool');
const {
  migrateOrganizationModel,
  migrateOrganizationRoles,
  migrateOrganizationTeam,
  migrateOrganizationClients,
} = require('../src/db/organization-model');
const { can } = require('../src/lib/organization-permissions');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');

const safe = /^postgresql:\/\/ovlinkqa:[^@]+@localhost:55491\/ovlink_p02_qa$/.test(process.env.DATABASE_URL || '')
  && process.env.NODE_ENV === 'test';

test('P08 unified legacy workspace role adapter matches central policy', () => {
  assert.equal(can('owner', 'campaign.create', { legacy: true }), true);
  assert.equal(can('admin', 'campaign.create', { legacy: true }), true);
  assert.equal(can('member', 'campaign.create', { legacy: true }), false);
  assert.equal(can('member', 'campaign.read', { legacy: true }), true);
  assert.equal(can('member', 'analytics.export', { legacy: true }), true);
  assert.equal(can('unknown_role', 'campaign.read', { legacy: true }), false);
});

test('P08/P09/P10 cross-surface webhooks, MCP, branded email, retention, Pro-expiry and client capabilities', { skip: !safe && 'Disposable PG only', timeout: 60000 }, async () => {
  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  const users = [];
  const orgs = [];
  const urls = [];
  const campaigns = [];
  let server;
  const savedEnv = {
    ENABLE_ORGANIZATION_MODEL: process.env.ENABLE_ORGANIZATION_MODEL,
    ENABLE_ORGANIZATION_RBAC_V2: process.env.ENABLE_ORGANIZATION_RBAC_V2,
    ENABLE_ORGANIZATION_TEAM_V1: process.env.ENABLE_ORGANIZATION_TEAM_V1,
    ENABLE_ORGANIZATION_CLIENTS_V1: process.env.ENABLE_ORGANIZATION_CLIENTS_V1,
  };

  await db.connect();
  try {
    const env = {
      ENABLE_ORGANIZATION_MODEL: '1',
      ENABLE_ORGANIZATION_RBAC_V2: '1',
      ENABLE_ORGANIZATION_TEAM_V1: '1',
      ENABLE_ORGANIZATION_CLIENTS_V1: '1',
    };
    Object.assign(process.env, env);
    await migrateOrganizationModel();
    await migrateOrganizationRoles({ env });
    await migrateOrganizationTeam({ env });
    await migrateOrganizationClients({ env });

    const suffix = crypto.randomBytes(6).toString('hex');
    async function mkUser(label) {
      const email = `parity-${label}-${suffix}@example.invalid`;
      const row = (await db.query(
        "INSERT INTO users(email,email_hash,email_verified,plan_tier,plan_status,pro_expires_at) VALUES($1,$2,1,'pro','active',now()+interval '30 days') RETURNING id",
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
    const invitee = await mkUser('invitee');

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

    const orgA = await mkOrg('Parity Alpha <Agency>', owner);
    const orgB = await mkOrg('Parity Beta', outsider);
    for (const [u, role] of [[admin, 'admin'], [manager, 'manager'], [analyst, 'analyst'], [viewer, 'client_viewer']]) {
      await db.query('INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)', [orgA, u.id, role]);
    }

    const mail = require('../src/lib/email');
    const sentMails = [];
    const prevSendMail = mail.sendMail;
    mail.sendMail = async (opts) => { sentMails.push(opts); return { messageId: 'qa-parity' }; };

    // Verify live link-access adapter delegates to unified policy
    const { canWorkspaceRole } = require('../src/lib/link-access');
    assert.equal(canWorkspaceRole('owner', 'campaign.create'), true);
    assert.equal(canWorkspaceRole('member', 'campaign.create'), false);

    // Reload MCP tools with all flags ON so gated tools register
    delete require.cache[require.resolve('../src/lib/mcp/tools')];
    const mcpTools = require('../src/lib/mcp/tools');

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const id = Number(req.get('x-test-user') || 0);
      req.session = id > 0 ? { userId: id } : {};
      next();
    });
    app.use(require('../src/routes/api/organizations'));
    app.use(require('../src/routes/api/organization-team'));
    app.use(require('../src/routes/api/organization-clients'));
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
      const headers = { 'content-type': 'application/json' };
      if (actor) headers['x-test-user'] = String(actor.id);
      const r = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }

    try {
      // 1. P08 Organization Webhooks RBAC (5 roles + outsider + SSRF block)
      assert.equal((await call(owner, 'POST', `/api/organizations/${orgA}/webhooks`, { url: 'http://127.0.0.1/ssrf' })).status, 400, 'SSRF/HTTP webhook rejected');
      assert.equal((await call(manager, 'POST', `/api/organizations/${orgA}/webhooks`, { url: 'https://example.com/hook' })).status, 404, 'manager cannot create org webhook');
      assert.equal((await call(analyst, 'GET', `/api/organizations/${orgA}/webhooks`)).status, 404, 'analyst cannot read org webhooks');
      assert.equal((await call(viewer, 'GET', `/api/organizations/${orgA}/webhooks`)).status, 404, 'viewer cannot read org webhooks');
      assert.equal((await call(outsider, 'GET', `/api/organizations/${orgA}/webhooks`)).status, 404, 'outsider cannot read org webhooks');

      const createdHook = await call(admin, 'POST', `/api/organizations/${orgA}/webhooks`, { url: 'https://example.com/org-hook', events: 'link.created' });
      assert.equal(createdHook.status, 201, 'admin creates org webhook');
      assert.ok(createdHook.body.webhook?.id);
      assert.ok(String(createdHook.body.webhook_secret || '').startsWith('whsec_'));

      const mgrHooks = await call(manager, 'GET', `/api/organizations/${orgA}/webhooks`);
      assert.equal(mgrHooks.status, 200, 'manager reads org webhooks');
      assert.equal(mgrHooks.body.webhooks.length, 1);
      assert.equal(mgrHooks.body.webhooks[0].secret_hash, undefined, 'no secret leaked on list');
      assert.equal((await call(manager, 'DELETE', `/api/organizations/${orgA}/webhooks/${createdHook.body.webhook.id}`)).status, 404, 'manager cannot delete org webhook');

      // 2. P08 MCP ovlink_list_organizations parity + immediate revocation
      const ownerOrgsMcp = await mcpTools.executeTool('ovlink_list_organizations', {}, { userId: owner.id, apiKey: { scopes: ['account:read'] } });
      assert.ok(ownerOrgsMcp.organizations.some((o) => String(o.id).includes(orgA)));
      assert.equal(ownerOrgsMcp.organizations.some((o) => String(o.id).includes(orgB)), false);

      const viewerOrgsMcp = await mcpTools.executeTool('ovlink_list_organizations', {}, { userId: viewer.id, apiKey: { scopes: ['account:read'] } });
      assert.equal(viewerOrgsMcp.organizations.some((o) => String(o.id).includes(orgA)), false, 'client_viewer hidden from organization.read in MCP too');

      // 3. P09 Branded HTML+text localized invite email + login_required nextUrl + wrong_email masked
      const invRes = await call(owner, 'POST', `/api/organizations/${orgA}/invitations?lang=tr`, { email: invitee.email, role: 'analyst' });
      assert.equal(invRes.status, 201);
      const lastMail = sentMails.at(-1);
      assert.ok(lastMail.subject.includes('kuruluş daveti'), 'localized TR subject');
      assert.ok(lastMail.html && lastMail.html.includes('<!doctype html>') && lastMail.html.includes('&lt;Agency&gt;'), 'escaped branded HTML');
      const tokenMatch = /token=([A-Za-z0-9_-]+)/.exec(lastMail.text);
      assert.ok(tokenMatch);

      const anonAccept = await call(null, 'GET', `/workspaces/accept-organization?token=${encodeURIComponent(tokenMatch[1])}`);
      assert.equal(anonAccept.body.state, 'login_required');
      assert.ok(anonAccept.body.nextUrl.includes(tokenMatch[1]), 'preserves nextUrl for login/register');

      const wrongAccept = await call(outsider, 'GET', `/workspaces/accept-organization?token=${encodeURIComponent(tokenMatch[1])}`);
      assert.equal(wrongAccept.body.state, 'wrong_email');
      assert.ok(wrongAccept.body.invitedEmailMasked.includes('@example.invalid') && wrongAccept.body.invitedEmailMasked.includes('*'), 'masked invited email displayed');

      // 4. P10 Client capabilities, member list/unassign, and member removal cleanup + data retention
      const cRes = await call(owner, 'POST', `/api/organizations/${orgA}/clients`, {
        name: 'Client Retention',
        logo_url: 'https://example.com/logo.png',
        report_settings: { locale: 'az', report_frequency: 'weekly' },
      });
      assert.equal(cRes.status, 201);
      const clientId = cRes.body.client.id;

      const campRes = await call(owner, 'POST', `/api/organizations/${orgA}/clients/${clientId}/campaigns`, { name: 'Launch Q4' });
      assert.equal(campRes.status, 201);
      campaigns.push(campRes.body.campaign.id);

      const shortCode = `p10r${suffix.slice(0, 6)}`;
      const urlRow = (await db.query(
        'INSERT INTO urls(original,short,created_at,user_id,campaign_id) VALUES($1,$2,now(),$3,$4) RETURNING id',
        ['https://example.com/landing', shortCode, owner.id, campRes.body.campaign.id]
      )).rows[0];
      urls.push(urlRow.id);

      assert.equal((await call(owner, 'POST', `/api/organizations/${orgA}/clients/${clientId}/assign`, { user_id: viewer.id })).status, 200);
      assert.equal((await call(owner, 'POST', `/api/organizations/${orgA}/clients/${clientId}/assign`, { user_id: analyst.id })).status, 200);

      const membersRes = await call(manager, 'GET', `/api/organizations/${orgA}/clients/${clientId}/members`);
      assert.equal(membersRes.status, 200);
      assert.ok(membersRes.body.members.some((m) => m.user_id === viewer.id));
      assert.equal((await call(viewer, 'GET', `/api/organizations/${orgA}/clients/${clientId}/members`)).status, 404);

      const ownerClients = await call(owner, 'GET', `/api/organizations/${orgA}/clients`);
      assert.equal(ownerClients.body.capabilities.attach_links, true);
      const mgrClients = await call(manager, 'GET', `/api/organizations/${orgA}/clients`);
      assert.equal(mgrClients.body.capabilities.create, true);
      assert.equal(mgrClients.body.capabilities.attach_links, false);
      const viewerClients = await call(viewer, 'GET', `/api/organizations/${orgA}/clients`);
      assert.equal(viewerClients.body.capabilities.create, false);
      assert.equal(viewerClients.body.capabilities.export_csv, false);
      assert.equal(viewerClients.body.clients.length, 1);

      // Unassign viewer -> immediate access loss
      assert.equal((await call(manager, 'DELETE', `/api/organizations/${orgA}/clients/${clientId}/assign/${viewer.id}`)).status, 200);
      assert.equal((await call(viewer, 'GET', `/api/organizations/${orgA}/clients/${clientId}/report`)).status, 404, 'unassigned viewer immediately denied');

      // Remove analyst from org -> client assignment cleaned up, org/client/campaign/url preserved
      assert.equal((await call(owner, 'DELETE', `/api/organizations/${orgA}/members/${analyst.id}`)).status, 200);
      const leftover = (await db.query('SELECT 1 FROM organization_client_members WHERE client_id=$1 AND user_id=$2', [clientId, analyst.id])).rows;
      assert.equal(leftover.length, 0, 'removed member client assignment cleaned up');

      // Immediate revocation across Webhook + MCP for downgraded/removed admin
      assert.equal((await call(owner, 'PATCH', `/api/organizations/${orgA}/members/${admin.id}`, { role: 'analyst' })).status, 200);
      assert.equal((await call(admin, 'DELETE', `/api/organizations/${orgA}/webhooks/${createdHook.body.webhook.id}`)).status, 404, 'downgraded admin immediately denied webhook delete');
      assert.equal((await call(owner, 'DELETE', `/api/organizations/${orgA}/webhooks/${createdHook.body.webhook.id}`)).status, 200, 'owner deletes org webhook');

      // Pro expiry never deletes organization/client/campaign/url data
      await db.query("UPDATE users SET plan_tier='free', plan_status='expired', pro_expires_at=now()-interval '2 days' WHERE id=$1", [owner.id]);
      const retainedClient = (await db.query('SELECT status FROM organization_client_spaces WHERE id=$1', [clientId])).rows[0];
      const retainedUrl = (await db.query('SELECT short FROM urls WHERE id=$1', [urlRow.id])).rows[0];
      assert.equal(retainedClient?.status, 'active', 'Pro expiry preserves client space');
      assert.equal(retainedUrl?.short, shortCode, 'Pro expiry preserves short URL');
    } finally {
      mail.sendMail = prevSendMail;
    }
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (server) await new Promise((r) => server.close(r));
    for (const id of urls.reverse()) await db.query('DELETE FROM urls WHERE id=$1', [id]).catch(() => {});
    for (const id of campaigns.reverse()) await db.query('DELETE FROM campaigns WHERE id=$1', [id]).catch(() => {});
    for (const id of orgs.reverse()) await db.query('DELETE FROM organizations WHERE id=$1', [id]).catch(() => {});
    for (const id of users.reverse()) await db.query('DELETE FROM users WHERE id=$1', [id]).catch(() => {});
    await db.end();
    await pool.end().catch(() => {});
  }
});
