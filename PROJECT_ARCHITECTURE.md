# Ovlink - Sistem Mimarisi, Altyapı ve Güvenlik Dokümantasyonu
> **Tüm Yapay Zeka (AI) Asistanları ve Geliştiriciler İçin Master Referans Belgesi**

---

## 1. Sunucu ve Donanım Özellikleri (Infrastructure Specs)
- **İşletim Sistemi (OS):** Ubuntu 22.04 LTS (Linux x86_64)
- **Donanım Kaynakları:**
  - **RAM:** 2 GB Fiziksel RAM + 2 GB Swap Alanı (Toplam 4 GB sanal bellek)
  - **Çalışma Ortamı (Runtime):** Node.js 20 LTS
  - **Süreç Yöneticisi (Process Manager):** PM2 (Servis adı: `ovlink`, cluster/fork modu)
- **Web Sunucusu & Reverse Proxy:** Nginx (HTTP/2, Gzip/Brotli sıkıştırma, SSL sonlandırma)
- **SSL Sertifikası:** Let's Encrypt Otomatik Yenilemeli SSL (`ovlink.sbs` ve `www.ovlink.sbs`)
- **Veritabanı:** PostgreSQL (Yerel / Yönetilen küme, `pg` connection pool, SQL dönüştürme önbelleği)
- **Oturum & Önbellek (Session & Cache):** Redis (Birincil) / `connect-pg-simple` PostgreSQL (Yedek)
- **E-Posta Servisleri:** Resend API (Birincil) + Spaceship SMTP Nodemailer (İkincil / Fallback)
- **Canlı Domain:** `https://ovlink.sbs`

---

## 2. Güvenlik Mimarisi (Security Architecture)

### 2.1. Ağ ve Proxy Güvenliği
- **Trust Proxy Güvenliği:** `TRUST_PROXY_HOPS` ortam değişkeniyle açık sekme sayısı (hop count) belirlenir; körlemesine `trust proxy: true` kullanılmaz. Bu sayede `X-Forwarded-For` sahteciliği (IP spoofing) engellenir.
- **SSRF (Server-Side Request Forgery) Koruması:** Webhook ve dış API isteklerinde özel/dahili IP aralıkları (127.0.0.1, 10.0.0.0/8, 192.168.0.0/16, AWS metadata 169.254.169.254 vb.) katı şekilde engellenir.

### 2.2. Web & Uygulama Güvenliği
- **Helmet & Katı CSP (Content Security Policy):**
  - Tüm script ve stiller için kriptografik `nonce` doğrulaması.
  - `frame-ancestors: 'none'` ile Clickjacking koruması.
  - Sıkı `form-action` ve `base-uri` direktifleri.
- **CSRF (Cross-Site Request Forgery) Koruması:** Tüm POST/PUT/DELETE rotaları için oturum tabanlı CSRF token kontrolü (`_csrf`).
- **Zararlı Yazılım & Phishing Filtresi:**
  - `isSuspiciousOrPhishingUrl` fonksiyonu ile çıplak IP adresleri, tehlikeli uzantılar (`.exe`, `.scr`, `.bat`, `.apk`, `.vbs`), şüpheli TLD'ler ve bilinen oltalama anahtar kelimeleri kısaltma aşamasında otomatik engellenir.
- **Brute-Force & Hız Sınırlama (Rate Limiting):**
  - Giriş/Kayıt denemeleri için IP ve e-posta bazlı katı limitler.
  - API istekleri için plan bazlı saatlik/günlük hız sınırları (`express-rate-limit` + Redis).
- **Parola & Kriptografi:**
  - Parolalar `bcrypt` (12 tuzlama turu) ile hashlenir.
  - `SESSION_SECRET`, en az 64 baytlık yüksek entropili rastgele anahtar kullanır.
  - API anahtarları veritabanında SHA-256 ile hashlenerek saklanır; düz metin asla tutulmaz.
  - Webhook imzaları HMAC-SHA256 deterministik türetilmiş anahtarla imzalanır.

