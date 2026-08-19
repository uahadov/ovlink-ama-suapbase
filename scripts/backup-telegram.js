#!/usr/bin/env node
'use strict';

/**
 * scripts/backup-telegram.js
 * PostgreSQL yedeği alır, gzip'ler, Telegram'a gönderir.
 * Cron: Her gece 03:00 → node /var/www/ovlink/scripts/backup-telegram.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.BACKUP_TELEGRAM_CHAT_ID || process.env.ALERT_TG_CHAT_ID;
const DB_URL    = process.env.DATABASE_URL;

if (!BOT_TOKEN || !CHAT_ID || !DB_URL) {
  console.error('[backup] ❌ TELEGRAM_BOT_TOKEN, BACKUP_TELEGRAM_CHAT_ID veya DATABASE_URL eksik!');
  process.exit(1);
}

const date     = new Date().toISOString().slice(0, 10);
const dumpFile = `/tmp/ovlink_backup_${date}.dump`;
const gzFile   = `${dumpFile}.gz`;

async function main() {
  const startTime = Date.now();
  console.log(`[backup] ⏳ ${new Date().toISOString()} — Yedekleme başlıyor...`);

  for (const f of [dumpFile, gzFile]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  // 1. pg_dump
  try {
    execSync(`pg_dump "${DB_URL}" --format=custom --file="${dumpFile}"`, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    console.log('[backup] ✅ pg_dump tamamlandı');
  } catch (err) {
    console.error('[backup] ❌ pg_dump hatası:', err.stderr?.toString() || err.message);
    await sendAlert(`❌ *Ovlink DB Yedeği BAŞARISIZ*\n📅 ${date}\n\nHata: pg_dump başarısız`);
    process.exit(1);
  }

  // 2. Gzip
  try {
    execSync(`gzip -f "${dumpFile}"`);
    console.log('[backup] ✅ Gzip tamamlandı');
  } catch (err) {
    console.error('[backup] ❌ gzip hatası:', err.message);
    process.exit(1);
  }

  const sizeKB  = (fs.statSync(gzFile).size / 1024).toFixed(1);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[backup] 📦 Boyut: ${sizeKB} KB`);

  // 3. Telegram'a gönder
  const caption =
    `🗄️ *Ovlink DB Yedeği*\n` +
    `📅 Tarih: ${date}\n` +
    `📦 Boyut: ${sizeKB} KB\n` +
    `⏱️ Süre: ${elapsed}s\n` +
    `✅ Otomatik yedek başarılı`;

  try {
    await sendDocument(gzFile, caption);
    console.log("[backup] ✅ Telegram'a gönderildi!");
  } catch (err) {
    console.error('[backup] ❌ Telegram hatası:', err.message);
    process.exit(1);
  }

  // 4. Temizlik
  fs.unlinkSync(gzFile);
  console.log(`[backup] 🏁 Tamamlandı — ${new Date().toISOString()}`);
}

function sendDocument(filePath, caption) {
  return new Promise((resolve, reject) => {
    const fileContent = fs.readFileSync(filePath);
    const filename    = path.basename(filePath);
    const boundary    = 'BackupBoundary' + Date.now().toString(36);

    const parts = [
      field(boundary, 'chat_id',    String(CHAT_ID)),
      field(boundary, 'parse_mode', 'Markdown'),
      field(boundary, 'caption',    caption),
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
        `Content-Type: application/gzip\r\n\r\n`
      ),
      fileContent,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ];

    const body = Buffer.concat(parts);

    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendDocument`,
      method:   'POST',
      headers:  {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.ok) return resolve(json);
          reject(new Error(json.description || 'Telegram API hatası'));
        } catch {
          reject(new Error('Telegram yanıtı parse edilemedi'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendAlert(text) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({
      chat_id: String(CHAT_ID), text, parse_mode: 'Markdown',
    }));
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

function field(boundary, name, value) {
  return Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
    `${value}\r\n`
  );
}

main().catch(err => {
  console.error('[backup] 💥 Beklenmeyen hata:', err);
  process.exit(1);
});
