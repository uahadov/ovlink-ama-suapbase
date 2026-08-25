const pg = require('pg');
const { sendOpsAlert } = require('../lib/alerts');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || process.env.SUPABASE_DB_URL,
  ssl: (process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '').includes('localhost') ? false : {
    rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'
  },
  max: 20,
  min: 3,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
  query_timeout: 10000
});

pool.on('error', (err, client) => {
  console.error('[db pool error]', err.message);
  sendOpsAlert('db_pool_error', 'Database pool error', err.message);
});
module.exports = { pool };
