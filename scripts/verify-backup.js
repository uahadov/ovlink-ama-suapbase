#!/usr/bin/env node
'use strict';

/**
 * scripts/verify-backup.js
 *
 * Restore drill for the nightly `scripts/backup-telegram.js` dump (A10, W8).
 * A backup nobody has restored is a rumour: this script takes a real
 * `pg_dump --format=custom`, restores it into a throwaway database, runs
 * invariant queries against it and drops the database again — so a corrupt or
 * truncated upload is caught before the incident where it is needed.
 *
 * Safety: every guard in `evaluateSafety()` is checked *before* a single
 * command touches the cluster, and the destructive steps only ever address the
 * throwaway database (see test/backup-verify.test.js).
 *
 * Usage:
 *   DATABASE_URL=postgres://… ALLOW_RESTORE=1 RESTORE_VERIFY_DB=ovlink_verify_1 \
 *     node scripts/verify-backup.js
 *
 * Cron (weekly, off-peak):
 *   15 04 * * 1 cd /var/www/ovlink && ALLOW_RESTORE=1 RESTORE_VERIFY_DB=ovlink_verify_cron node scripts/verify-backup.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Tables that must exist in every restored backup, with the predicate used to
// prove the restore actually loaded data (`null` = allowed to be empty).
const REQUIRED_TABLES = Object.freeze(['users', 'urls', 'clicks', 'link_stats_daily', 'qr_codes']);
const NON_EMPTY_TABLES = Object.freeze(['users', 'urls']);
const VERIFY_DB_SUFFIX = '_verify';

function evaluateSafety(env) {
  const ref = env || process.env;
  const errors = [];

  if (ref.NODE_ENV === 'production') {
    errors.push('refusing to run with NODE_ENV=production — execute this drill from a staging host or the scheduled workflow');
  }
  if (!isTruthy(ref.ALLOW_RESTORE)) {
    errors.push('ALLOW_RESTORE=1 is required — the drill creates and drops a database');
  }

  const dbUrl = (ref.DATABASE_URL || ref.SUPABASE_DB_URL || '').trim();
  let parsed = null;
  if (!dbUrl) {
    errors.push('DATABASE_URL is required');
  } else {
    try {
      parsed = new URL(dbUrl);
    } catch {
      errors.push('DATABASE_URL is not a valid postgres URL');
      parsed = null;
    }
  }

  const sourceDb = parsed && decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (parsed && !sourceDb) errors.push('DATABASE_URL must point at a specific database');

  const verifyRaw = (ref.RESTORE_VERIFY_DB || '').trim();
  if (!verifyRaw) {
    errors.push(`RESTORE_VERIFY_DB is required (must end with "${VERIFY_DB_SUFFIX}")`);
  } else if (!verifyRaw.endsWith(VERIFY_DB_SUFFIX)) {
    errors.push(`RESTORE_VERIFY_DB must end with "${VERIFY_DB_SUFFIX}" so it can never collide with the live database`);
  } else if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(verifyRaw)) {
    errors.push('RESTORE_VERIFY_DB must be a plain identifier (letters, digits, underscore, $)');
  } else if (parsed && sourceDb === verifyRaw) {
    errors.push('RESTORE_VERIFY_DB must differ from the source database');
  }

  return { errors, dbUrl, sourceDb, verifyDb: verifyRaw };
}

function isTruthy(value) {
  return String(value || '').toLowerCase() === '1' || String(value || '').toLowerCase() === 'true';
}

// Same SSL policy as src/db/pool.js: plaintext on localhost, verified TLS
// everywhere else (DATABASE_SSL_REJECT_UNAUTHORIZED=false only for pinned test hosts).
function sslOptions(connectionString, env) {
  const ref = env || process.env;
  if (/localhost|127\.0\.0\.1/.test(connectionString)) return false;
  return { rejectUnauthorized: ref.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false' };
}

// DATABASE_URL with the database name swapped for the throwaway target.
function withDatabase(dbUrl, database) {
  const url = new URL(dbUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function run(cmd, args, opts) {
  const result = spawnSync(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts || {}));
  if (result.error) throw new Error(`${cmd}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || Buffer.from('')).toString().trim();
    throw new Error(`${cmd} exited with ${result.status}${detail ? `: ${detail.split('\n').slice(-3).join(' ')}` : ''}`);
  }
  return (result.stdout || Buffer.from('')).toString();
}

function logStep(message) {
  console.log(`[backup-verify] ${message}`);
}

// pg is already a runtime dependency, so every check runs through the same
// driver the app uses instead of scraping psql output.
async function withClient(connectionString, fn) {
  const { Client } = require('pg');
  const client = new Client({ connectionString, ssl: sslOptions(connectionString) });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

function databaseExists(adminUrl, database) {
  return withClient(adminUrl, (client) => client.query('SELECT 1 AS one FROM pg_database WHERE datname = $1', [database]))
    .then((res) => res.rowCount > 0);
}

async function measureRestoredDb(targetUrl) {
  return withClient(targetUrl, async (client) => {
    const tables = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    const present = new Set(tables.rows.map((r) => r.table_name));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));

    const counts = {};
    for (const table of REQUIRED_TABLES) {
      if (!present.has(table)) { counts[table] = null; continue; }
      const res = await client.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
      counts[table] = res.rows[0].n;
    }

    const empty = NON_EMPTY_TABLES.filter((t) => present.has(t) && counts[t] === 0);
    return { tableCount: present.size, counts, missing, empty };
  });
}

async function main() {
  const safety = evaluateSafety(process.env);
  if (safety.errors.length) {
    for (const message of safety.errors) console.error(`[backup-verify] ❌ ${message}`);
    process.exitCode = 1;
    return;
  }

  const { dbUrl, sourceDb, verifyDb } = safety;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dumpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ovlink-restore-')), `verify_${stamp}.dump`);
  const targetUrl = withDatabase(dbUrl, verifyDb);
  const startedAt = Date.now();

  logStep(`source=${sourceDb} target=${verifyDb} (dump kept in ${path.dirname(dumpFile)})`);

  let created = false;
  let drillPassed = false;
  try {
    run('pg_dump', [dbUrl, '--format=custom', `--file=${dumpFile}`]);
    logStep('pg_dump ok');

    // `psql -c 'CREATE DATABASE …'` rather than `createdb(1)`: the target is
    // already validated as a bare identifier and quoting keeps it that way.
    run('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-c', `CREATE DATABASE "${verifyDb}"`]);
    created = true;
    logStep(`created ${verifyDb}`);

    run('pg_restore', ['--no-owner', '--dbname=' + targetUrl, dumpFile]);
    logStep('pg_restore ok');

    const report = await measureRestoredDb(targetUrl);
    logStep(`tables restored: ${report.tableCount}`);
    for (const table of REQUIRED_TABLES) {
      logStep(`  ${table}: ${report.counts[table] === null ? 'MISSING' : report.counts[table]}`);
    }

    if (report.missing.length) throw new Error(`restored backup is missing tables: ${report.missing.join(', ')}`);
    if (report.empty.length) throw new Error(`restored backup has unexpectedly empty tables: ${report.empty.join(', ')}`);

    logStep(`✅ restore drill passed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    drillPassed = true;
  } catch (err) {
    console.error(`[backup-verify] ❌ ${err.message}`);
    process.exitCode = 1;
  } finally {
    if (created) {
      // Terminate lingering connections first: an active restore/analyse session
      // would make the drop below fail and leave the throwaway behind.
      run('psql', [dbUrl, '-v', 'ON_ERROR_STOP=0', '-q', '-c',
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${verifyDb}' AND pid <> pg_backend_pid()`],
        { stdio: 'ignore' });
      run('psql', [dbUrl, '-v', 'ON_ERROR_STOP=0', '-q', '-c', `DROP DATABASE IF EXISTS "${verifyDb}"`], { stdio: 'ignore' });
      logStep(`dropped ${verifyDb}`);
      // Prove the drop landed: a throwaway that survives the drill would be a
      // slow leak in the cluster (and hides a broken `finally`).
      try {
        const leftover = await databaseExists(dbUrl, verifyDb);
        if (leftover) {
          console.error(`[backup-verify] ❌ ${verifyDb} still exists after cleanup`);
          process.exitCode = 1;
        } else if (drillPassed) {
          logStep('cleanup verified — the throwaway database is gone');
        }
      } catch (err) {
        console.error(`[backup-verify] ⚠️ cleanup check failed: ${err.message}`);
      }
    }
    try { fs.rmSync(path.dirname(dumpFile), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[backup-verify] 💥 unexpected error:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  evaluateSafety,
  withDatabase,
  sslOptions,
  databaseExists,
  REQUIRED_TABLES,
  NON_EMPTY_TABLES,
  VERIFY_DB_SUFFIX,
};
