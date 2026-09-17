const nodemailer = require('nodemailer');
const { pickLang, normalizeLang } = require('./i18n');
const { getConfiguredPublicBaseUrl } = require('./security');
const { db } = require('../db/index');
const { decryptAES256GCM } = require('../../utils/crypto');
const fs = require('fs');
const path = require('path');

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

const tls = require('tls');
let MailComposer = null;
try {
  MailComposer = require('nodemailer/lib/mail-composer');
} catch {}

const smtpPort = Number(process.env.SMTP_PORT) || 587;
const isSecure = process.env.SMTP_SECURE != null
  ? (process.env.SMTP_SECURE === 'true' || process.env.SMTP_SECURE === '1')
  : (smtpPort === 465);

const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: smtpPort,
  secure: isSecure,
  auth: {
    user: process.env.SMTP_USER || 'verify@ovlink.sbs',
    pass: (process.env.SMTP_PASS || '').replace(/\s+/g, ''),
  },
  family: 4,
  connectionTimeout: 25000,
  greetingTimeout: 25000,
  socketTimeout: 35000,
});

const SMTP_FROM = process.env.FROM_EMAIL || process.env.SMTP_USER || 'Ovlink <verify@ovlink.sbs>';
const RESEND_FROM = process.env.RESEND_FROM || process.env.FROM_EMAIL || 'Ovlink <verify@ovlink.sbs>';

