require('dotenv').config();
const { Pool } = require('pg');
const { encryptAES256GCM, decryptAES256GCM, blindIndex } = require('./utils/crypto.js');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.SUPABASE_DB_URL,
  ssl: (process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '').includes('localhost') ? false : {
    rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false'
  }
});

function isEncrypted(value) {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 3 && parts[0].length === 24 && parts[1].length === 32;
}

function processEncryptedField(raw) {
  if (!raw) return { ciphertext: raw, plaintext: raw };
  if (isEncrypted(raw)) {
    const plain = decryptAES256GCM(raw);
    return { ciphertext: raw, plaintext: plain };
  }
  return { ciphertext: encryptAES256GCM(raw), plaintext: raw };
}

async function migrate() {
  const client = await pool.connect();
  console.log('Starting idempotent DB migration to encrypt plaintext PII...');

  try {
    await client.query('BEGIN');

    // 1. Ensure email_hash columns exist
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_hash VARCHAR(255)');
    await client.query('ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS email_hash VARCHAR(255)');

    // 2. Migrate users table
    const usersRes = await client.query('SELECT id, email, email_hash, verification_code, google_id FROM users');
    let userUpdates = 0;

    for (const row of usersRes.rows) {
      const emailInfo = processEncryptedField(row.email);
      const vCodeInfo = processEncryptedField(row.verification_code);
      const googleIdInfo = processEncryptedField(row.google_id);

      const targetHash = emailInfo.plaintext ? blindIndex(emailInfo.plaintext) : null;

      const needsUpdate =
        emailInfo.ciphertext !== row.email ||
        targetHash !== row.email_hash ||
        vCodeInfo.ciphertext !== row.verification_code ||
        googleIdInfo.ciphertext !== row.google_id;

      if (needsUpdate) {
        await client.query(
          'UPDATE users SET email = $1, email_hash = $2, verification_code = $3, google_id = $4 WHERE id = $5',
          [emailInfo.ciphertext, targetHash, vCodeInfo.ciphertext, googleIdInfo.ciphertext, row.id]
        );
        userUpdates++;
      }
    }
    console.log(`Migrated ${userUpdates}/${usersRes.rowCount} users.`);

    // 3. Migrate admin_users table
    const adminRes = await client.query('SELECT id, email, email_hash, totp_secret FROM admin_users');
    let adminUpdates = 0;

    for (const row of adminRes.rows) {
      const emailInfo = processEncryptedField(row.email);
      const totpInfo = processEncryptedField(row.totp_secret);
      const targetHash = emailInfo.plaintext ? blindIndex(emailInfo.plaintext) : null;

      const needsUpdate =
        emailInfo.ciphertext !== row.email ||
        targetHash !== row.email_hash ||
        totpInfo.ciphertext !== row.totp_secret;

      if (needsUpdate) {
        await client.query(
          'UPDATE admin_users SET email = $1, email_hash = $2, totp_secret = $3 WHERE id = $4',
          [emailInfo.ciphertext, targetHash, totpInfo.ciphertext, row.id]
        );
        adminUpdates++;
      }
    }
    console.log(`Migrated ${adminUpdates}/${adminRes.rowCount} admin_users.`);

    // 4. Migrate custom_domains table
    const domainRes = await client.query('SELECT id, verification_token FROM custom_domains');
    let domainUpdates = 0;

    for (const row of domainRes.rows) {
      const tokenInfo = processEncryptedField(row.verification_token);
      if (tokenInfo.ciphertext !== row.verification_token) {
        await client.query('UPDATE custom_domains SET verification_token = $1 WHERE id = $2', [
          tokenInfo.ciphertext,
          row.id
        ]);
        domainUpdates++;
      }
    }
    console.log(`Migrated ${domainUpdates}/${domainRes.rowCount} custom_domains.`);

    await client.query('COMMIT');
    console.log('Migration completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Migration failed, rolled back:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
