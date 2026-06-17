# 🚀 Ovlink Kurulum ve Test Rehberi

## 📋 İçindekiler
1. [Hızlı Başlangıç](#hızlı-başlangıç)
2. [Detaylı Kurulum](#detaylı-kurulum)
3. [Email Sistemi Kurulumu](#email-sistemi-kurulumu)
4. [Google OAuth Kurulumu](#google-oauth-kurulumu)
5. [Test Komutları](#test-komutları)
6. [Sorun Giderme](#sorun-giderme)

---

## 🎯 Hızlı Başlangıç

### 1. Bağımlılıkları Yükle
```bash
npm install
```

### 2. Environment Kontrolü
```bash
npm run check:env
```

### 3. Database Kontrolü
```bash
npm run check:database
```

### 4. Email Sistemi Testi
```bash
npm run test:email
```

### 5. Sunucuyu Başlat
```bash
npm start
```

---

## 📦 Detaylı Kurulum

### Gereksinimler
- Node.js 18+ 
- PostgreSQL 14+
- Resend Account (Email için)
- Google Cloud Account (OAuth için - opsiyonel)

### Environment Variables (.env)

#### 🔴 Zorunlu Değişkenler

```env
# Email (Resend)
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxx
FROM_EMAIL=Ovlink <verify@ovlink.sbs>

# Site URL
BASE_URL=https://ovlink.sbs
PUBLIC_BASE_URL=https://ovlink.sbs

# Güvenlik
SESSION_SECRET=<64+ karakter random string>
ENCRYPTION_KEY=<32 byte hex (64 karakter)>

# Database
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# Production Settings
NODE_ENV=production
TRUST_PROXY_HOPS=1
FORCE_SECURE_COOKIE=1
```

#### 🟡 Google OAuth (Opsiyonel)

```env
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxx
```

#### 🟢 Opsiyonel Değişkenler

```env
# Redis (Session store için)
REDIS_URL=redis://localhost:6379
REQUIRE_REDIS_IN_PROD=0

# API & Webhook Security
API_KEY_HASH_SECRET=<64+ karakter>
WEBHOOK_HASH_SECRET=<64+ karakter>

# Development
AD_SANDBOX_ALLOW_SAME_ORIGIN=1
```

### Güvenli Random String Oluşturma

#### SESSION_SECRET (64+ karakter)
```bash
# Linux/Mac
openssl rand -hex 64

# Node.js
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# PowerShell
[System.Convert]::ToBase64String((1..64 | ForEach-Object { Get-Random -Maximum 256 }))
```

#### ENCRYPTION_KEY (32 byte = 64 hex)
```bash
# Linux/Mac
openssl rand -hex 32

# Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# PowerShell
-join ((1..32 | ForEach-Object { '{0:X2}' -f (Get-Random -Maximum 256) }))
```

---

## 📧 Email Sistemi Kurulumu

### 1. Resend Hesabı Oluştur
1. [Resend.com](https://resend.com) 'a kaydol
2. API Key oluştur
3. `.env` dosyasına ekle

### 2. Domain Doğrulama (KRİTİK!)

#### Resend Dashboard
1. [Domains](https://resend.com/domains) sayfasına git
2. "Add Domain" butonuna tıkla
3. Domain'ini ekle (örn: `ovlink.sbs`)

#### DNS Kayıtları
Resend'in verdiği DNS kayıtlarını domain'ine ekle:

```dns
Type: TXT
Name: resend._domainkey.ovlink.sbs
Value: p=MIGfMA0GCSqGSIb3DQEBAQUAA4...

Type: TXT
Name: ovlink.sbs
Value: v=spf1 include:spf.resend.com ~all
```

#### Doğrulama
- DNS değişikliği 5-10 dakika sürebilir
- Resend dashboard'da "Verify" butonuna bas
- Status: ✅ Verified olmalı

### 3. Email Testi

```bash
npm run test:email
```

**Beklenen Çıktı:**
```
🔍 Email test başlatılıyor...
📧 FROM_EMAIL: Ovlink <verify@ovlink.sbs>
🔑 RESEND_API_KEY: ✅ Tanımlı (gizli)

📤 Email gönderiliyor...

✅ Email başarıyla gönderildi!

📊 Resend API Yanıtı:
{
  "id": "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794",
  "from": "verify@ovlink.sbs",
  "to": "qorxusuzqorxaq@gmail.com"
}

✨ Test başarılı! Email sistemi çalışıyor.
```

**Hata Alırsanız:**
- API key'i kontrol et
- Domain doğrulamasını kontrol et
- Spam klasörünü kontrol et
- Resend dashboard'daki email loglarına bak

---

## 🔐 Google OAuth Kurulumu

### 1. Google Cloud Console
1. [Google Cloud Console](https://console.cloud.google.com/) 'a git
2. Yeni proje oluştur veya mevcut projeyi seç

### 2. OAuth Consent Screen
1. "APIs & Services" > "OAuth consent screen"
2. External seç (test için)
3. Form doldur:
   - App name: `Ovlink`
   - User support email: `your@email.com`
   - Developer contact: `your@email.com`

### 3. Create Credentials
1. "APIs & Services" > "Credentials"
2. "Create Credentials" > "OAuth client ID"
3. Application type: **Web application**
4. Name: `Ovlink Web Client`

### 4. Authorized Redirect URIs
Şu URL'leri ekle:
```
https://ovlink.sbs/auth/google/callback
http://localhost:3000/auth/google/callback  (test için)
```

### 5. Credentials'ı Kopyala
- Client ID'yi kopyala → `.env` → `GOOGLE_CLIENT_ID`
- Client Secret'ı kopyala → `.env` → `GOOGLE_CLIENT_SECRET`

### 6. Test Et
1. Sunucuyu başlat: `npm start`
2. `/register` sayfasına git
3. "Google ile kayıt ol" butonuna tıkla
4. Google hesabı seç
5. Yönlendirmeyi kontrol et

---

## 🧪 Test Komutları

### Environment Kontrolü
```bash
npm run check:env
```
- Tüm environment variables'ları kontrol eder
- Kritik hataları gösterir
- Uyarıları listeler

### Database Kontrolü
```bash
npm run check:database
```
- PostgreSQL bağlantısını test eder
- Tablo şemasını kontrol eder
- Eksik kolonları gösterir
- Kullanıcı istatistiklerini gösterir

### Email Testi
```bash
npm run test:email
```
- RESEND_API_KEY'i kontrol eder
- Test email gönderir
- API yanıtını gösterir
- Hataları detaylı açıklar

### Tüm Kontroller
```bash
npm run check:all
```
- Environment + Database kontrolü
- Full health check

### Syntax Kontrolü
```bash
npm run check:syntax
```
- JavaScript syntax hatalarını kontrol eder
- Tüm backend dosyalarını tarar

### Security Audit
```bash
npm run check:security
```
- npm bağımlılıklarını tarar
- Güvenlik açıklarını listeler

---

## 🐛 Sorun Giderme

### Email Gelmiyor

#### 1. Environment Kontrolü
```bash
npm run check:env
```
Çıktıda `RESEND_API_KEY` ve `FROM_EMAIL` ✅ olmalı

#### 2. Email Testi
```bash
npm run test:email
```

**Olası Hatalar:**

**"Domain not verified"**
- Çözüm: Resend dashboard'da domain'i doğrula
- DNS kayıtlarının yayılmasını bekle (5-10 dakika)

**"API key invalid"**
- Çözüm: Resend'den yeni API key al
- `.env` dosyasına doğru kopyala
- Sunucuyu yeniden başlat

**"Rate limit exceeded"**
- Çözüm: Resend free tier limitini kontrol et
- Dashboard'da usage'ı kontrol et
- Biraz bekle ve tekrar dene

#### 3. Spam Kontrolü
- Inbox'ı kontrol et
- Spam/Junk klasörünü kontrol et
- Resend dashboard'daki email loglarına bak

#### 4. Server Logları
Sunucuyu başlat ve konsolu izle:
```bash
npm start
```

Kayıt ol ve konsoldaki logları kontrol et:
- `[startup] RESEND_API_KEY` mesajını ara
- Email gönderim hatalarını ara
- Detaylı error loglarını kontrol et

---

### Google OAuth Çalışmıyor

#### 1. Console Loglarını Kontrol Et
```bash
npm start
```

Aşağıdaki mesajı ara:
```
[google-auth] Status: READY
[google-auth] Redirect URI: https://ovlink.sbs/auth/google/callback
```

**Eğer "DISABLED" görüyorsan:**
```
[google-auth] Status: DISABLED
[google-auth] Error: missing_redirect_uri
```

#### 2. Environment Kontrolü
```bash
npm run check:env
```

Kontrol et:
- ✅ `GOOGLE_CLIENT_ID` tanımlı mı?
- ✅ `GOOGLE_CLIENT_SECRET` tanımlı mı?
- ✅ `BASE_URL` veya `PUBLIC_BASE_URL` tanımlı mı?

#### 3. Google Cloud Console Kontrolü

**Redirect URIs:**
- [Google Cloud Console](https://console.cloud.google.com/)
- Credentials sayfasına git
- OAuth 2.0 Client'ı aç
- Authorized redirect URIs'yi kontrol et

Olmalı:
```
https://ovlink.sbs/auth/google/callback
```

#### 4. Test URL'leri

**Development:**
```
http://localhost:3000/auth/google
```

**Production:**
```
https://ovlink.sbs/auth/google
```

**Hata mesajları:**
- `google_unavailable` → Environment eksik
- `google_failed` → OAuth flow başarısız
- `google_unverified` → Google email doğrulanmamış

---

### Database Hataları

#### 1. Bağlantı Hatası
```bash
npm run check:database
```

**"Could not connect"**
- PostgreSQL sunucusu çalışıyor mu?
- `DATABASE_URL` doğru mu?
- Firewall kuralları açık mı?

#### 2. Eksik Kolon
```
❌ verification_expires_at - EKSİK!
```

**Çözüm:**
```bash
# Sunucuyu başlat (ALTER TABLE otomatik çalışır)
npm start

# Database'i tekrar kontrol et
npm run check:database
```

#### 3. SSL Hatası
```
Error: self signed certificate
```

**Çözüm:** `.env` dosyasında:
```env
# Local development
DATABASE_URL=postgresql://localhost/ovlink

# Production (Supabase, etc.)
DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require
```

---

### Port Kullanımda

```
Error: listen EADDRINUSE :::3000
```

**Çözüm:**

**Windows:**
```powershell
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

**Linux/Mac:**
```bash
lsof -ti:3000 | xargs kill -9
```

Ya da farklı port kullan:
```env
PORT=3001
```

---

## 📚 Faydalı Komutlar

### Development
```bash
# Sunucuyu başlat
npm start

# Debug mode
npm run debug

# Tüm kontroller
npm run check:all
```

### Testing
```bash
# Email test
npm run test:email

# Environment check
npm run check:env

# Database check
npm run check:database

# Syntax check
npm run check:syntax
```

### Logs
```bash
# Real-time server logs
npm start

# Specific errors
npm start 2>&1 | grep -i error

# Email errors
npm start 2>&1 | grep -i "mail\|email\|resend"
```

---

## 🆘 Yardım

### Dokümantasyon
- `BUG_FIXES_SUMMARY.md` - Düzeltilen bug listesi
- `SETUP_GUIDE.md` - Bu dosya
- `AGENTS.md` - Proje dokumanları

### Loglar
Server başlatırken tüm logları dikkatle oku:
- ✅ Yeşil = Başarılı
- ⚠️  Sarı = Uyarı
- ❌ Kırmızı = Hata

### Debug
```bash
# Verbose logging
DEBUG=* npm start

# Node inspector
npm run debug
```

Tarayıcıda `chrome://inspect` aç

---

## ✅ Production Checklist

Canlıya almadan önce:

- [ ] `npm run check:env` → Tüm ✅
- [ ] `npm run check:database` → Tüm ✅
- [ ] `npm run test:email` → Email geldi
- [ ] Resend domain doğrulandı
- [ ] Google OAuth test edildi
- [ ] HTTPS aktif
- [ ] Environment variables production'da set
- [ ] Database backup alındı
- [ ] Rate limiting test edildi
- [ ] Error monitoring aktif

---

## 🎉 Başarı!

Tüm testler geçtiyse:
```bash
npm start
```

Ardından tarayıcıda:
```
https://ovlink.sbs
```

Kayıt ol ve test et! 🚀

---

**Developed with ❤️ by Ulvi Ahadov**
