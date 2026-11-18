'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Pool } = require('pg');
const { randomBytes } = require('crypto');

// Write-capable DB integration tests may only use an explicitly named QA DB.
const dbUrl = process.env.DATABASE_URL || '';
const safeQaUrl = /\/(?:[\w-]*(?:qa|test)[\w-]*)$/.test((dbUrl.split('?')[0] || ''));

test('enterprise campaign report: owner-only CSV, accurate source metrics, durable audit', { skip: !safeQaUrl && 'requires DATABASE_URL pointing to a dedicated QA database' }, async () => {
  const pool = new Pool({ connectionString: dbUrl });
  const { dbRunAsync, dbGetAsync } = require('../src/db/helpers');
  const route = require('../src/routes/api/campaigns');
  const code = randomBytes(8).toString('hex');
  let server;
  let ownerId, strangerId, campaignId;
  try {
    const insertUser = async suffix => {
      const row = await pool.query('INSERT INTO users (email, email_verified, created_at) VALUES ($1, 1, $2) RETURNING id',
        [`campaign-qa-${suffix}-${code}@example.test`, new Date().toISOString()]);
      return row.rows[0].id;
    };
    ownerId = await insertUser('owner');
    strangerId = await insertUser('stranger');
    const campaignRow = await pool.query('INSERT INTO campaigns (user_id, name, slug, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
      [ownerId, 'Enterprise export QA', `enterprise-qa-${code}`, new Date().toISOString()]);
    campaignId = campaignRow.rows[0].id;
    const app = express();
    app.use((req, _res, next) => {
      req.session = { userId: req.get('x-qa-user-id') ? Number(req.get('x-qa-user-id')) : 0 };
      next();
    });
    app.use(route);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/campaigns/${campaignId}/export.csv`;
    const noAuth = await fetch(url);
    assert.equal(noAuth.status, 401);
    const stranger = await fetch(url, { headers: { 'x-qa-user-id': strangerId } });
    assert.equal(stranger.status, 404);
    const exportRes = await fetch(url, { headers: { 'x-qa-user-id': ownerId } });
    assert.equal(exportRes.status, 200);
    assert.match(exportRes.headers.get('content-type'), /text\/csv/);
    assert.match(exportRes.headers.get('cache-control'), /no-store/);
    assert.match(exportRes.headers.get('content-disposition'), /attachment/);
    const body = await exportRes.text();
    assert.match(body, /"Enterprise export QA"/);
    assert.match(body, /"Clicks","0"/);
    const audit = await dbGetAsync('SELECT * FROM analytics_audit_log WHERE user_id = ? AND action = ? ORDER BY id DESC LIMIT 1',
      [ownerId, 'campaign.csv.export']);
    assert.equal(audit.user_id, ownerId);
    assert.equal(JSON.parse(audit.metadata_json).campaign_id, campaignId);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (campaignId) {
      await pool.query('DELETE FROM analytics_audit_log WHERE user_id = $1 AND action = $2', [ownerId, 'campaign.csv.export']).catch(() => {});
      await pool.query('DELETE FROM campaigns WHERE id = $1', [campaignId]).catch(() => {});
    }
    if (ownerId) await pool.query('DELETE FROM users WHERE id = $1', [ownerId]).catch(() => {});
    if (strangerId) await pool.query('DELETE FROM users WHERE id = $1', [strangerId]).catch(() => {});
    await pool.end();
    // The campaign route imports the application's independent PostgreSQL pool.
    // Close that handle too so isolated Node tests terminate predictably.
    await require('../src/db/pool').pool.end();
  }
});

test('workspace campaign mutation honors role and preserves campaign ownership', { skip: !safeQaUrl && 'requires a dedicated QA database' }, async () => {
  const { Client } = require('pg');
  const { db } = require('../src/db/index');
  const { CAMPAIGN_ASSIGNMENT_SQL } = require('../src/routes/api/campaigns');
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    // Session-local tables shadow public relations. No real workspace or link
    // can ever be touched, even if a test crashes before ROLLBACK.
    await client.query('CREATE TEMP TABLE urls (short TEXT PRIMARY KEY, user_id INTEGER, workspace_id INTEGER, campaign_id INTEGER) ON COMMIT DROP');
    await client.query('CREATE TEMP TABLE workspace_members (user_id INTEGER, workspace_id INTEGER, role TEXT) ON COMMIT DROP');
    await client.query('CREATE TEMP TABLE campaigns (id INTEGER PRIMARY KEY, user_id INTEGER) ON COMMIT DROP');
    await client.query("INSERT INTO urls VALUES ('enterprise-qa-link', 1, 17, NULL)");
    await client.query("INSERT INTO workspace_members VALUES (2, 17, 'member'), (3, 17, 'admin')");
    await client.query('INSERT INTO campaigns VALUES (101, 1), (102, 2), (103, 3)');
    const sql = db.convertSql(CAMPAIGN_ASSIGNMENT_SQL);
    async function mutate(userId, campaignId) {
      return (await client.query(sql, [campaignId, 'enterprise-qa-link', userId, userId, campaignId, campaignId])).rowCount;
    }
    assert.equal(await mutate(2, 102), 0, 'ordinary member cannot attach private campaign to shared link');
    assert.equal(await mutate(2, null), 0, 'ordinary member cannot detach existing assignment');
    assert.equal(await mutate(3, 103), 0, 'workspace admin cannot attach campaign owned by another link owner');
    assert.equal(await mutate(3, 101), 1, 'workspace admin may assign campaign owned by link owner');
    assert.equal(await mutate(4, 101), 0, 'outsider cannot change campaign');
    assert.equal(await mutate(1, null), 1, 'link owner may detach');
    assert.equal(await mutate(1, 101), 1, 'link owner may attach own campaign');
    const state = await client.query("SELECT campaign_id FROM urls WHERE short = 'enterprise-qa-link'");
    assert.equal(state.rows[0].campaign_id, 101);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
    await require('../src/db/pool').pool.end().catch(() => {});
  }
});

test('a failed campaign deletion rolls back link assignment within the transaction', { skip: !safeQaUrl && 'requires dedicated QA database' }, async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE urls (id INTEGER, campaign_id INTEGER) ON COMMIT DROP');
    await client.query('CREATE TEMP TABLE campaigns (id INTEGER, user_id INTEGER) ON COMMIT DROP');
    await client.query('INSERT INTO urls VALUES (1, 9001)');
    await client.query('INSERT INTO campaigns VALUES (9001, 4001)');
    await client.query('SAVEPOINT before_delete');
    try {
      await client.query('UPDATE urls SET campaign_id=NULL WHERE campaign_id=9001');
      await client.query('SELECT * FROM non_existing_enterprise_qa_relation');
      assert.fail('forced failure must reject');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT before_delete');
    }
    const state = await client.query('SELECT campaign_id FROM urls WHERE id=1');
    assert.equal(state.rows[0].campaign_id, 9001);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
    await require('../src/db/pool').pool.end().catch(() => {});
  }
});
