const nodemailer = require('nodemailer');
const { pickLang, normalizeLang } = require('./i18n');
const { getConfiguredPublicBaseUrl } = require('./security');
const { db } = require('../db/index');
const { decryptAES256GCM } = require('./security');

function escapeHtml(value) {
  return (value || '').toString().replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

let resendClient = null;
if (process.env.RESEND_API_KEY) {
  try {
    const { Resend } = require('resend');
    resendClient = new Resend(process.env.RESEND_API_KEY);
    console.log('[startup] Email provider: Resend API');
  } catch {
    console.warn('[startup] Resend package not available, falling back to SMTP.');
  }
}

const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'mail.spaceship.com',
  port: Number(process.env.SMTP_PORT) || 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'verify@ovlink.sbs',
    pass: process.env.SMTP_PASS,
  },
});

const SMTP_FROM = process.env.FROM_EMAIL || 'Ovlink <verify@ovlink.sbs>';
const RESEND_FROM = process.env.RESEND_FROM || 'Ovlink <verify@ovlink.sbs>';

async function sendMail({ to, subject, html, text }) {
  if (resendClient) {
    try {
      const resendRes = await resendClient.emails.send({
        from: RESEND_FROM,
        to: [to],
        subject,
        html,
        text,
      });
      if (resendRes.error) {
        throw new Error(resendRes.error.message || JSON.stringify(resendRes.error));
      }
      console.log(`[email] Resend success: to=${to}, id=${resendRes.data ? resendRes.data.id : 'unknown'}`);
      return resendRes;
    } catch (resendErr) {
      console.error('[email] Resend failed, trying SMTP fallback:', resendErr.message);
    }
  }
  
  try {
    const smtpInfo = await emailTransporter.sendMail({
      from: SMTP_FROM,
      to,
      subject,
      html,
      text,
    });
    console.log(`[email] SMTP success: to=${to}, response=${smtpInfo.response}, messageId=${smtpInfo.messageId}`);
    return smtpInfo;
  } catch (smtpErr) {
    console.error(`[email] SMTP error: to=${to}, message=${smtpErr.message}`);
    throw smtpErr;
  }
}

