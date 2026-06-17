#!/usr/bin/env node
/**
 * Ovlink Pre-Startup Health Check
 * Runs before server startup to validate configuration
 */

require('dotenv').config();

console.log('🚀 Ovlink Pre-Startup Health Check\n');
console.log('=' .repeat(70));

let errorCount = 0;
let warningCount = 0;

function checkRequired(name, value, description) {
  if (!value || value.toString().trim() === '') {
    console.error(`❌ ${name} - EKSİK! (${description})`);
    errorCount++;
    return false;
  } else {
    console.log(`✅ ${name} - Tanımlı`);
    return true;
  }
}

function checkOptional(name, value, description, recommendation) {
  if (!value || value.toString().trim() === '') {
    console.warn(`⚠️  ${name} - Tanımsız (${description})`);
    if (recommendation) {
      console.warn(`   💡 ${recommendation}`);
    }
    warningCount++;
    return false;
  } else {
    console.log(`✅ ${name} - Tanımlı`);
    return true;
  }
}

function validateLength(name, value, minLength, description) {
  const len = value ? value.toString().length : 0;
  if (len < minLength) {
    console.error(`❌ ${name} - Çok kısa! (${len} karakter, en az ${minLength} gerekli)`);
    console.error(`   ${description}`);
    errorCount++;
    return false;
  }
  return true;
}

console.log('\n📧 EMAIL YAPISI:');
console.log('-'.repeat(70));
checkRequired('RESEND_API_KEY', process.env.RESEND_API_KEY, 'Email göndermek için gerekli');
checkRequired('FROM_EMAIL', process.env.FROM_EMAIL, 'Gönderen email adresi');

if (process.env.FROM_EMAIL) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const fromEmailRaw = process.env.FROM_EMAIL;
  
  // Extract email from "Name <email@domain.com>" format
  let email = fromEmailRaw;
  const match = fromEmailRaw.match(/<([^>]+)>/);
  if (match) {
    email = match[1];
  } else {
    email = fromEmailRaw.trim();
  }
  
  if (!emailRegex.test(email)) {
    console.error(`❌ FROM_EMAIL - Geçersiz email format! (${email})`);
    errorCount++;
  } else {
    console.log(`   📧 Email: ${email}`);
    
    // Check if domain is likely verified
    const domain = email.split('@')[1];
    if (domain === 'resend.dev') {
      console.warn(`⚠️  ${domain} test domain'i kullanılıyor. Production için kendi domain'inizi doğrulayın.`);
      warningCount++;
    } else {
      console.log(`   🌐 Domain: ${domain}`);
      console.warn(`   ⚠️  Bu domain'in Resend'de doğrulandığından emin olun!`);
      console.warn(`   🔗 https://resend.com/domains`);
      warningCount++;
    }
  }
}

console.log('\n🔐 GOOGLE OAUTH:');
console.log('-'.repeat(70));
const hasGoogleId = checkOptional('GOOGLE_CLIENT_ID', process.env.GOOGLE_CLIENT_ID, 
  'Google giriş için gerekli', 'Google OAuth kullanmıyorsanız göz ardı edin');
const hasGoogleSecret = checkOptional('GOOGLE_CLIENT_SECRET', process.env.GOOGLE_CLIENT_SECRET, 
  'Google giriş için gerekli', 'Google OAuth kullanmıyorsanız göz ardı edin');

if (hasGoogleId || hasGoogleSecret) {
  if (hasGoogleId && !hasGoogleSecret) {
    console.error('❌ GOOGLE_CLIENT_ID var ama GOOGLE_CLIENT_SECRET yok!');
    errorCount++;
  } else if (!hasGoogleId && hasGoogleSecret) {
    console.error('❌ GOOGLE_CLIENT_SECRET var ama GOOGLE_CLIENT_ID yok!');
    errorCount++;
  }
}

console.log('\n🌐 SITE YAPILANDIRMASI:');
console.log('-'.repeat(70));
const baseUrl = checkRequired('BASE_URL', process.env.BASE_URL, 'Site URL\'i (https://ovlink.sbs)');
checkOptional('PUBLIC_BASE_URL', process.env.PUBLIC_BASE_URL, 'Public URL (genelde BASE_URL ile aynı)');

if (baseUrl && process.env.BASE_URL) {
  if (!process.env.BASE_URL.startsWith('http://') && !process.env.BASE_URL.startsWith('https://')) {
    console.error('❌ BASE_URL - http:// veya https:// ile başlamalı!');
    errorCount++;
  } else if (process.env.NODE_ENV === 'production' && process.env.BASE_URL.startsWith('http://')) {
    console.error('❌ BASE_URL - Production\'da https:// kullanılmalı!');
    errorCount++;
  } else {
    console.log(`   🔗 URL: ${process.env.BASE_URL}`);
  }
}

console.log('\n🔒 GÜVENLİK:');
console.log('-'.repeat(70));
const sessionSecret = checkRequired('SESSION_SECRET', process.env.SESSION_SECRET, 'Session şifreleme için gerekli');
if (sessionSecret) {
  validateLength('SESSION_SECRET', process.env.SESSION_SECRET, 64, 'En az 64 karakter olmalı');
}

