'use strict';
/**
 * P07 additive, opt-in organization schema. Never migrates billing provider data.
 * Feature is deliberately off by default until P05/P06 gates and release review.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pool } = require('./pool');

function organizationFeatureEnabled(env = process.env) {
  return String(env.ENABLE_ORGANIZATION_MODEL || '').trim() === '1';
}

/**
 * PostgreSQL multi-statement schema is a single BEGIN/COMMIT unit.
 * Advisory lock prevents two app instances from executing the DDL concurrently.
 * pg.Client keeps the lock held until commit (transaction-scoped).
 */
async function migrateOrganizationModel({ clientPool = pool } = {}) {
  const sql = fs.readFileSync(path.join(__dirname, 'organization-schema.sql'), 'utf8');
  const client = await clientPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [2026, 7007]);
    // SQL contains its own BEGIN/COMMIT. We remove these wrappers so
    // advisory lock and DDL share exactly the same transaction.
    const body = sql.replace(/^\s*BEGIN;\s*/i, '').replace(/\s*COMMIT;\s*$/i, '');
    await client.query(body);
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * P08 five-role upgrade requires TWO explicit opt-ins and a completed P07
 * additive migration. Defaults OFF, including when P07 alone is enabled.
 * This worktree is experimental; production release requires separate gates.
 */
function organizationRbacV2Enabled(env = process.env) {
  return organizationFeatureEnabled(env) && String(env.ENABLE_ORGANIZATION_RBAC_V2 || '').trim() === '1';
}

async function migrateOrganizationRoles({ clientPool = pool, env = process.env } = {}) {
  if (!organizationRbacV2Enabled(env)) throw new Error('P08 role migration requires both organization feature opt-in flags');
  const sql = fs.readFileSync(path.join(__dirname,'organization-roles-p08.sql'),'utf8');
  const client = await clientPool.connect();
  try {
    await client.query('BEGIN');
    // Lock order agrees with P07 migration to prevent concurrent instances
    // racing the P07 replay/backfill and P08 role DDL.
    await client.query('SELECT pg_advisory_xact_lock($1,$2)',[2026,7007]);
    const body=sql.replace(/^\s*BEGIN;\s*/i,'').replace(/\s*COMMIT;\s*$/i,'');
    await client.query(body);
    await client.query('COMMIT');
    return {ok:true};
  } catch(err) {
    await client.query('ROLLBACK').catch(()=>{});
    throw err;
  } finally { client.release(); }
}

/**
 * Link a newly created legacy workspace in the SAME transaction as its
 * workspace/member rows. This avoids waiting until the next server restart.
 * Only runs with opt-in feature enabled; no existing access/plan changes.
 */
async function linkLegacyWorkspace(tx, workspaceId) {
  const workspace = await tx.get('SELECT id,name,owner_user_id FROM workspaces WHERE id=?', [workspaceId]);
  if (!workspace) throw new Error('Legacy workspace missing in transaction');
  const row = await tx.get(
    `INSERT INTO organizations(display_name,owner_user_id,legacy_workspace_id)
       VALUES(?,?,?)
       ON CONFLICT (legacy_workspace_id)
       DO UPDATE SET display_name=EXCLUDED.display_name
       RETURNING id`,
    [workspace.name,workspace.owner_user_id,workspace.id]
  );
  await tx.run(
    'INSERT INTO organization_workspaces(organization_id,workspace_id) VALUES(?,?) ON CONFLICT(workspace_id) DO NOTHING',
    [row.id,workspace.id]
  );
  await tx.run(
    "INSERT INTO organization_members(organization_id,user_id,role) VALUES(?,?,'owner') ON CONFLICT(organization_id,user_id) DO NOTHING",
    [row.id,workspace.owner_user_id]
  );
  await tx.run('INSERT INTO organization_settings(organization_id) VALUES(?) ON CONFLICT(organization_id) DO NOTHING',[row.id]);
  await tx.run(
    'INSERT INTO organization_billing(organization_id,billing_owner_user_id) VALUES(?,?) ON CONFLICT(organization_id) DO NOTHING',
    [row.id,workspace.owner_user_id]
  );
  await tx.run(
    "INSERT INTO organization_audit_log(organization_id,event_key,actor_user_id,metadata_json) VALUES(?,'p07_legacy_backfill_v1',?,'{}'::jsonb) ON CONFLICT(organization_id,event_key) DO NOTHING",
    [row.id,workspace.owner_user_id]
  );
  return row.id;
}

module.exports = { migrateOrganizationModel, migrateOrganizationRoles, organizationFeatureEnabled, organizationRbacV2Enabled, linkLegacyWorkspace };
