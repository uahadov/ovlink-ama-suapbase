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

module.exports = { migrateOrganizationModel, organizationFeatureEnabled };
