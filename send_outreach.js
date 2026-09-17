require('dotenv').config();

/**
 * Ovlink Spacemail (support@ovlink.sbs) Otomatik Soğuk E-posta (Cold Outreach) Gönderici
 * 
 * Kullanım:
 *   1) Simülasyon (Hiçbir mail atmaz, sadece ekrana basar):
 *      node send_outreach.js --dry-run
 * 
 *   2) Kendinize Test Maili Gönderme:
 *      node send_outreach.js --test sizin_mailiniz@gmail.com --pass "SIFRE"
 * 
 *   3) İlk 5 Şirketin CEO'suna Gerçek Gönderim (Güvenli Test):
 *      node send_outreach.js --send --limit 5 --pass "SIFRE"
 * 
 *   4) Tüm Listeye Gönderim (15 saniye aralıklarla güvenli gönderim):
 *      node send_outreach.js --send --pass "SIFRE"
 */

const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const WORKSPACE_DIR = __dirname;
const CSV_PATH = path.join(WORKSPACE_DIR, 'ovlink_ceo_direct_leads.csv');

// SMTP Ayarları (Spacemail / B2B)
const SMTP_CONFIG = {
  host: process.env.SMTP_HOST || 'mail.spacemail.com',
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: true, // SSL (port 465)
  auth: {
    user: process.env.B2B_SMTP_USER || process.env.SMTP_USER || 'support@ovlink.sbs',
    pass: (process.env.B2B_SMTP_PASS || process.env.SMTP_PASS || '').replace(/\s+/g, '')
  },
  family: 4,
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000
};

// Argümanları Ayrıştır
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isSend = args.includes('--send');
const testIdx = args.indexOf('--test');
const testEmail = testIdx !== -1 ? args[testIdx + 1] : null;
const passIdx = args.indexOf('--pass');
const cliPass = passIdx !== -1 ? args[passIdx + 1] : null;
const limitIdx = args.indexOf('--limit');
const sendLimit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 999;
const delaySec = 15; // Mailler arası spam koruma beklemesi (saniye)

// CSV Ayrıştırıcı
function parseCsv(content) {
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const fields = [];
    let cur = '';
    let inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      const char = line[c];
      if (char === '"') {
        if (inQuotes && line[c+1] === '"') { cur += '"'; c++; }
        else { inQuotes = !inQuotes; }
      } else if (char === ',' && !inQuotes) {
        fields.push(cur);
        cur = '';
      } else {
        cur += char;
      }
    }
    fields.push(cur);
    rows.push(fields.map(f => f.replace(/^"|"$/g, '')));
  }
  return rows;
}

