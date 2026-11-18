'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Client } = require('pg');
const { randomBytes } = require('crypto');

const url = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(url.split('?')[0]);
test('workspace campaigns: role matrix, business export, personal isolation and link binding', {
  skip: !safeDb && 'Requires explicitly isolated ovlink QA database', timeout: 40000,
}, async () => {
  const client = new Client({ connectionString: url });
  await client.connect();
  const unique = randomBytes(6).toString('hex');
  const users = [];
  const campaigns = [];
  const links = [];
  let workspaceId, server;
  try {
    const insertUser = async (role, pro) => {
      const row = await client.query(
        'INSERT INTO users(email,email_verified,plan_tier,plan_status,created_at) VALUES ($1,1,$2,$3,$4) RETURNING id',
        [`workspace-campaign-${role}-${unique}@example.test`, pro ? 'pro' : 'free', 'active', new Date().toISOString()]
      );
      users.push(row.rows[0].id);
      return row.rows[0].id;
    };
    const owner = await insertUser('owner', true);
    const admin = await insertUser('admin', false);
    const member = await insertUser('member', false);
    const outsider = await insertUser('outsider', false);
    const ws = await client.query('INSERT INTO workspaces (name, owner_user_id, created_at) VALUES ($1,$2,$3) RETURNING id',
      [`Campaign QA ${unique}`, owner, new Date().toISOString()]);
    workspaceId = ws.rows[0].id;
    for (const [uid, role] of [[owner, 'owner'], [admin, 'admin'], [member, 'member']]) {
      await client.query('INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES ($1,$2,$3,$4)',
        [workspaceId, uid, role, new Date().toISOString()]);
    }
    const sharedLink = `ws-camp-${unique}`;
    const personalLink = `personal-${unique}`;
    await client.query('INSERT INTO urls(short,original,user_id,workspace_id,created_at) VALUES ($1,$2,$3,$4,$5)',
      [sharedLink, 'https://example.test/shared', owner, workspaceId, new Date().toISOString()]);
    links.push(sharedLink);
    await client.query('INSERT INTO urls(short,original,user_id,created_at) VALUES ($1,$2,$3,$4)',
      [personalLink, 'https://example.test/personal', member, new Date().toISOString()]);
    links.push(personalLink);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId: Number(req.get('x-test-user') || 0) }; next(); });
    app.use(require('../src/routes/api/campaigns'));
    app.use(require('../src/routes/api/workspaces'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function api(userId, method, endpoint, body) {
      const response = await fetch(base + endpoint, {
        method,
        headers: { 'x-test-user': String(userId), 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const content = response.headers.get('content-type') || '';
      return { status: response.status, body: content.includes('json') ? await response.json() : await response.text() };
    }
    const createBody = { name: `Client Launch ${unique}`, goal: 'signup', workspace_id: workspaceId };
    assert.equal((await api(member, 'POST', '/api/campaigns', createBody)).status, 403);
    await client.query("UPDATE users SET plan_tier='free' WHERE id=$1", [owner]);
    assert.equal((await api(admin, 'POST', '/api/campaigns', createBody)).status, 403, 'expired Pro owner blocks new team campaigns');
    await client.query("UPDATE users SET plan_tier='pro' WHERE id=$1", [owner]);
    assert.equal((await api(outsider, 'POST', '/api/campaigns', createBody)).status, 403);
    const created = await api(admin, 'POST', '/api/campaigns', createBody);
    assert.equal(created.status, 201, JSON.stringify(created));
    const id = created.body.campaign.id;
    campaigns.push(id);
    assert.equal(created.body.campaign.workspace_id, workspaceId);

    const listOwner = await api(owner, 'GET', '/api/campaigns');
    const listMember = await api(member, 'GET', '/api/campaigns');
    const listStranger = await api(outsider, 'GET', '/api/campaigns');
    assert.equal(listOwner.status, 200, JSON.stringify(listOwner));
    assert.ok(listOwner.body.campaigns.some(c => c.id === id && c.can_manage === true));
    assert.ok(listMember.body.campaigns.some(c => c.id === id && c.can_manage === false));
    assert.ok(!listStranger.body.campaigns.some(c => c.id === id));

    assert.equal((await api(member, 'GET', `/api/campaigns/${id}`)).status, 200);
    assert.equal((await api(outsider, 'GET', `/api/campaigns/${id}`)).status, 404);
    assert.equal((await api(member, 'PATCH', `/api/campaigns/${id}`, { goal: 'pay' })).status, 404);
    assert.equal((await api(member, 'DELETE', `/api/campaigns/${id}`)).status, 404);
    assert.equal((await api(admin, 'PATCH', `/api/campaigns/${id}`, { goal: 'pay' })).status, 200);
    await client.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [workspaceId, admin]);
    assert.equal((await api(admin, 'PATCH', `/api/campaigns/${id}`, { goal: 'revoked' })).status, 404, 'downgraded admin loses manage permission');
    await client.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspaceId, admin]);
    assert.equal((await api(member, 'GET', `/api/campaigns/${id}/export.csv`)).status, 200);
    const audit = await client.query('SELECT id FROM analytics_audit_log WHERE user_id=$1 AND action=$2', [member, 'campaign.csv.export']);
    assert.equal(audit.rowCount, 1);

    // Member can read but cannot reassign. Admin can assign shared links only.
    assert.equal((await api(member, 'POST', `/api/links/${sharedLink}/campaign`, { campaign_id: id })).status, 404);
    assert.equal((await api(admin, 'POST', `/api/links/${sharedLink}/campaign`, { campaign_id: id })).status, 200);
    assert.equal((await api(admin, 'POST', `/api/links/${personalLink}/campaign`, { campaign_id: id })).status, 404);
    const sharedRead = await api(member, 'GET', `/api/links/${sharedLink}/campaign`);
    assert.equal(sharedRead.body.campaign.id, id);
    assert.equal((await api(outsider, 'GET', `/api/links/${sharedLink}/campaign`)).status, 404);

    // Personal campaigns created by a member must remain private.
    const personal = await api(member, 'POST', '/api/campaigns', { name: `Private ${unique}` });
    assert.equal(personal.status, 201);
    campaigns.push(personal.body.campaign.id);
    const ownerListAfter = await api(owner, 'GET', '/api/campaigns');
    assert.ok(!ownerListAfter.body.campaigns.some(c => c.id === personal.body.campaign.id));

    assert.equal((await api(admin, 'DELETE', `/api/campaigns/${id}`)).status, 200);
    campaigns.splice(campaigns.indexOf(id), 1);
    const stillThere = await client.query('SELECT campaign_id FROM urls WHERE short=$1', [sharedLink]);
    assert.equal(stillThere.rows[0].campaign_id, null);
    // Deleting the workspace must not strand campaigns or break redirects.
    const second = await api(owner, 'POST', '/api/campaigns', {
      name: `Workspace sunset ${unique}`, workspace_id: workspaceId,
    });
    assert.equal(second.status, 201, JSON.stringify(second));
    const sunsetId = second.body.campaign.id;
    const assignBeforeDelete = await api(admin, 'POST', `/api/links/${sharedLink}/campaign`, { campaign_id: sunsetId });
    assert.equal(assignBeforeDelete.status, 200);
    const deleteWorkspace = await api(owner, 'DELETE', `/api/workspaces/${workspaceId}`);
    assert.equal(deleteWorkspace.status, 200, JSON.stringify(deleteWorkspace));
    const remaining = await client.query('SELECT workspace_id, campaign_id FROM urls WHERE short=$1', [sharedLink]);
    assert.equal(remaining.rowCount, 1);
    assert.equal(remaining.rows[0].workspace_id, null);
    assert.equal(remaining.rows[0].campaign_id, null);
    assert.equal((await client.query('SELECT id FROM campaigns WHERE id=$1', [sunsetId])).rowCount, 0);
    workspaceId = null;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const short of links) await client.query('DELETE FROM urls WHERE short=$1', [short]).catch(() => {});
    for (const id of campaigns) await client.query('DELETE FROM campaigns WHERE id=$1', [id]).catch(() => {});
    if (workspaceId) await client.query('DELETE FROM workspace_members WHERE workspace_id=$1', [workspaceId]).catch(() => {});
    if (workspaceId) await client.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]).catch(() => {});
    for (const uid of users) {
      await client.query('DELETE FROM analytics_audit_log WHERE user_id=$1', [uid]).catch(() => {});
      await client.query('DELETE FROM users WHERE id=$1', [uid]).catch(() => {});
    }
    await client.end();
    await require('../src/db/pool').pool.end().catch(() => {});
  }
});
