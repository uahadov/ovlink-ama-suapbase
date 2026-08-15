#!/usr/bin/env node

require('dotenv').config();

const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const { encryptAES256GCM, blindIndex } = require('../utils/crypto');

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return null;
}

const email = (arg('--email') || '').trim().toLowerCase();
const password = (arg('--password') || '');
const role = ((arg('--role') || 'admin').trim() === 'moderator') ? 'moderator' : 'admin';
const dbUrl = arg('--url') || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

if (!email || !password || !dbUrl) {
  console.error('Usage: node scripts/create-admin.js --email you@example.com --password "a-strong-password" [--role admin|moderator] [--url postgres://...]');
  process.exit(1);
}

if (password.length < 10) {
  console.error('Password must be at least 10 characters.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function main() {
  const hash = await bcrypt.hash(password, 12);
  const createdAt = new Date().toISOString();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      failed_login_count INTEGER DEFAULT 0,
      lock_until TEXT,
      last_failed_at TEXT,
      last_login_at TEXT,
      created_at TEXT
    )
  `);
  // Columns the runtime migration also adds; kept here so the script works
  // against a database that has never booted the app.
  await pool.query('ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS email_hash TEXT');
  await pool.query('ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS totp_enabled INTEGER NOT NULL DEFAULT 0');
  await pool.query('ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS totp_secret TEXT');

  // The login route looks admins up by blindIndex(email) and expects the
  // email to be encrypted the same way /admin registration stores it.
  const existing = await pool.query('SELECT id FROM admin_users WHERE email_hash = $1', [blindIndex(email)]);
  if (existing.rowCount > 0) {
    console.error('An admin with this email already exists (id:', existing.rows[0].id + ').');
    process.exitCode = 1;
    return;
  }

  await pool.query(
    'INSERT INTO admin_users (email, email_hash, password_hash, role, totp_enabled, created_at) VALUES ($1, $2, $3, $4, 0, $5)',
    [encryptAES256GCM(email), blindIndex(email), hash, role, createdAt]
  );

  console.log('Created admin user:', email, 'role:', role);
}

main()
  .catch((e) => {
    console.error('Failed:', e && e.message ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => {
    pool.end();
  });
