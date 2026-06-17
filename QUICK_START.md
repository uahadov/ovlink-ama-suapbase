# ⚡ Ovlink Hızlı Başlangıç

## 🎯 5 Dakikada Başlat

### 1️⃣ Environment Dosyasını Kontrol Et
```bash
npm run check:env
```

### 2️⃣ Email Sistemini Test Et
```bash
npm run test:email
```

### 3️⃣ Database'i Kontrol Et
```bash
npm run check:database
```

### 4️⃣ Sunucuyu Başlat
```bash
npm start
```

### 5️⃣ Tarayıcıda Aç
```
http://localhost:3000
```

---

## ❌ Hata Alıyorum!

### Email Gelmiyor
1. Resend dashboard: https://resend.com/domains
2. Domain'ini doğrula (ovlink.sbs)
3. DNS kayıtlarını ekle
4. `npm run test:email` ile tekrar test et

### Google OAuth Çalışmıyor
1. Console log'una bak: `[google-auth] Status: ?`
2. Environment'ı kontrol et: `npm run check:env`
3. Google Cloud Console'da redirect URI'yi kontrol et:
   ```
   https://ovlink.sbs/auth/google/callback
   ```

### Database Hatası
1. PostgreSQL çalışıyor mu kontrol et
2. `DATABASE_URL` doğru mu kontrol et
3. `npm run check:database` çalıştır

---

## 📚 Detaylı Rehber

`SETUP_GUIDE.md` dosyasını oku.

## 🐛 Bug Listesi

`BUG_FIXES_SUMMARY.md` dosyasını oku.

---

## ✅ Tüm Testler

```bash
# Hepsini bir seferde çalıştır
npm run check:all && npm run test:email
```

---

## 🆘 Hala Sorun mu Var?

1. `.env` dosyasını kontrol et
2. Sunucu loglarını oku (npm start)
3. `SETUP_GUIDE.md` → "Sorun Giderme" bölümüne bak

**Developed by Ulvi Ahadov** 🚀