function sendVerificationEmail(to, code, lang = 'az') {
  const uiLang = normalizeLang(lang, 'az');
  const subject = pickLang(uiLang, "Ovlink Təsdiqləmə Kodunuz: " + code, "Ovlink Doğrulama Kodunuz: " + code, "Ovlink Verification Code: " + code);

  const translations = {
    tr: {
      welcome: "Hoş Geldiniz!",
      instruction: "Hesabınızı doğrulamak ve Ovlink'in tüm özelliklerinden yararlanmak için aşağıdaki 6 haneli kodu kullanın.",
      codeLabel: "DOĞRULAMA KODUNUZ",
      warning: "Bu kod 30 dakika süreyle geçerlidir. Eğer bu işlemi siz yapmadıysanız, bu e-postayı güvenle silebilirsiniz.",
      buttonText: "Kodu Doğrula",
      footer: "© 2026 Ovlink. Tüm hakları saklıdır."
    },
    az: {
      welcome: "Xoş Gəldiniz!",
      instruction: "Hesabınızı təsdiqləmək və Ovlink-in bütün imkanlarından yararlanmaq üçün aşağıdakı 6 rəqəmli kodu istifadə edin.",
      codeLabel: "TƏSDİQLƏMƏ KODUNUZ",
      warning: "Bu kod 30 dəqiqə ərzində keçərlidir. Əgər bu əməliyyatı siz etməmisinizsə, bu e-poçtu təhlükəsiz şəkildə silə bilərsiniz.",
      buttonText: "Kodu Təsdiqlə",
      footer: "© 2026 Ovlink. Bütün hüquqlar qorunur."
    },
    en: {
      welcome: "Welcome!",
      instruction: "Use the 6-digit code below to verify your account and access all Ovlink features.",
      codeLabel: "YOUR VERIFICATION CODE",
      warning: "This code is valid for 30 minutes. If you did not request this, you can safely ignore this email.",
      buttonText: "Verify Code",
      footer: "© 2026 Ovlink. All rights reserved."
    }
  };

  const t = translations[uiLang] || translations.az;

  const html = `
    <!DOCTYPE html>
    <html lang="${uiLang}">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
        
        body { margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; color: #1e293b; }
        .wrapper { width: 100%; table-layout: fixed; background-color: #f8fafc; padding-bottom: 40px; }
        .main { background-color: #ffffff; margin: 40px auto; width: 100%; max-width: 600px; border-radius: 24px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04); }
        .header { background: linear-gradient(135deg, #2563eb 0%, #1e40af 100%); padding: 60px 40px; text-align: center; }
        .logo { color: #ffffff; font-size: 32px; font-weight: 800; letter-spacing: -0.025em; margin: 0; }
        .content { padding: 48px 40px; text-align: center; }
        h1 { font-size: 28px; font-weight: 700; color: #0f172a; margin-bottom: 16px; margin-top: 0; }
        p { font-size: 16px; line-height: 1.6; color: #475569; margin-bottom: 32px; }
        .code-container { background: #f1f5f9; border-radius: 16px; padding: 32px; margin-bottom: 32px; border: 2px solid #e2e8f0; position: relative; }
        .code-label { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; margin-bottom: 12px; display: block; }
        .code { font-size: 48px; font-weight: 800; color: #2563eb; letter-spacing: 0.2em; margin: 0; text-shadow: 0 2px 4px rgba(37, 99, 235, 0.1); }
        .btn { display: inline-block; padding: 16px 32px; background-color: #2563eb; color: #ffffff !important; text-decoration: none; border-radius: 12px; font-weight: 600; font-size: 16px; transition: all 0.2s; box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.2); }
        .warning { font-size: 14px; color: #94a3b8; margin-top: 32px; padding: 20px; border-top: 1px solid #f1f5f9; }
        .footer { text-align: center; padding: 24px 40px; color: #94a3b8; font-size: 13px; }
        
        /* Modern animasyon simulyasiyası */
        @keyframes pulse {
          0% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.02); opacity: 0.95; }
          100% { transform: scale(1); opacity: 1; }
        }
        .animate-pulse { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="main">
          <div class="header">
            <div class="logo">OVLINK</div>
          </div>
          <div class="content">
            <h1>${t.welcome}</h1>
            <p>${t.instruction}</p>
            <div class="code-container animate-pulse">
              <span class="code-label">${t.codeLabel}</span>
              <div class="code">${code}</div>
            </div>
            <p class="warning">${t.warning}</p>
          </div>
          <div class="footer">
            ${t.footer}<br>
            Developed with &hearts; by Ulvi Ahadov
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  return sendMail({
    to,
    subject,
    text: `${t.instruction}\n\n${t.codeLabel}: ${code}\n\n${t.warning}`,
    html
  });
}

function sendPasswordResetEmail(to, resetUrl, lang = 'az') {
  const uiLang = normalizeLang(lang, 'az');
  const subject = pickLang(uiLang, 'Şifrə Sıfırlama Linki', 'Şifre Sıfırlama Bağlantısı', 'Password Reset Link');
  const title = pickLang(uiLang, 'Şifrəni Sıfırlayın', 'Şifrenizi Sıfırlayın', 'Reset your password');
  const body = pickLang(uiLang, 'Şifrəni sıfırlamaq üçün aşağıdakı linkdən istifadə edin. Bu link 30 dəqiqə etibarlıdır.', 'Şifrenizi sıfırlamak için aşağıdaki bağlantıyı kullanın. Bu bağlantı 30 dakika geçerlidir.', 'Use the link below to reset your password. This link is valid for 30 minutes.');
  const button = pickLang(uiLang, 'Şifrəni Sıfırla', 'Şifreyi Sıfırla', 'Reset Password');
  const footer = pickLang(uiLang, 'Əgər bu istəyi siz etməmisinizsə, bu e-poçtu nəzərə almayın.', 'Eğer bu isteği siz yapmadıysanız, bu e-postayı yok sayın.', 'If you did not request this, you can ignore this email.');

  const html = `
    <!DOCTYPE html>
    <html lang="${uiLang}">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
    </head>
    <body style="margin:0; padding:0; font-family:Arial, sans-serif; background:#f8fafc; color:#0f172a;">
      <div style="max-width:600px; margin:40px auto; background:#ffffff; border-radius:18px; padding:32px; border:1px solid #e2e8f0;">
        <h1 style="margin-top:0;">${title}</h1>
        <p style="line-height:1.6;">${body}</p>
        <div style="margin:24px 0;">
          <a href="${resetUrl}" style="display:inline-block; padding:12px 20px; background:#2563eb; color:#ffffff; text-decoration:none; border-radius:10px; font-weight:700;">${button}</a>
        </div>
        <p style="font-size:13px; color:#64748b;">${footer}</p>
      </div>
    </body>
    </html>
  `;

  return sendMail({
    to,
    subject,
    text: `${body} ${resetUrl}`,
    html
  });
}

function buildLoginMethodLabel(loginMethod, uiLang) {
  const safeLang = normalizeLang(uiLang, 'az');
  if (loginMethod === 'google') {
    return pickLang(safeLang, 'Google ilə giriş', 'Google ile giriş', 'Google sign-in');
  }
  if (loginMethod === 'email_verification') {
    return pickLang(safeLang, 'E-poçt təsdiqi sonrası giriş', 'E-posta doğrulaması sonrası giriş', 'Sign-in after email verification');
  }
  return pickLang(safeLang, 'Parol ilə giriş', 'Parola ile giriş', 'Password sign-in');
}

function sendNewDeviceLoginEmail(to, details = {}, lang = 'en') {
  if (!process.env.SMTP_PASS) return Promise.resolve(null);

  const uiLang = normalizeLang(lang, 'en');
  const safeTo = (to || '').toString().trim();
  if (!safeTo) return Promise.resolve(null);

  const deviceLabel = (details.deviceLabel || 'Unknown device').toString();
  const countryRaw = (details.country || '').toString().trim();
  const country = countryRaw || pickLang(uiLang, 'Naməlum', 'Bilinmiyor', 'Unknown');
  const loginMethod = (details.loginMethod || 'password').toString();
  const occurredAtRaw = (details.occurredAt || '').toString();
  const occurredAtDate = occurredAtRaw ? new Date(occurredAtRaw) : new Date();
  const locale = uiLang === 'tr' ? 'tr-TR' : (uiLang === 'en' ? 'en-US' : 'az-AZ');
  const occurredAt = Number.isNaN(occurredAtDate.getTime())
    ? occurredAtRaw
    : occurredAtDate.toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  const subject = pickLang(uiLang, 'Ovlink: Yeni cihazdan giriş', 'Ovlink: Yeni cihazdan giriş', 'Ovlink: New device sign-in');
  const title = pickLang(uiLang, 'Yeni cihazdan giriş aşkarlandı', 'Yeni cihazdan giriş algılandı', 'New device sign-in detected');
  const intro = pickLang(
    uiLang,
    'Hesabınıza yeni bir cihazdan giriş edildi. Bu siz deyildinizsə, təhlükəsizlik üçün şifrənizi dərhal yeniləyin.',
    'Hesabınıza yeni bir cihazdan giriş yapıldı. Bu size ait değilse güvenlik için şifrenizi hemen yenileyin.',
    'A new device signed in to your account. If this was not you, reset your password immediately.'
  );
  const locationNote = pickLang(
    uiLang,
    'Ölkə məlumatı təxmini ola bilər (VPN/proxy və ya operator marşrutlaması səbəbilə).',
    'Ülke bilgisi tahmini olabilir (VPN/proxy veya operatör yönlendirmesi nedeniyle).',
    'Country may be approximate (VPN/proxy or carrier routing can affect this).'
  );
  const privacyNote = pickLang(
    uiLang,
    'Bu giriş bildirişi üçün tam IP ünvanı e-poçtda göstərilmir.',
    'Bu giriş bildirimi için tam IP adresi e-postada gösterilmez.',
    'For this sign-in alert, the full IP address is not shown in email.'
  );

  const methodLabel = buildLoginMethodLabel(loginMethod, uiLang);
  const timeLabel = pickLang(uiLang, 'Vaxt', 'Zaman', 'Time');
  const deviceTitle = pickLang(uiLang, 'Cihaz', 'Cihaz', 'Device');
  const countryTitle = pickLang(uiLang, 'Təxmini ölkə', 'Tahmini ülke', 'Approximate country');
  const methodTitle = pickLang(uiLang, 'Metod', 'Yöntem', 'Method');

  const siteBase = getConfiguredPublicBaseUrl() || 'https://ovlink.sbs';
  const resetPasswordUrl = `${siteBase}/forgot-password`;
  const contactUrl = `${siteBase}/contact`;
  const resetBtn = pickLang(uiLang, 'Şifrəni yenilə', 'Şifreyi yenile', 'Reset password');
  const contactBtn = pickLang(uiLang, 'Dəstək ilə əlaqə', 'Destek ile iletişim', 'Contact support');

  const rows = [
    `<tr><td style="padding:10px 0;color:#667085;font-size:13px;">${deviceTitle}</td><td style="padding:10px 0;color:#0f172a;font-size:14px;font-weight:700;">${escapeHtml(deviceLabel)}</td></tr>`,
    `<tr><td style="padding:10px 0;color:#667085;font-size:13px;">${countryTitle}</td><td style="padding:10px 0;color:#0f172a;font-size:14px;font-weight:700;">${escapeHtml(country)}</td></tr>`,
    `<tr><td style="padding:10px 0;color:#667085;font-size:13px;">${methodTitle}</td><td style="padding:10px 0;color:#0f172a;font-size:14px;font-weight:700;">${escapeHtml(methodLabel)}</td></tr>`,
    `<tr><td style="padding:10px 0;color:#667085;font-size:13px;">${timeLabel}</td><td style="padding:10px 0;color:#0f172a;font-size:14px;font-weight:700;">${escapeHtml(occurredAt)}</td></tr>`,
  ];

  const html = `
    <!DOCTYPE html>
    <html lang="${uiLang}">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${subject}</title>
    </head>
    <body style="margin:0;padding:28px 14px;background:#eef2ff;font-family:Inter,Arial,sans-serif;color:#0f172a;">
      <div style="max-width:660px;margin:0 auto;background:#ffffff;border:1px solid #dbe3ff;border-radius:24px;box-shadow:0 18px 34px rgba(79,70,229,.12);overflow:hidden;">
        <div style="padding:20px 24px;background:linear-gradient(98deg,#4f46e5,#0ea5e9);color:#fff;">
          <div style="font-weight:800;letter-spacing:.08em;font-size:14px;">OVLINK SECURITY</div>
          <div style="opacity:.9;font-size:12px;margin-top:4px;">${pickLang(uiLang, 'Yeni giriş bildirişi', 'Yeni giriş bildirimi', 'New sign-in alert')}</div>
        </div>

        <div style="padding:24px;">
          <h2 style="margin:0 0 10px 0;font-size:28px;line-height:1.15;color:#0b1329;">${title}</h2>
          <p style="margin:0 0 18px 0;color:#334155;line-height:1.65;font-size:14px;">${intro}</p>

          <div style="background:#f8faff;border:1px solid #dbe3ff;border-radius:16px;padding:14px 16px;">
            <table style="width:100%;border-collapse:collapse;">${rows.join('')}</table>
          </div>

          <div style="margin-top:14px;padding:12px 14px;border-radius:12px;background:#eef4ff;border:1px solid #d6e2ff;color:#334155;font-size:12px;line-height:1.55;">
            <div>${privacyNote}</div>
            <div style="margin-top:4px;">${locationNote}</div>
          </div>

          <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap;">
            <a href="${escapeHtml(resetPasswordUrl)}" style="display:inline-block;padding:10px 16px;border-radius:12px;background:#4f46e5;color:#fff;text-decoration:none;font-size:13px;font-weight:700;">${resetBtn}</a>
            <a href="${escapeHtml(contactUrl)}" style="display:inline-block;padding:10px 16px;border-radius:12px;border:1px solid #cbd5ff;color:#334155;text-decoration:none;font-size:13px;font-weight:700;background:#fff;">${contactBtn}</a>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const text = [
    title,
    intro,
    `${deviceTitle}: ${deviceLabel}`,
    `${countryTitle}: ${country}`,
    `${methodTitle}: ${methodLabel}`,
    `${timeLabel}: ${occurredAt}`,
    privacyNote,
    locationNote,
    `${pickLang(uiLang, 'Şifrəni yenilə', 'Şifreyi yenile', 'Reset password')}: ${resetPasswordUrl}`,
    `${pickLang(uiLang, 'Dəstək ilə əlaqə', 'Destek ile iletişim', 'Contact support')}: ${contactUrl}`,
  ].filter(Boolean).join('\n');

  return sendMail({
    to: safeTo,
    subject,
    text,
    html,
  });
}

function sendNewDeviceLoginEmailForUser(userId, details = {}) {
  db.get('SELECT email, ui_lang FROM users WHERE id = ?', [userId], (err, row) => {
    if (err || !row || !row.email) return;
    // users.email is stored encrypted; the mail transport needs the plaintext.
    sendNewDeviceLoginEmail(decryptAES256GCM(row.email), details, row.ui_lang || 'en').catch((mailErr) => {
      console.error('new-device-email failed:', mailErr && (mailErr.message || mailErr));
    });
  });
}

module.exports = {
  sendMail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendNewDeviceLoginEmail,
  sendNewDeviceLoginEmailForUser,
  escapeHtml
};
