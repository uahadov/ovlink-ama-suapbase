#!/usr/bin/env node

const { Pool } = require('pg');
const bcrypt = require('bcrypt');

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

  await pool.query(
    'INSERT INTO admin_users (email, password_hash, role, created_at) VALUES ($1, $2, $3, $4)',
    [email, hash, role, createdAt]
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