---

## 3. Bot Entegrasyonları (Telegram & Discord)

### 3.1. Telegram Botu (`@OvlinkBOT` - ID: 8694078871)
- **Çalışma Modu:** Kesintisiz Long Polling (`getUpdates`) mekanizması.
- **Kota & Limit Sistemi:**
  - **Misafir Kullanıcı (Guest):** Günlük 5 link kısaltma (Bellek içi `chatId:YYYY-MM-DD` takibi). Hesap bağlama daveti sunulur.
  - **Bağlı Ücretsiz Hesap (Free):** Günlük 50 link, toplam 1.000 link, tek seferde 5 toplu link kısaltma.
  - **Pro Hesap:** Günlük 500 link, toplam 50.000 link, tek seferde 50 toplu link kısaltma, özel alias ve detaylı istatistik.
- **Özellikler:**
  - Direkt mesaj veya metin içinden URL yakalama.
  - Anında QR Kod PNG görseli üretme (`[📷 QR Kodu Al]` inline butonu).
  - `/mylinks` komutu ile link listesi ve inline `[🗑️ Sil]` butonu ile link silme.
  - 4 Dil Desteği (`az`, `tr`, `en`, `ru`).

### 3.2. Discord Botu
- Slash komutları (`/short`, `/stats`, `/help`) ile Discord kanalları üzerinden hızlı link kısaltma ve istatistik sorgulama.

---

## 4. Frontend & Tasarım Sistemi (Design System)

- **Şablon Motoru:** EJS (Server-Side Rendered).
- **Stil Altyapısı:** Vanilla CSS + Bootstrap 5 + FontAwesome 6 + Google Fonts (`Poppins`).
- **Tasarım Dili:**
  - **Glassmorphism:** `backdrop-filter: blur(24px)`, yarı saydam cam paneller, şık ince sınır çizgileri (`1px solid rgba(255,255,255,0.7)`).
  - **Canlı Gradyanlar:** Mor-İndigo-Camgöbeği (`#6366f1` -> `#4f46e5` -> `#06b6d4`) buton ve vurgu gradyanları.
  - **Arka Plan Efektleri:** Dönen konik gradyan (`animated-gradient-bg`) ve yukarı doğru süzülen ışıltılı parçacıklar (`floating particles`).
  - **Kompakt Header:** 60px standart yükseklikte ince header, `scale(3.5)` görsel ölçeklemesi ile heybetli ve net logo.
  - **Önbellek Kırma (Cache Busting):** `server.js` içindeki `ASSET_VERSION` parametresi ve PWA Service Worker (`sw.js`) Network-First stratejisi.
- **Çoklu Dil (i18n):** `public/lang.js` ve `public/lang-home.js` üzerinden `az` (Azerice), `tr` (Türkçe), `en` (İngilizce) dinamik çeviri desteği.

---

## 5. Dağıtım ve Ops Kuralları (Deployment & Ops Rules)

1. **Paket Yöneticisi:** Yalnızca `npm` ve `package-lock.json` kullanılır.
2. **Doğrulama Komutları:**
   ```bash
   npm test
   node --check server.js routes/admin.js routes/auth.js public/script.js public/lang.js bots/telegram.js bots/shared.js
   ```
3. **Sunucu Güncelleme Standart Komutu:**
   ```bash
   cd /var/www/ovlink && git fetch origin && git reset --hard origin/main && pm2 restart ovlink --update-env
   ```

---

## 6. Gelecek Planı & Hatırlatma (Roadmap)
- **Telegram Otomatik Veritabanı Yedeği:** Her gece saat 03:00'te PostgreSQL veritabanının `.sql.gz` yedeğinin alınarak Telegram Bot API `sendDocument` ile yönetici chatine otomatik gönderilmesi planlanmıştır.
