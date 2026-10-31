#!/usr/bin/env node
'use strict';

/**
 * scripts/seed-schema.js
 *
 * Brings the database pointed at by DATABASE_URL up to the app's current schema
 * by running the very same startup migration flow `server.js` uses, then exits
 * once the queue has drained.
 *
 * It exists for the weekly restore drill (.github/workflows/backup-verify.yml):
 * a `pg_dump` of an empty cluster restores "successfully" and proves nothing, so
 * the source database must carry the real schema first.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

function assertSafeTarget(env) {
  if (env.NODE_ENV === 'production') {
    throw new Error('seed-schema refuses to run with NODE_ENV=production; migrations run via normal app startup');
  }
}

async function seed({ timeoutMs = 60000, expected = ['users', 'urls', 'clicks', 'link_stats_daily', 'qr_codes'] } = {}) {
  assertSafeTarget(process.env);
  const { helpers } = require('../server');

  const deadline = Date.now() + timeoutMs;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const rows = await helpers.dbAllAsync(
    `SELECT table_name FROM information_schema.tables WHERE table_name IN ('${expected.join("','")}')`
  );
  const present = new Set(rows.map((r) => r.table_name));
  const missing = expected.filter((t) => !present.has(t));
  if (missing.length) throw new Error(`schema seed incomplete, missing: ${missing.join(', ')}`);
  return present.size;
}

if (require.main === module) {
  seed().then((count) => {
    console.log(`[seed-schema] ok — ${count} core tables present`);
    process.exit(0);
  }).catch((err) => {
    console.error(`[seed-schema] ❌ ${err.message}`);
    process.exit(1);
  });
}

module.exports = { seed, assertSafeTarget };