// Kişiselleştirilmiş E-posta Şablonu Oluşturucu
function createEmailContent(lead) {
  const name = lead.ceoName && !lead.ceoName.toLowerCase().includes('belirtilmedi') ? lead.ceoName : '';
  const firstName = name ? name.split(' ')[0] : 'Yetkili';
  const company = lead.company || 'ajansınız';

  // Backlinko & Lavender.ai: Kısa konu başlığı, düşük satış algısı (36-50 karakter).
  const subject = `Link yönetimi / ${company}`;

  // Gong.io & Josh Braun: Cost of Inaction (Kayıptan kaçınma), Interest CTA, max 50 kelime.
  const textBody = `Merhaba ${firstName},

${company} web sitesini incelerken kampanyalarınızdaki link yönlendirmelerini standart URL'ler üzerinden yaptığınızı fark ettim.

Büyük ajansların çoğu, tıkladıktan sonra hangi platformdan ne kadar dönüşüm geldiğini net olarak ölçemedikleri için reklam bütçelerinin bir kısmını boşa harcıyor.

Ovlink ile kendi markanız üzerinden akıllı linkler oluşturup; kampanya trafiğini cihaza (iOS/Android) veya konuma göre yönlendirmek ve tüm tıklama verilerini anlık ölçmek, şu an ilginizi çekebilecek bir konu mu?

İyi çalışmalar,
Ovlink Ekibi
https://ovlink.sbs

---
Bu e-postayı almak istemiyorsanız, lütfen bu e-postayı 'çıkış' yazarak yanıtlayınız.
Ovlink Platform · https://ovlink.sbs · info@ovlink.sbs`;

  const text = textBody;

  // Teslim edilebilirlik için Plain-Text'e çok yakın, sadece linkleri tıklanabilir yapan basit HTML.
  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; color: #1e293b; line-height: 1.6; max-width: 580px;">
  <p>Merhaba ${firstName},</p>
  <p>${company} web sitesini incelerken kampanyalarınızdaki link yönlendirmelerini standart URL'ler üzerinden yaptığınızı fark ettim.</p>
  <p>Büyük ajansların çoğu, tıkladıktan sonra hangi platformdan ne kadar dönüşüm geldiğini net olarak ölçemedikleri için reklam bütçelerinin bir kısmını boşa harcıyor.</p>
  <p>Ovlink ile kendi markanız üzerinden akıllı linkler oluşturup; kampanya trafiğini cihaza (iOS/Android) veya konuma göre yönlendirmek ve tüm tıklama verilerini anlık ölçmek, şu an ilginizi çekebilecek bir konu mu?</p>
  <p>İyi çalışmalar,<br>
  <strong>Ovlink Ekibi</strong><br>
  <a href="https://ovlink.sbs" style="color: #2563eb; text-decoration: none;">https://ovlink.sbs</a></p>
  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0 16px 0;" />
  <p style="font-size: 11px; color: #94a3b8; line-height: 1.4;">
    Bu e-postayı almak istemiyorsanız, lütfen bu e-postayı 'çıkış' yazarak yanıtlayınız.<br>
    Ovlink Platform · <a href="https://ovlink.sbs/privacy" style="color: #94a3b8;">Məxfilik Siyasəti</a>
  </p>
</div>`;

  return { subject, text, html };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=====================================================');
  console.log('🚀 Ovlink Otomatik Soğuk E-posta (Outreach) Sistemi');
  console.log('=====================================================\n');

  if (!fs.existsSync(CSV_PATH)) {
    console.error(`HATA: CSV dosyası bulunamadı: ${CSV_PATH}`);
    process.exit(1);
  }

  const csvContent = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsv(csvContent);

  const leads = rows.map(r => ({
    rank: r[0],
    company: r[1],
    category: r[2],
    ceoName: r[3],
    ceoTitle: r[4],
    ceoEmail: r[5],
    companyEmail: r[6],
    phone: r[7],
    website: r[8],
    address: r[9]
  }));

  // Hedef alıcıları seç (önce CEO doğrudan maili, yoksa şirket maili)
  const targetLeads = leads.filter(l => {
    const email = l.ceoEmail && !l.ceoEmail.includes('Belirtilmedi') ? l.ceoEmail : l.companyEmail;
    return email && email.includes('@');
  });

  console.log(`📋 Toplam Lead: ${leads.length}`);
  console.log(`🎯 Gönderim Yapılabilir Karar Verici: ${targetLeads.length}\n`);

  // --- MOD 1: DRY RUN (SİMÜLASYON) ---
  if (isDryRun) {
    console.log('🔍 [DRY-RUN MODU] Gerçek e-posta GÖNDERİLMEYECEK. Önizleme yapılıyor:\n');
    targetLeads.slice(0, 10).forEach((lead, i) => {
      const email = lead.ceoEmail && !lead.ceoEmail.includes('Belirtilmedi') ? lead.ceoEmail : lead.companyEmail;
      const content = createEmailContent(lead);
      console.log(`[${i + 1}] Kime: ${email} (${lead.ceoName || 'Yetkili'} - ${lead.company})`);
      console.log(`    Konu: ${content.subject}`);
    });
    console.log(`\n... ve diğer ${targetLeads.length - 10} alıcı.`);
    console.log('\n💡 Gerçek gönderim yapmak için:');
    console.log('   node send_outreach.js --send --pass "SPACEMAIL_SIFRENIZ" --limit 5\n');
    return;
  }

  // --- Şifre Kontrolü ---
  const password = cliPass || process.env.SMTP_PASS || process.env.B2B_SMTP_PASS;
  if (!password && !isDryRun) {
    console.log('⚠️  DİKKAT: Spacemail (support@ovlink.sbs) şifresi girilmedi.');
    console.log('Kullanım:');
    console.log('  node scratch/send_outreach.js --send --pass "SIFRENIZ"');
    console.log('Veya tekil test için:');
    console.log('  node scratch/send_outreach.js --test sizin_mailiniz@gmail.com --pass "SIFRENIZ"\n');
    return;
  }

  SMTP_CONFIG.auth.pass = password;
  const transporter = nodemailer.createTransport(SMTP_CONFIG);

  // SMTP Bağlantı Testi
  console.log('🔌 Spacemail SMTP sunucusuna bağlanılıyor (mail.spacemail.com:465)...');
  try {
    await transporter.verify();
    console.log('✅ Spacemail bağlantısı BAŞARILI! (support@ovlink.sbs doğrulandı)\n');
  } catch (err) {
    console.error('❌ SMTP Bağlantı Hatası:', err.message);
    console.log('Lütfen support@ovlink.sbs şifrenizi kontrol ediniz.\n');
    return;
  }

  // --- MOD 2: TEKİL TEST GÖNDERİMİ ---
  if (testEmail) {
    console.log(`📬 [TEST MODU] Test e-postası gönderiliyor: ${testEmail}...`);
    const sampleLead = targetLeads[0] || { company: 'Örnek Ajans', ceoName: 'Test Yetkili' };
    const content = createEmailContent(sampleLead);
    
    await transporter.sendMail({
      from: `"Ovlink Support" <${SMTP_CONFIG.auth.user}>`,
      replyTo: SMTP_CONFIG.auth.user,
      to: testEmail,
      subject: `[TEST] ${content.subject}`,
      text: content.text,
      html: content.html,
      headers: {
        'List-Unsubscribe': `<mailto:${SMTP_CONFIG.auth.user}?subject=unsubscribe>`,
        'X-Entity-Ref-ID': `ovlink-test-${Date.now()}`
      }
    });

    console.log(`✅ Test e-postası başarıyla gönderildi -> ${testEmail}`);
    console.log('Lütfen gelen kutunuzu (ve spam klasörünü) kontrol edin!\n');
    return;
  }

  // --- MOD 3: GERÇEK TOPLU GÖNDERİM (GÜVENLİ & GECİKMELİ) ---
  if (isSend) {
    const queue = targetLeads.slice(0, sendLimit);
    console.log(`⚡ [GERÇEK GÖNDERİM] Toplam ${queue.length} karar vericiye e-posta gönderilecek.`);
    console.log(`⏱️  Domain itibarınızı (Spam Score) korumak için her mail arası ${delaySec} saniye bekleniyor...\n`);

    let sentCount = 0;
    let failCount = 0;

    for (let i = 0; i < queue.length; i++) {
      const lead = queue[i];
      const targetEmail = lead.ceoEmail && !lead.ceoEmail.includes('Belirtilmedi') ? lead.ceoEmail : lead.companyEmail;
      const content = createEmailContent(lead);

      console.log(`[${i + 1}/${queue.length}] Gönderiliyor: ${targetEmail} (${lead.ceoName || 'Yetkili'} - ${lead.company})...`);

      try {
        await transporter.sendMail({
          from: `"Ovlink Support" <${SMTP_CONFIG.auth.user}>`,
          replyTo: SMTP_CONFIG.auth.user,
          to: targetEmail,
          subject: content.subject,
          text: content.text,
          html: content.html,
          headers: {
            'List-Unsubscribe': `<mailto:${SMTP_CONFIG.auth.user}?subject=unsubscribe>`,
            'X-Entity-Ref-ID': `ovlink-lead-${i + 1}`
          }
        });
        sentCount++;
        console.log(`   ✅ Gönderildi!`);
      } catch (err) {
        failCount++;
        console.error(`   ❌ Hata:`, err.message);
      }

      // Son mail değilse bekle
      if (i < queue.length - 1) {
        console.log(`   ⏳ Sonraki mail için ${delaySec} saniye bekleniyor...`);
        await sleep(delaySec * 1000);
      }
    }

    console.log('\n=====================================================');
    console.log(`🎉 Gönderim Tamamlandı!`);
    console.log(`   Başarılı: ${sentCount}`);
    console.log(`   Hatalı:   ${failCount}`);
    console.log('=====================================================\n');
  }
}

main().catch(console.error);
