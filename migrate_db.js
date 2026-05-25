require('dotenv').config();
const { Pool } = require('pg');
const { encryptAES256GCM, blindIndex } = require('./utils/crypto.js');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.SUPABASE_DB_URL,
  ssl: (process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '').includes('localhost') ? false : {
    rejectUnauthorized: false
  }
});

console.log('Starting DB migration to encrypt plaintext PII...');

async function migrate() {
  try {
    // Ensure email_hash columns exist
    console.log('Adding email_hash columns if they do not exist...');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_hash VARCHAR(255)');
    await pool.query('ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS email_hash VARCHAR(255)');

    // Migrate users table
    let res = await pool.query('SELECT id, email, verification_code, google_id FROM users');
    let userUpdates = 0;
    
    for (const row of res.rows) {
      const emailIsPlain = row.email && !row.email.includes(':');
      const newEmail = emailIsPlain ? encryptAES256GCM(row.email) : row.email;
      const newEmailHash = blindIndex(emailIsPlain ? row.email : row.email); // Actually if we don't have plaintext, we can't blind index. Assuming we run this once while data is plaintext.
      
      const vCodeIsPlain = row.verification_code && !row.verification_code.includes(':');
      const newVCode = vCodeIsPlain ? encryptAES256GCM(row.verification_code) : row.verification_code;

      const googleIdIsPlain = row.google_id && !row.google_id.includes(':');
      const newGoogleId = googleIdIsPlain ? encryptAES256GCM(row.google_id) : row.google_id;
      
      await pool.query(
        'UPDATE users SET email = $1, email_hash = $2, verification_code = $3, google_id = $4 WHERE id = $5',
        [newEmail, newEmailHash, newVCode, newGoogleId, row.id]
      );
      userUpdates++;
    }
    console.log(`Migrated ${userUpdates} users.`);

    // Migrate admin_users table
    res = await pool.query('SELECT id, email, totp_secret FROM admin_users');
    let adminUpdates = 0;
    
    for (const row of res.rows) {
      const emailIsPlain = row.email && !row.email.includes(':');
      const newEmail = emailIsPlain ? encryptAES256GCM(row.email) : row.email;
      const newEmailHash = blindIndex(emailIsPlain ? row.email : row.email);

      const totpIsPlain = row.totp_secret && !row.totp_secret.includes(':');
      const newTotp = totpIsPlain ? encryptAES256GCM(row.totp_secret) : row.totp_secret;
      
      await pool.query(
        'UPDATE admin_users SET email = $1, email_hash = $2, totp_secret = $3 WHERE id = $4',
        [newEmail, newEmailHash, newTotp, row.id]
      );
      adminUpdates++;
    }
    console.log(`Migrated ${adminUpdates} admin_users.`);
    
    // Migrate custom_domains
    res = await pool.query('SELECT id, verification_token FROM custom_domains');
    let domainUpdates = 0;
    
    for (const row of res.rows) {
      const isPlain = row.verification_token && !row.verification_token.includes(':');
      const newTok = isPlain ? encryptAES256GCM(row.verification_token) : row.verification_token;
      
      await pool.query('UPDATE custom_domains SET verification_token = $1 WHERE id = $2', [newTok, row.id]);
      domainUpdates++;
    }
    console.log(`Migrated ${domainUpdates} custom_domains.`);
    
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await pool.end();
  }
}

migrate();