const encryptionKey = checkRequired('ENCRYPTION_KEY', process.env.ENCRYPTION_KEY, 'Veri şifreleme için gerekli');
if (encryptionKey) {
  const keyLen = process.env.ENCRYPTION_KEY ? process.env.ENCRYPTION_KEY.length : 0;
  if (keyLen !== 64) {
    console.error(`❌ ENCRYPTION_KEY - 64 hex karakter (32 byte) olmalı! (Şu an: ${keyLen})`);
    errorCount++;
  } else {
    console.log('   🔑 32 byte (64 hex) ✓');
  }
}

checkOptional('API_KEY_HASH_SECRET', process.env.API_KEY_HASH_SECRET, 
  'API key hashing için', 'Otomatik fallback var ama production\'da tanımlı olmalı');
checkOptional('WEBHOOK_HASH_SECRET', process.env.WEBHOOK_HASH_SECRET, 
  'Webhook güvenliği için', 'Otomatik fallback var ama production\'da tanımlı olmalı');

console.log('\n💾 VERİTABANI:');
console.log('-'.repeat(70));
const dbUrl = checkRequired('DATABASE_URL', process.env.DATABASE_URL, 'PostgreSQL bağlantısı için gerekli');

if (dbUrl && process.env.DATABASE_URL) {
  if (process.env.DATABASE_URL.includes('postgresql://') || process.env.DATABASE_URL.includes('postgres://')) {
    console.log('   🐘 PostgreSQL bağlantısı');
    
    // Parse connection string safely
    try {
      const url = new URL(process.env.DATABASE_URL);
      console.log(`   🌐 Host: ${url.hostname}`);
      console.log(`   📡 Port: ${url.port || '5432'}`);
      console.log(`   📁 Database: ${url.pathname.substring(1)}`);
    } catch (e) {
      console.error('❌ DATABASE_URL format hatası!');
      errorCount++;
    }
  } else {
    console.warn('⚠️  SQLite kullanılıyor. Production için PostgreSQL önerilir.');
    warningCount++;
  }
}

console.log('\n📊 SESSION & CACHE:');
console.log('-'.repeat(70));
checkOptional('REDIS_URL', process.env.REDIS_URL, 
  'Session store için Redis', 'Yok ise PostgreSQL session store kullanılır');

const requireRedis = process.env.REQUIRE_REDIS_IN_PROD;
if (process.env.NODE_ENV === 'production' && requireRedis === '1' && !process.env.REDIS_URL) {
  console.error('❌ Production\'da REQUIRE_REDIS_IN_PROD=1 ama REDIS_URL yok!');
  errorCount++;
}

console.log('\n⚙️  RUNTIME AYARLARI:');
console.log('-'.repeat(70));
const nodeEnv = process.env.NODE_ENV || 'development';
console.log(`📌 NODE_ENV: ${nodeEnv}`);

if (nodeEnv === 'production') {
  console.log('🏭 Production modunda çalışıyor');
  
  checkRequired('TRUST_PROXY_HOPS', process.env.TRUST_PROXY_HOPS, 
    'Reverse proxy sayısı (Nginx/Cloudflare için)');
  
  if (process.env.TRUST_PROXY_HOPS) {
    const hops = parseInt(process.env.TRUST_PROXY_HOPS);
    if (isNaN(hops) || hops <= 0) {
      console.error('❌ TRUST_PROXY_HOPS - Pozitif sayı olmalı!');
      errorCount++;
    } else {
      console.log(`   🔀 Proxy hops: ${hops}`);
    }
  }
} else {
  console.log('🛠️  Development modunda çalışıyor');
}

console.log('\n' + '='.repeat(70));
console.log('\n📊 SONUÇ:');

if (errorCount > 0) {
  console.error(`\n❌ ${errorCount} KRİTİK HATA bulundu!`);
  console.error('Bu hatalar düzeltilmeden sunucu düzgün çalışmayacak.\n');
}

if (warningCount > 0) {
  console.warn(`\n⚠️  ${warningCount} UYARI bulundu.`);
  console.warn('Bu uyarılar sunucunun çalışmasını engellemez ama dikkat edilmeli.\n');
}

if (errorCount === 0 && warningCount === 0) {
  console.log('\n✅ Tüm kontroller başarılı!');
  console.log('🚀 Sunucu başlatılabilir: node server.js\n');
  process.exit(0);
} else if (errorCount === 0) {
  console.log('\n✅ Kritik hata yok. Sunucu başlatılabilir.');
  console.log('⚠️  Uyarıları gözden geçirin.\n');
  process.exit(0);
} else {
  console.error('\n💡 ÇÖZÜM ÖNERİLERİ:');
  console.error('1. .env dosyasını kontrol edin');
  console.error('2. Eksik değişkenleri ekleyin');
  console.error('3. Bu scripti tekrar çalıştırın: npm run check:env');
  console.error('4. Yardım için: BUG_FIXES_SUMMARY.md dosyasına bakın\n');
  process.exit(1);
}