function appendSentMailToImap(mailOptions, credentials = {}) {
  return new Promise((resolve) => {
    try {
      const defaultImapHost = (process.env.SMTP_HOST && process.env.SMTP_HOST.includes('spacemail'))
        ? 'mail.spacemail.com'
        : (process.env.SMTP_HOST && process.env.SMTP_HOST.includes('gmail'))
          ? 'imap.gmail.com'
          : (process.env.SMTP_HOST || 'mail.spacemail.com');
      const imapHost = process.env.IMAP_HOST || defaultImapHost;
      const imapPort = Number(process.env.IMAP_PORT) || 993;
      const user = credentials.user || process.env.SMTP_USER;
      const pass = (credentials.pass || process.env.SMTP_PASS || '').replace(/\s+/g, '');
      const folder = process.env.IMAP_SENT_FOLDER || 'Sent';

      if (!user || !pass || !MailComposer) {
        return resolve(false);
      }

      const safeUser = user.replace(/["\\]/g, '\\$&');
      const safePass = pass.replace(/["\\]/g, '\\$&');
      const safeFolder = folder.replace(/["\\]/g, '\\$&');

      const mail = new MailComposer(mailOptions);
      mail.compile().build((err, rawBuffer) => {
        if (err || !rawBuffer) {
          return resolve(false);
        }

        let socket;
        try {
          socket = tls.connect(imapPort, imapHost, { rejectUnauthorized: false }, () => {});
        } catch {
          return resolve(false);
        }
        socket.setEncoding('utf8');

        let finished = false;
        let timeout;

        const done = (result) => {
          if (finished) return;
          finished = true;
          if (timeout) clearTimeout(timeout);
          try {
            if (socket && !socket.destroyed) {
              socket.destroy();
            }
          } catch {}
          resolve(result);
        };

        timeout = setTimeout(() => done(false), 8000);
        if (typeof timeout.unref === 'function') timeout.unref();

        let step = 0;

        socket.on('data', (chunk) => {
          if (finished) return;

          if (step === 0 && chunk.includes('* OK')) {
            step = 1;
            socket.write(`A01 LOGIN "${safeUser}" "${safePass}"\r\n`);
          } else if (step === 1 && chunk.includes('A01 OK')) {
            step = 2;
            socket.write(`A02 APPEND "${safeFolder}" (\\Seen) {${rawBuffer.length}}\r\n`);
          } else if (step === 2 && chunk.includes('+')) {
            step = 3;
            socket.write(rawBuffer);
            socket.write('\r\n');
          } else if (step === 3 && chunk.includes('A02 OK')) {
            step = 4;
            try {
              socket.write('A03 LOGOUT\r\n');
              socket.end();
            } catch {}
            console.log(`[imap-sent] Successfully archived sent message to SpaceMail "${safeFolder}" folder (${user}).`);
            done(true);
          } else if (
            chunk.includes('A01 NO') || chunk.includes('A01 BAD') ||
            chunk.includes('A02 NO') || chunk.includes('A02 BAD') ||
            chunk.includes('* BYE') || chunk.includes('* NO')
          ) {
            done(false);
          }
        });

        socket.on('close', () => done(false));
        socket.on('error', () => done(false));
      });
    } catch {
      resolve(false);
    }
  });
}

async function sendMail({ to, subject, html, text, preferSmtp = false, saveToSent = false, isB2B = false }) {
  const b2bUser = process.env.B2B_SMTP_USER || 'support@ovlink.sbs';
  const b2bPass = (process.env.B2B_SMTP_PASS || '').replace(/\s+/g, '');
  const useB2B = Boolean(isB2B && b2bPass);

  const activeTransporter = useB2B
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'mail.spacemail.com',
        port: smtpPort,
        secure: isSecure,
        auth: { user: b2bUser, pass: b2bPass },
        family: 4,
        connectionTimeout: 25000,
        greetingTimeout: 25000,
        socketTimeout: 35000,
      })
    : emailTransporter;

  const activeFrom = isB2B
    ? (process.env.B2B_FROM_EMAIL || `Ovlink Support <${b2bUser}>`)
    : SMTP_FROM;

  const activeResendFrom = isB2B
    ? (process.env.B2B_FROM_EMAIL || `Ovlink Support <${b2bUser}>`)
    : RESEND_FROM;

  const imapCreds = useB2B
    ? { user: b2bUser, pass: b2bPass }
    : { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };

  const trySaveToImap = (fromAddr) => {
    if (saveToSent || process.env.SMTP_SAVE_TO_SENT === '1') {
      appendSentMailToImap({ from: fromAddr, to, subject, html, text }, imapCreds).catch(err => {
        console.warn('[email] IMAP append warning:', err?.message || err);
      });
    }
  };

  // 1. If preferSmtp is true and credentials are valid for the sender, attempt SMTP first
  const shouldTrySmtp = preferSmtp && (!isB2B || useB2B);
  if (shouldTrySmtp) {
    try {
      const from = activeFrom;
      const smtpInfo = await activeTransporter.sendMail({
        from,
        to,
        subject,
        html,
        text,
      });
      console.log(`[email] SMTP success: to=${to}, response=${smtpInfo.response}, messageId=${smtpInfo.messageId}`);
      trySaveToImap(from);
      return smtpInfo;
    } catch (smtpErr) {
      console.warn(`[email] Preferred SMTP send failed (${smtpErr.message}); falling back to Resend API`);
      if (resendClient) {
        try {
          const resendRes = await resendClient.emails.send({
            from: activeResendFrom,
            to: [to],
            subject,
            html,
            text,
          });
          if (resendRes.error) {
            throw new Error(resendRes.error.message || JSON.stringify(resendRes.error));
          }
          console.log(`[email] Resend fallback success: to=${to}, id=${resendRes.data ? resendRes.data.id : 'unknown'}`);
          trySaveToImap(activeResendFrom);
          return resendRes;
        } catch (resendErr) {
          console.error('[email] Resend fallback also failed:', resendErr.message);
          throw new Error(`E-posta gönderilemedi (SMTP: ${smtpErr.message} | Resend: ${resendErr.message})`);
        }
      }
      throw smtpErr;
    }
  }

  // 2. Default flow: Try Resend first, fallback to SMTP
  if (resendClient) {
    try {
      const resendRes = await resendClient.emails.send({
        from: activeResendFrom,
        to: [to],
        subject,
        html,
        text,
      });
      if (resendRes.error) {
        throw new Error(resendRes.error.message || JSON.stringify(resendRes.error));
      }
      console.log(`[email] Resend success: to=${to}, id=${resendRes.data ? resendRes.data.id : 'unknown'}`);
      trySaveToImap(activeResendFrom);
      return resendRes;
    } catch (resendErr) {
      console.warn('[email] Resend failed, trying SMTP fallback:', resendErr.message);
    }
  }
  
  if (!isB2B || useB2B) {
    try {
      const from = activeFrom;
      const smtpInfo = await activeTransporter.sendMail({
        from,
        to,
        subject,
        html,
        text,
      });
      console.log(`[email] SMTP success: to=${to}, response=${smtpInfo.response}, messageId=${smtpInfo.messageId}`);
      trySaveToImap(from);
      return smtpInfo;
    } catch (smtpErr) {
      console.error(`[email] SMTP send failed:`, smtpErr.message);
      throw smtpErr;
    }
  } else {
    throw new Error('support@ovlink.sbs üçün SpaceMail SMTP şifrəsi (B2B_SMTP_PASS) təyin edilməyib və Resend uğursuz oldu.');
  }
}

function buildMonolithEmailShell({ uiLang = 'az', badge = 'OVLINK SECURITY', title = '', subtitle = '', contentHtml = '', footerNote = '' }) {
  const safeLang = normalizeLang(uiLang, 'az');
  const footerSec = pickLang(
    safeLang,
    'Bu avtomatik təhlükəsizlik bildirişidir. Əgər bu əməliyyatı siz etməmisinizsə, hesabınızı qorumaq üçün dərhal addım atın.',
    'Bu otomatik bir güvenlik bildirimidir. Bu işlemi siz yapmadıysanız, hesabınızı korumak için lütfen hemen harekete geçin.',
    'This is an automated security notification. If you did not perform this action, please take immediate steps to secure your account.'
  );

  return `<!DOCTYPE html>
<html lang="${safeLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700;800&display=swap');
    body { margin: 0; padding: 0; background-color: #0a0a0a; color: #f3f4f6; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
    table { border-collapse: collapse; }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#0a0a0a; color:#f3f4f6; font-family:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0a0a0a; width:100%; margin:0; padding:32px 12px;">
    <tr>
      <td align="center">
        <!-- Main Card Container -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px; margin:0 auto; background-color:#111111; border:1px solid #262626; border-radius:16px; overflow:hidden; box-shadow:0 18px 40px rgba(0,0,0,0.75);">
          <!-- Header Bar -->
          <tr>
            <td style="background-color:#161616; border-bottom:1px solid #262626; padding:18px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="left">
                    <span style="display:inline-block; vertical-align:middle; font-weight:800; font-size:15px; letter-spacing:0.04em; color:#ffffff;">
                      <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#3b82f6; margin-right:8px; box-shadow:0 0 10px #3b82f6;"></span>OVLINK
                    </span>
                  </td>
                  <td align="right">
                    <span style="display:inline-block; font-family:'JetBrains Mono', Consolas, monospace; font-size:10px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#9ca3af; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.1); border-radius:999px; padding:3px 10px;">
                      ${escapeHtml(badge)}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body Content -->
          <tr>
            <td style="padding:32px 28px;">
              ${title ? `<h1 style="margin:0 0 8px 0; font-size:22px; font-weight:800; letter-spacing:-0.02em; color:#ffffff;">${escapeHtml(title)}</h1>` : ''}
              ${subtitle ? `<p style="margin:0 0 24px 0; font-size:14px; line-height:1.6; color:#9ca3af;">${escapeHtml(subtitle)}</p>` : ''}
              ${contentHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 24px; background-color:#0d0d0d; border-top:1px solid #202020; text-align:center;">
              ${footerNote ? `<p style="margin:0 0 8px 0; font-size:12px; color:#6b7280; line-height:1.5;">${escapeHtml(footerNote)}</p>` : ''}
              <p style="margin:0 0 4px 0; font-size:11.5px; color:#4b5563;">
                ${footerSec}
              </p>
              <p style="margin:6px 0 0 0; font-size:11px; color:#374151; font-family:'JetBrains Mono', monospace;">
                © 2026 Ovlink · Next-Gen Link Management
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function sendVerificationEmail(to, code, lang = 'az') {
  const uiLang = normalizeLang(lang, 'az');
  const subject = pickLang(uiLang, "Ovlink Təsdiqləmə Kodunuz: " + code, "Ovlink Doğrulama Kodunuz: " + code, "Ovlink Verification Code: " + code);

  const translations = {
    tr: {
      welcome: "Hoş Geldiniz!",
      instruction: "Hesabınızı doğrulamak ve Ovlink'in tüm özelliklerinden yararlanmak için aşağıdaki 6 haneli tek kullanımlık kodu kullanın.",
      codeLabel: "DOĞRULAMA KODUNUZ",
      warning: "Bu kod 30 dakika süreyle geçerlidir. Eğer bu işlemi siz yapmadıysanız, bu e-postayı güvenle yok sayabilirsiniz.",
      footer: "© 2026 Ovlink. Tüm hakları saklıdır."
    },
    az: {
      welcome: "Xoş Gəldiniz!",
      instruction: "Hesabınızı təsdiqləmək və Ovlink-in bütün imkanlarından yararlanmaq üçün aşağıdakı 6 rəqəmli birdəfəlik kodu istifadə edin.",
      codeLabel: "TƏSDİQLƏMƏ KODUNUZ",
      warning: "Bu kod 30 dəqiqə ərzində keçərlidir. Əgər bu əməliyyatı siz etməmisinizsə, bu e-poçtu təhlükəsiz şəkildə nəzərə almaya bilərsiniz.",
      footer: "© 2026 Ovlink. Bütün hüquqlar qorunur."
    },
    en: {
      welcome: "Welcome!",
      instruction: "Use the 6-digit one-time code below to verify your account and unlock all Ovlink features.",
      codeLabel: "YOUR VERIFICATION CODE",
      warning: "This code is valid for 30 minutes. If you did not request this, you can safely ignore this email.",
      footer: "© 2026 Ovlink. All rights reserved."
    }
  };

  const t = translations[uiLang] || translations.az;

  const contentHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 0 0 24px 0;">
      <tr>
        <td align="center" style="background-color: #0a0a0a; border: 1px solid rgba(59, 130, 246, 0.4); border-radius: 12px; padding: 26px 16px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);">
          <div style="font-family: 'JetBrains Mono', Consolas, Monaco, monospace; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.14em; color: #60a5fa; margin-bottom: 10px;">
            ${t.codeLabel}
          </div>
          <div style="font-family: 'JetBrains Mono', Consolas, Monaco, monospace; font-size: 40px; font-weight: 800; letter-spacing: 0.22em; color: #ffffff; text-shadow: 0 0 24px rgba(59, 130, 246, 0.4); padding-left: 0.22em;">
            ${escapeHtml(code)}
          </div>
        </td>
      </tr>
    </table>
    <div style="background-color: #161616; border: 1px solid #262626; border-radius: 10px; padding: 12px 16px; color: #9ca3af; font-size: 12.5px; line-height: 1.5;">
      <span style="color: #f59e0b; margin-right: 4px;">⏱</span> ${t.warning}
    </div>
  `;

  const html = buildMonolithEmailShell({
    uiLang,
    badge: 'VERIFICATION',
    title: t.welcome,
    subtitle: t.instruction,
    contentHtml
  });

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
  const subtitle = pickLang(uiLang, 'Şifrəni sıfırlamaq üçün aşağıdakı təhlükəsiz düyməyə klikləyin. Bu keçid 30 dəqiqə ərzində etibarlıdır.', 'Şifrenizi sıfırlamak için aşağıdaki güvenli butona tıklayın. Bu bağlantı 30 dakika geçerlidir.', 'Click the secure button below to reset your password. This link is valid for 30 minutes.');
  const button = pickLang(uiLang, 'Şifrəni Sıfırla', 'Şifreyi Sıfırla', 'Reset Password');
  const footerNote = pickLang(uiLang, 'Əgər bu istəyi siz etməmisinizsə, bu e-poçtu nəzərə almayın. Mövcud şifrəniz dəyişməz qalacaq.', 'Eğer bu isteği siz yapmadıysanız, bu e-postayı yok sayabilirsiniz. Mevcut şifreniz değişmeyecektir.', 'If you did not request this, you can safely ignore this email. Your password will remain unchanged.');

  const contentHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 8px 0 24px 0;">
      <tr>
        <td align="center">
          <a href="${escapeHtml(resetUrl)}" style="display: inline-block; background-color: #2563eb; color: #ffffff !important; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 14px; font-weight: 700; letter-spacing: 0.02em; box-shadow: 0 4px 16px rgba(37, 99, 235, 0.4);">
            ${escapeHtml(button)} →
          </a>
        </td>
      </tr>
    </table>
    <div style="background-color: #0d0d0d; border: 1px solid #262626; border-radius: 8px; padding: 12px 14px;">
      <div style="font-size: 10.5px; font-family: 'JetBrains Mono', monospace; font-weight: 700; text-transform: uppercase; color: #64748b; margin-bottom: 6px; letter-spacing: 0.06em;">DIRECT LINK:</div>
      <a href="${escapeHtml(resetUrl)}" style="font-size: 11.5px; font-family: 'JetBrains Mono', monospace; color: #60a5fa; word-break: break-all; text-decoration: none;">${escapeHtml(resetUrl)}</a>
    </div>
  `;

  const html = buildMonolithEmailShell({
    uiLang,
    badge: 'SECURITY · RESET',
    title,
    subtitle,
    contentHtml,
    footerNote
  });

  return sendMail({
    to,
    subject,
    text: `${subtitle}\n\n${resetUrl}\n\n${footerNote}`,
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

  const rowStyle = 'padding:10px 14px; border-bottom:1px solid #202020; font-size:12.5px;';
  const labelStyle = 'color:#9ca3af; font-family:\'JetBrains Mono\', monospace; font-size:11px; text-transform:uppercase; letter-spacing:0.04em;';
  const valStyle = 'color:#ffffff; font-weight:700; text-align:right; font-family:\'JetBrains Mono\', monospace; font-size:12px;';

  const rows = [
    `<tr><td style="${rowStyle} ${labelStyle}">${deviceTitle}</td><td style="${rowStyle} ${valStyle}">${escapeHtml(deviceLabel)}</td></tr>`,
    `<tr><td style="${rowStyle} ${labelStyle}">${countryTitle}</td><td style="${rowStyle} ${valStyle}">${escapeHtml(country)}</td></tr>`,
    `<tr><td style="${rowStyle} ${labelStyle}">${methodTitle}</td><td style="${rowStyle} ${valStyle}">${escapeHtml(methodLabel)}</td></tr>`,
    `<tr><td style="${rowStyle} ${labelStyle} border-bottom:none;">${timeLabel}</td><td style="${rowStyle} ${valStyle} border-bottom:none;">${escapeHtml(occurredAt)}</td></tr>`,
  ];

  const contentHtml = `
    <div style="background:#0d0d0d; border:1px solid #262626; border-radius:12px; overflow:hidden; margin-bottom:16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table>
    </div>

    <div style="padding:12px 14px; border-radius:8px; background:rgba(245, 158, 11, 0.08); border:1px solid rgba(245, 158, 11, 0.25); color:#fde68a; font-size:12px; line-height:1.55; margin-bottom:20px;">
      <div>${privacyNote}</div>
      <div style="margin-top:4px; opacity:0.9;">${locationNote}</div>
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td align="left">
          <a href="${escapeHtml(resetPasswordUrl)}" style="display:inline-block; padding:11px 20px; border-radius:8px; background:#ef4444; color:#ffffff !important; text-decoration:none; font-size:13px; font-weight:700; margin-right:10px;">${resetBtn}</a>
          <a href="${escapeHtml(contactUrl)}" style="display:inline-block; padding:11px 20px; border-radius:8px; border:1px solid #334155; color:#d1d5db !important; text-decoration:none; font-size:13px; font-weight:600; background:#181818;">${contactBtn}</a>
        </td>
      </tr>
    </table>
  `;

  const html = buildMonolithEmailShell({
    uiLang,
    badge: 'SECURITY ALERT',
    title,
    subtitle: intro,
    contentHtml
  });

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

function sendWorkspaceInviteEmail(to, workspaceName, inviteUrl, lang = 'az') {
  const uiLang = normalizeLang(lang, 'az');
  const safeWsName = escapeHtml(workspaceName || 'Workspace');
  const subject = pickLang(
    uiLang,
    `Ovlink: "${safeWsName}" workspace-nə dəvət edildiniz`,
    `Ovlink: "${safeWsName}" workspace'ine davet edildiniz`,
    `Ovlink: You've been invited to "${safeWsName}" workspace`
  );
  const title = pickLang(uiLang, 'Workspace Dəvəti', 'Workspace Daveti', 'Workspace Invitation');
  const subtitle = pickLang(
    uiLang,
    `Siz Ovlink platformasında "${safeWsName}" komanda workspace-nə qoşulmaq üçün dəvət aldınız.`,
    `Ovlink platformunda "${safeWsName}" takım workspace'ine katılmak için davet aldınız.`,
    `You have been invited to join the "${safeWsName}" team workspace on Ovlink.`
  );
  const acceptBtn = pickLang(uiLang, 'Dəvəti Qəbul Et', 'Daveti Kabul Et', 'Accept Invitation');

  const contentHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 8px 0 24px 0;">
      <tr>
        <td align="center">
          <a href="${escapeHtml(inviteUrl)}" style="display:inline-block; background-color:#2563eb; color:#ffffff !important; text-decoration:none; padding:14px 32px; border-radius:8px; font-size:14px; font-weight:700; letter-spacing:0.02em; box-shadow:0 4px 16px rgba(37,99,235,0.4);">
            ${escapeHtml(acceptBtn)} →
          </a>
        </td>
      </tr>
    </table>
    <div style="background-color:#0d0d0d; border:1px solid #262626; border-radius:8px; padding:12px 14px;">
      <div style="font-size:10.5px; font-family:'JetBrains Mono', monospace; font-weight:700; text-transform:uppercase; color:#64748b; margin-bottom:6px; letter-spacing:0.06em;">INVITATION LINK:</div>
      <a href="${escapeHtml(inviteUrl)}" style="font-size:11.5px; font-family:'JetBrains Mono', monospace; color:#60a5fa; word-break:break-all; text-decoration:none;">${escapeHtml(inviteUrl)}</a>
    </div>
  `;

  const html = buildMonolithEmailShell({
    uiLang,
    badge: 'WORKSPACE',
    title,
    subtitle,
    contentHtml
  });

  const text = `${subject}\n\n${inviteUrl}`;
  return sendMail({ to, subject, html, text });
}

function verifySpaceMailCredentials(user, pass) {
  return new Promise((resolve) => {
    try {
      const s = tls.connect(993, 'mail.spacemail.com', () => {});
      s.setEncoding('utf8');
      let step = 0;
      let resolved = false;

      const done = (val) => {
        if (!resolved) {
          resolved = true;
          try { s.destroy(); } catch {}
          resolve(val);
        }
      };

      s.on('data', (c) => {
        if (step === 0 && c.includes('* OK')) {
          step = 1;
          s.write(`A01 LOGIN "${user}" "${pass}"\r\n`);
        } else if (step === 1) {
          try { s.write('A02 LOGOUT\r\n'); } catch {}
          done(c.includes('A01 OK'));
        }
      });
      s.on('error', () => done(false));
      setTimeout(() => done(false), 5000);
    } catch {
      resolve(false);
    }
  });
}

async function verifyAndSaveB2BPassword(rawPassword, user = 'support@ovlink.sbs') {
  const cleanPass = (rawPassword || '').trim().replace(/^["']|["']$/g, '');
  if (!cleanPass) {
    return { valid: false, error: 'Şifrə boş ola bilməz.' };
  }

  const isValid = await verifySpaceMailCredentials(user, cleanPass);
  if (!isValid) {
    return { valid: false, error: 'SpaceMail IMAP girişi rədd edildi (yanlış şifrə).' };
  }

  // Update in-memory environment
  process.env.B2B_SMTP_USER = user;
  process.env.B2B_SMTP_PASS = cleanPass;
  process.env.B2B_FROM_EMAIL = `Ovlink Support <${user}>`;

  // Safely persist to .env file
  try {
    const envPath = path.resolve('.env');
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

    const updateOrAppend = (key, val) => {
      const reg = new RegExp(`^${key}=.*$`, 'm');
      if (reg.test(content)) {
        content = content.replace(reg, `${key}="${val}"`);
      } else {
        content = content.trimEnd() + `\n${key}="${val}"\n`;
      }
    };

    updateOrAppend('B2B_SMTP_USER', user);
    updateOrAppend('B2B_SMTP_PASS', cleanPass);
    updateOrAppend('B2B_FROM_EMAIL', `Ovlink Support <${user}>`);

    fs.writeFileSync(envPath, content, 'utf8');
  } catch (err) {
    console.warn('[email] Could not write to .env:', err.message);
  }

  return { valid: true, user };
}

async function getB2BStatus() {
  const user = process.env.B2B_SMTP_USER || 'support@ovlink.sbs';
  const pass = (process.env.B2B_SMTP_PASS || '').replace(/\s+/g, '');
  if (!pass) {
    return { user, hasPass: false, connected: false };
  }
  const connected = await verifySpaceMailCredentials(user, pass);
  return { user, hasPass: true, connected };
}

module.exports = {
  sendMail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendNewDeviceLoginEmail,
  sendNewDeviceLoginEmailForUser,
  sendWorkspaceInviteEmail,
  escapeHtml,
  appendSentMailToImap,
  verifySpaceMailCredentials,
  verifyAndSaveB2BPassword,
  getB2BStatus
};
