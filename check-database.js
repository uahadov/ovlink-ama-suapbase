#!/usr/bin/env node
/**
 * Database Schema Checker
 * Checks if all required columns exist in the users table
 */

require('dotenv').config();
const pg = require('pg');

const requiredColumns = [
  'id',
  'email',
  'email_hash',
  'password',
  'email_verified',
  'verification_code',
  'verification_expires_at', // CRITICAL: This was missing!
  'auth_provider',
  'google_id',
  'created_at',
  'last_login_at',
  'banned',
  'ban_until',
  'ban_reason',
  'ui_lang',
  'ui_theme',
  'notify_report',
  'notify_limit',
  'notify_disabled',
  'plan_tier',
  'plan_status'
];

console.log('🔍 Ovlink Database Schema Checker\n');
console.log('=' .repeat(60));

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL bulunamadı!');
  console.error('Lütfen .env dosyasında DATABASE_URL tanımlı olduğundan emin olun.\n');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: true }
});

async function checkDatabase() {
  const client = await pool.connect();
  
  try {
    console.log('✅ PostgreSQL bağlantısı başarılı!\n');
    
    // Check if users table exists
    const tableCheckQuery = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'users'
      );
    `;
    
    const tableResult = await client.query(tableCheckQuery);
    const tableExists = tableResult.rows[0].exists;
    
    if (!tableExists) {
      console.error('❌ "users" tablosu bulunamadı!');
      console.error('Sunucuyu en az bir kez başlatın: node server.js\n');
      process.exit(1);
    }
    
    console.log('✅ "users" tablosu mevcut\n');
    
    // Get all columns in users table
    const columnsQuery = `
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
      AND table_name = 'users'
      ORDER BY ordinal_position;
    `;
    
    const columnsResult = await client.query(columnsQuery);
    const existingColumns = columnsResult.rows.map(row => row.column_name);
    
    console.log('📊 Mevcut Kolonlar (' + existingColumns.length + ' adet):\n');
    
    let missingColumns = [];
    let foundColumns = [];
    
    requiredColumns.forEach(col => {
      if (existingColumns.includes(col)) {
        console.log(`  ✅ ${col}`);
        foundColumns.push(col);
      } else {
        console.log(`  ❌ ${col} - EKSİK!`);
        missingColumns.push(col);
      }
    });
    
    console.log('\n' + '='.repeat(60));
    console.log(`\n📈 Durum: ${foundColumns.length}/${requiredColumns.length} kolon mevcut\n`);
    
    if (missingColumns.length > 0) {
      console.error('⚠️  EKSİK KOLONLAR BULUNDU!\n');
      console.error('Eksik kolonlar:');
      missingColumns.forEach(col => console.error(`  - ${col}`));
      console.error('\n💡 Çözüm: Sunucuyu yeniden başlatın. ALTER TABLE komutları otomatik çalışacak.');
      console.error('   Komut: node server.js\n');
      process.exit(1);
    } else {
      console.log('✅ Tüm gerekli kolonlar mevcut!');
      console.log('✅ Database şeması güncel!\n');
    }
    
    // Check for sample data
    const countQuery = 'SELECT COUNT(*) as count FROM users';
    const countResult = await client.query(countQuery);
    const userCount = parseInt(countResult.rows[0].count);
    
    console.log('👥 Toplam kullanıcı sayısı:', userCount);
    
    if (userCount > 0) {
      // Check email verification status
      const verifiedQuery = 'SELECT email_verified, COUNT(*) as count FROM users GROUP BY email_verified';
      const verifiedResult = await client.query(verifiedQuery);
      
      console.log('\n📧 Email Doğrulama Durumu:');
      verifiedResult.rows.forEach(row => {
        const status = row.email_verified === 1 ? '✅ Doğrulanmış' : '⏳ Bekliyor';
        console.log(`  ${status}: ${row.count} kullanıcı`);
      });
      
      // Check for expired verification codes
      const expiredQuery = `
        SELECT COUNT(*) as count 
        FROM users 
        WHERE email_verified = 0 
        AND verification_expires_at IS NOT NULL 
        AND verification_expires_at < NOW()
      `;
      const expiredResult = await client.query(expiredQuery);
      const expiredCount = parseInt(expiredResult.rows[0].count);
      
      if (expiredCount > 0) {
        console.log(`\n⚠️  ${expiredCount} kullanıcının doğrulama kodu süresi dolmuş`);
        console.log('   Bu kullanıcılar yeniden kayıt olmalı.');
      }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ Database kontrolü tamamlandı!\n');
    
  } catch (error) {
    console.error('\n❌ Database kontrolü sırasında hata oluştu:\n');
    console.error('Hata:', error.message);
    console.error('\n🔍 Olası Nedenler:');
    console.error('1. PostgreSQL sunucusu çalışmıyor');
    console.error('2. DATABASE_URL yanlış');
    console.error('3. Bağlantı izni yok');
    console.error('4. SSL sertifika problemi\n');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

checkDatabase().catch(err => {
  console.error('Beklenmeyen hata:', err);
  process.exit(1);
});
