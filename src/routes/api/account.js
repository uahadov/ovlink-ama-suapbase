const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { body, validationResult } = require('express-validator');

const { db } = require('../../db/index');
const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../../db/helpers');
const { encryptAES256GCM, decryptAES256GCM, blindIndex } = require('../../../utils/crypto');
const { pickLang, normalizeLang, getCookieValue } = require('../../lib/i18n');
const { isProdRuntime } = require('../../config/index');
const {
  sendVerificationEmail,
  send2faEmail,
  sendResetPasswordEmail,
  sendNewDeviceLoginEmailForUser
} = require('../../lib/email');
const { getRequestGeoMeta, maskIpForDisplay, buildNetworkFingerprintForDisplay, parseAcceptLang } = require('../../lib/geo');
const { logSecurityEvent, getPublicBaseUrl } = require('../../lib/security');
const { googleOidc, initGoogleOidc, getGoogleRedirectUri } = require('../../lib/google-auth');
const { requireSignedIn } = require('../../middleware/auth');
const { authLimiter, sensitiveActionLimiter } = require('../../middleware/rate-limiter');
const { isProAccessActive, getEffectivePlanForUser, buildPlanPayload, isProExpired, downgradeExpiredProIfNeeded } = require('../../lib/plans');

function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeSessionToken(raw) {
  const token = (raw || '').toString().trim();
  if (!token) return '';
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return '';
  return token;
}

function buildBanMessage(uiLang, banUntil, banReason) {
  const lang = normalizeLang(uiLang, 'az');
  let msg = lang === 'tr'
    ? 'Bu hesap engellendi.'
    : (lang === 'en' ? 'This account is blocked.' : 'Bu hesab bloklanıb.');
  return msg;
}

function handleLogout(req, res) {
  const isApi = req.path.startsWith('/api/');
  if (req.session) {
    if (req.session.userId) {
      db.run('DELETE FROM express_sessions WHERE user_id = ? AND sid = ?', [req.session.userId, req.sessionID], () => {
        req.session.destroy(() => {
          res.clearCookie('connect.sid');
          return isApi ? res.json({ message: 'Çıkış yapıldı.' }) : res.redirect('/');
        });
      });
    } else {
      req.session.destroy(() => {
        res.clearCookie('connect.sid');
        return isApi ? res.json({ message: 'Çıkış yapıldı.' }) : res.redirect('/');
      });
    }
  } else {
    return isApi ? res.json({ message: 'Çıkış yapıldı.' }) : res.redirect('/');
  }
}

router.post('/api/register',
  authLimiter,
  [
    body('email')
      .isEmail().withMessage('Düzgün bir e-poçt ünvanı daxil edin.')
      .normalizeEmail()
      .trim()
      .escape(),
    body('password')
      .isLength({ min: 6 }).withMessage('Şifrə ən az 6 simvoldan ibarət olmalıdır.')
      .trim()
  ],
  (req, res) => {
    // Validation sonuçlarını kontrol et
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const uiLang = normalizeLang(req.body && req.body.lang, 'az');
      const err = errors.array()[0] || {};
      let msg = err.msg || 'Validation error.';
      if (err.param === 'email') {
        msg = pickLang(uiLang, 'Düzgün bir e-poçt ünvanı daxil edin.', 'Düzgün bir e-posta adresi girin.', 'Please enter a valid email address.');
      } else if (err.param === 'password') {
        msg = pickLang(uiLang, 'Şifrə ən az 6 simvoldan ibarət olmalıdır.', 'Şifre en az 6 karakter olmalıdır.', 'Password must be at least 6 characters.');
      }
      return res.status(400).json({ error: msg });
    }

    const { email, password, lang } = req.body;
    const uiLang = normalizeLang(lang, 'az');
    if (!email || !password)
      return res.status(400).json({ error: pickLang(uiLang, 'E-poçt və şifrə tələb olunur.', 'E-posta ve şifre gerekli.', 'Email and password are required.') });

    const emailDomain = email.split('@')[1].toLowerCase();
    if (tempEmailDomains.includes(emailDomain)) {
      return res.status(400).json({ error: pickLang(uiLang, 'Bu e-poçt ünvanı müvəqqəti (fake) görünür. Zəhmət olmasa real e-poçt ünvanı daxil edin.', 'Bu e-posta adresi geçici görünüyor. Lütfen gerçek bir e-posta adresi girin.', 'This email address appears to be temporary. Please enter a real email address.') });
    }

    const rawVerificationCode = generateVerificationCode();
    const verificationCode = encryptAES256GCM(rawVerificationCode);
    const verificationExpiresAt = buildVerificationExpiryIso(15);
    const initialLang = uiLang;
    const accountCreateFailedMsg = pickLang(uiLang, 'Hesab yaradıla bilmədi.', 'Hesap oluşturulamadı.', 'Account could not be created.');
    const emailInUseMsg = pickLang(uiLang, 'Bu e-poçt artıq istifadə edilib.', 'Bu e-posta zaten kullanılıyor.', 'This email is already in use.');

    // One account per email identity. The unique index on users(email_hash)
    // is the hard backstop; this check keeps the error friendly and avoids
    // creating a row that would shadow an existing account.
    db.get('SELECT id, email_verified FROM users WHERE email_hash = ?', [blindIndex(email)], (chkErr, existingUser) => {
      if (chkErr) {
        return res.status(500).json({ error: accountCreateFailedMsg });
      }
      if (existingUser && existingUser.email_verified == 1) {
        return res.status(400).json({ error: emailInUseMsg });
      }

      bcrypt.hash(password, 12, (hashErr, hashed) => {
        if (hashErr || !hashed) {
          return res.status(500).json({ error: accountCreateFailedMsg });
        }

        const proceedToSendEmail = (userId) => {
          sendVerificationEmail(email, rawVerificationCode, uiLang)
            .then(() => {
              req.session.tempEmail = email;
              res.json({ message: pickLang(uiLang, `${email} ünvanına təsdiqləmə kodu göndərildi. Zəhmət olmasa təsdiqləmə panelindən istifadə edin.`, `${email} adresine doğrulama kodu gönderildi. Lütfen doğrulama panelini kullanın.`, `A verification code has been sent to ${email}. Please complete verification.`) });
            })
            .catch((error) => {
              console.error("Mail gönderim hatası:", error);
              // Only delete if we just created the row (new user). If it's an existing unverified user, we don't delete them.
              if (!existingUser && userId) {
                db.run('DELETE FROM users WHERE id = ?', [userId], () => {});
              }
              res.status(500).json({ error: pickLang(uiLang, 'Təsdiqləmə e-poçtu göndərilə bilmədi. Zəhmət olmasa bir az sonra yenidən cəhd edin.', 'Doğrulama e-postası gönderilemedi. Lütfen daha sonra tekrar deneyin.', 'Verification email could not be sent. Please try again later.') });
            });
        };

        if (existingUser) {
          // Update existing unverified user
          db.run('UPDATE users SET password = ?, verification_code = ?, verification_expires_at = ?, ui_lang = ? WHERE id = ?', 
            [hashed, verificationCode, verificationExpiresAt, initialLang, existingUser.id], 
            function (updateErr) {
              if (updateErr) return res.status(500).json({ error: accountCreateFailedMsg });
              proceedToSendEmail(existingUser.id);
            }
          );
        } else {
          // Insert new user
          db.run('INSERT INTO users (email, email_hash, password, verification_code, verification_expires_at, auth_provider, created_at, ui_lang, ui_theme, notify_report, notify_limit, notify_disabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1)', 
            [encryptAES256GCM(email), blindIndex(email), hashed, verificationCode, verificationExpiresAt, 'local', new Date().toISOString(), initialLang, 'light'], 
            function (insertErr) {
              if (insertErr) return res.status(400).json({ error: emailInUseMsg });
              proceedToSendEmail(this.lastID);
            }
          );
        }
      });
    });
  });

// E-posta Doğrulama (POST /api/verify-email)
// Kullanıcı, doğrulama panelinde girilen kodu gönderir. Kod doğru ise kayıt tamamlanır.
router.post('/api/verify-email',
  authLimiter,
  [
    body('email').isEmail().withMessage('Düzgün bir e-poçt ünvanı daxil edin.').normalizeEmail().trim(),
    body('verificationCode').isLength({ min: 6, max: 6 }).isNumeric().withMessage('Təsdiqləmə kodu 6 rəqəm olmalıdır.').trim(),
  ],
  (req, res) => {
    const uiLang = normalizeLang(req.body && req.body.lang, 'az');
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const first = errors.array()[0] || {};
      if (first.param === 'email') {
        return res.status(400).json({ error: pickLang(uiLang, 'Düzgün bir e-poçt ünvanı daxil edin.', 'Düzgün bir e-posta adresi girin.', 'Please enter a valid email address.') });
      }
      return res.status(400).json({ error: pickLang(uiLang, 'Təsdiqləmə kodu 6 rəqəm olmalıdır.', 'Doğrulama kodu 6 haneli olmalıdır.', 'Verification code must be 6 digits.') });
    }

    const email = (req.body.email || '').toString().trim().toLowerCase();
    const verificationCode = (req.body.verificationCode || '').toString().trim();

    db.get('SELECT * FROM users WHERE email_hash = ? ORDER BY id DESC', [blindIndex(email)], (err, user) => {
      if (err || !user) return res.status(404).json({ error: pickLang(uiLang, 'İstifadəçi tapılmadı.', 'Kullanıcı bulunamadı.', 'User not found.') });

      const storedCode = decryptAES256GCM((user.verification_code || '').toString());
      const verificationExpiresMs = Date.parse((user.verification_expires_at || '').toString());
      if (!Number.isFinite(verificationExpiresMs) || verificationExpiresMs <= Date.now()) {
        return res.status(400).json({
          error: pickLang(
            uiLang,
            'Təsdiqləmə kodunun vaxtı bitib. Zəhmət olmasa yenidən qeydiyyatdan keçin.',
            'Doğrulama kodunun süresi doldu. Lütfen yeniden kayıt olun.',
            'Verification code has expired. Please register again.'
          )
        });
      }
      const validCode = storedCode.length === verificationCode.length && tsscmp(storedCode, verificationCode);
      if (!validCode) {
        return res.status(400).json({ error: pickLang(uiLang, 'Təsdiqləmə kodu yanlışdır.', 'Doğrulama kodu yanlış.', 'Verification code is incorrect.') });
      }

      db.run('UPDATE users SET email_verified = 1, verification_code = NULL, verification_expires_at = NULL WHERE id = ?', [user.id], (updateErr) => {
        if (updateErr) {
          return res.status(500).json({ error: pickLang(uiLang, 'Təsdiqləmə tamamlanmadı.', 'Doğrulama tamamlanamadı.', 'Verification could not be completed.') });
        }

        // Prevent session fixation in auto-login after verification.
        return req.session.regenerate((regenErr) => {
          if (regenErr) return res.status(500).json({ error: pickLang(uiLang, 'Oturum açıla bilmədi.', 'Oturum açılamadı.', 'Session could not be created.') });
          req.session.userId = user.id;
          req.session.username = decryptAES256GCM(user.email);
          return upsertUserSessionRecord(req, user.id, { loginMethod: 'verify_email' }, () => {
            return req.session.save((saveErr) => {
              if (saveErr) return res.status(500).json({ error: pickLang(uiLang, 'Oturum açıla bilmədi.', 'Oturum açılamadı.', 'Session could not be created.') });
              return res.json({ message: pickLang(uiLang, 'E-poçt təsdiqləndi. Giriş edilir...', 'E-posta doğrulaması başarılı. Giriş yapılıyor...', 'Email verified. Signing you in...'), redirect: '/' });
            });
          });
        });
      });
    });
  }
);

// Resend Verification Code (POST /api/resend-verification)
// Allows users to request a new verification code if they didn't receive the original one
router.post('/api/resend-verification',
  authLimiter,
  [
    body('email').isEmail().withMessage('Düzgün bir e-poçt ünvanı daxil edin.').normalizeEmail().trim(),
  ],
  (req, res) => {
    const uiLang = normalizeLang(req.body && req.body.lang, 'az');
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: pickLang(uiLang, 'Düzgün bir e-poçt ünvanı daxil edin.', 'Düzgün bir e-posta adresi girin.', 'Please enter a valid email address.') });
    }

    const email = (req.body.email || '').toString().trim().toLowerCase();

    db.get('SELECT * FROM users WHERE email_hash = ? ORDER BY id DESC', [blindIndex(email)], (err, user) => {
      if (err || !user) {
        return res.status(404).json({ error: pickLang(uiLang, 'İstifadəçi tapılmadı.', 'Kullanıcı bulunamadı.', 'User not found.') });
      }

      if (user.email_verified == 1) {
        return res.status(400).json({ error: pickLang(uiLang, 'Bu e-poçt artıq təsdiqlənib.', 'Bu e-posta zaten doğrulanmış.', 'This email is already verified.') });
      }

      // Generate new verification code
      const rawVerificationCode = generateVerificationCode();
      const verificationCode = encryptAES256GCM(rawVerificationCode);
      const verificationExpiresAt = buildVerificationExpiryIso(15);

      db.run('UPDATE users SET verification_code = ?, verification_expires_at = ? WHERE id = ?',
        [verificationCode, verificationExpiresAt, user.id], (updateErr) => {
        if (updateErr) {
          console.error('Failed to update verification code:', updateErr);
          return res.status(500).json({ error: pickLang(uiLang, 'Təsdiqləmə kodu yeniləmə xətası.', 'Doğrulama kodu güncellenemedi.', 'Failed to update verification code.') });
        }

        sendVerificationEmail(decryptAES256GCM(user.email), rawVerificationCode, uiLang)
          .then(() => {
            res.json({ message: pickLang(uiLang, 'Yeni təsdiqləmə kodu göndərildi.', 'Yeni doğrulama kodu gönderildi.', 'New verification code sent.') });
          })
          .catch((error) => {
            console.error("Resend verification email error:", error);
            console.error("Email resend error details:", {
              message: error.message || 'Unknown error',
              statusCode: error.statusCode || 'N/A',
              name: error.name || 'Error'
            });
            res.status(500).json({ error: pickLang(uiLang, 'Təsdiqləmə e-poçtu göndərilə bilmədi.', 'Doğrulama e-postası gönderilemedi.', 'Verification email could not be sent.') });
          });
      });
    });
  }
);

/* ----------------------
   GİRİŞ / ÇIKIŞ İŞLEMLERİ
------------------------- */

router.post('/api/login',
  authLimiter,
  [
    body('email')
      .isEmail().withMessage('Düzgün bir e-poçt ünvanı daxil edin.')
      .normalizeEmail()
      .trim()
      .escape(),
    body('password')
      .notEmpty().withMessage('Şifrə tələb olunur.')
      .trim()
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const uiLang = normalizeLang(req.body && req.body.lang, 'az');
      const err = errors.array()[0] || {};
      let msg = err.msg || 'Validation error.';
      if (err.param === 'email') {
        msg = pickLang(uiLang, 'Düzgün bir e-poçt ünvanı daxil edin.', 'Düzgün bir e-posta adresi girin.', 'Please enter a valid email address.');
      } else if (err.param === 'password') {
        msg = pickLang(uiLang, 'Şifrə tələb olunur.', 'Şifre gerekli.', 'Password is required.');
      }
      return res.status(400).json({ error: msg });
    }
    const uiLang = normalizeLang(req.body && req.body.lang, 'az');
    const { email, password } = req.body;
    db.get('SELECT * FROM users WHERE email_hash = ? ORDER BY id DESC', [blindIndex(email)], (err, user) => {
      const wrongMsg = pickLang(uiLang, 'E-poçt və ya şifrə yanlışdır.', 'E-posta veya şifre yanlış.', 'Email or password is incorrect.');
      const emailHint = (email || '').toString().trim().slice(0, 128);

      if (err || !user) {
        logSecurityEvent(req, 'auth.login', 'failure', { reason: 'user_not_found', email_hint: emailHint });
        return res.status(401).json({ error: wrongMsg });
      }
      if (!user.password) {
        logSecurityEvent(req, 'auth.login', 'blocked', { reason: 'google_only_account', user_id: user.id });
        return res.status(403).json({ error: pickLang(uiLang, 'Bu hesab Google ilə giriş üçündür.', 'Bu hesap Google ile giriş içindir.', 'This account uses Google sign-in.') });
      }
      return bcrypt.compare(password, user.password, (cmpErr, passwordOk) => {
        if (cmpErr || !passwordOk) {
          logSecurityEvent(req, 'auth.login', 'failure', { reason: 'invalid_password', user_id: user.id });
          return res.status(401).json({ error: wrongMsg });
        }
        if (user.email_verified != 1) {
          logSecurityEvent(req, 'auth.login', 'blocked', { reason: 'email_unverified', user_id: user.id });
          return res.status(403).json({
            error: pickLang(uiLang, 'E-poçt təsdiqlənməyib. Zəhmət olmasa e-poçt qutunuzu yoxlayın.', 'E-posta doğrulanmamış. Lütfen e-posta kutunuzu kontrol edin.', 'Email is not verified. Please check your inbox.')
          });
        }

        // Auto-clear expired temp bans
        if (user.banned == 1 && user.ban_until) {
          const untilMs = Date.parse(user.ban_until);
          if (!Number.isNaN(untilMs) && untilMs <= Date.now()) {
            db.run(
              'UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?',
              [user.id],
              () => {}
            );
            user.banned = 0;
          }
        }

        // If user is banned: block login (after successful password check)
        const banActive = (user.banned == 1) && (!user.ban_until || (Date.parse(user.ban_until) > Date.now()));
        if (banActive) {
          const msg = buildBanMessage(uiLang, user.ban_until, user.ban_reason);
          logSecurityEvent(req, 'auth.login', 'blocked', { reason: 'banned', user_id: user.id });
          return res.status(403).json({ error: msg });
        }

        return req.session.regenerate((regenErr) => {
          if (regenErr) {
            logSecurityEvent(req, 'auth.login', 'failure', { reason: 'session_regenerate_failed', user_id: user.id });
            return res.status(500).json({ error: pickLang(uiLang, 'Oturum açıla bilmədi.', 'Oturum açılamadı.', 'Session could not be created.') });
          }

          // Account-level TOTP: Keep session restricted to pending state ONLY (Do NOT set userId or full session yet)
          if (user.totp_enabled == 1 && user.totp_secret) {
            req.session.pending2faUserId = user.id;
            req.session.pending2faStartedAt = Date.now();
            req.session.pending2faUsername = email;
            return req.session.save((saveErr) => {
              if (saveErr) {
                logSecurityEvent(req, 'auth.login', 'failure', { reason: 'session_save_failed', user_id: user.id });
                return res.status(500).json({ error: pickLang(uiLang, 'Oturum açıla bilmədi.', 'Oturum açılamadı.', 'Session could not be created.') });
              }
              return res.json({ twofaRequired: true });
            });
          }

          // Password-only account: Establish full authenticated session
          req.session.userId = user.id;
          req.session.username = email; // email is plain text from req.body
          db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), user.id], () => {});
          return upsertUserSessionRecord(req, user.id, { loginMethod: 'password' }, () => {
            return req.session.save((saveErr) => {
              if (saveErr) {
                logSecurityEvent(req, 'auth.login', 'failure', { reason: 'session_save_failed', user_id: user.id });
                return res.status(500).json({ error: pickLang(uiLang, 'Oturum açıla bilmədi.', 'Oturum açılamadı.', 'Session could not be created.') });
              }
              logSecurityEvent(req, 'auth.login', 'success', { user_id: user.id });
              return res.json({ message: pickLang(uiLang, 'Giriş uğurludur', 'Giriş başarılı', 'Login successful'), username: email });
            });
          });
        });
      });
    });
  });


// Second factor for login (POST /api/verify-2fa)
router.post('/api/verify-2fa', authLimiter, (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const code = ((req.body && req.body.code) || '').toString().trim();
  const pendingId = req.session && req.session.pending2faUserId;
  const startedAt = req.session && req.session.pending2faStartedAt;

  if (!pendingId) {
    return res.status(401).json({ error: pickLang(uiLang, 'Əvvəlcə daxil olun.', 'Önce giriş yapın.', 'Please log in first.') });
  }
  if (!startedAt || Date.now() - startedAt > 10 * 60 * 1000) {
    delete req.session.pending2faUserId;
    delete req.session.pending2faStartedAt;
    delete req.session.pending2faUsername;
    return res.status(401).json({ error: pickLang(uiLang, 'Sessiya vaxtı bitib. Yenidən daxil olun.', 'Oturum süresi doldu. Yeniden giriş yapın.', 'Session expired. Please log in again.') });
  }
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: pickLang(uiLang, '6 rəqəmli kodu daxil edin.', '6 haneli kodu girin.', 'Enter the 6-digit code.') });
  }

  db.get('SELECT id, email, totp_secret FROM users WHERE id = ?', [pendingId], (err, user) => {
    if (err || !user || !user.totp_secret) {
      return res.status(401).json({ error: pickLang(uiLang, 'Kod yoxlanıla bilmədi.', 'Kod doğrulanamadı.', 'Code could not be verified.') });
    }
    const ok = speakeasy.totp.verify({
      secret: decryptAES256GCM(user.totp_secret),
      encoding: 'base32',
      token: code,
      window: 1
    });
    if (!ok) {
      logSecurityEvent(req, 'auth.2fa.verify', 'failure', { user_id: user.id });
      return res.status(401).json({ error: pickLang(uiLang, 'Kod yanlışdır.', 'Kod hatalı.', 'Invalid code.') });
    }

    const emailPlain = decryptAES256GCM(user.email);
    delete req.session.pending2faUserId;
    delete req.session.pending2faStartedAt;
    delete req.session.pending2faUsername;
    req.session.regenerate((regenErr) => {
      if (regenErr) {
        return res.status(500).json({ error: pickLang(uiLang, 'Oturum açıla bilmədi.', 'Oturum açılamadı.', 'Session could not be created.') });
      }
      req.session.userId = user.id;
      req.session.username = emailPlain;
      db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), user.id], () => {});
      return upsertUserSessionRecord(req, user.id, { loginMethod: '2fa_totp' }, () => {
        return req.session.save((saveErr) => {
          if (saveErr) {
            return res.status(500).json({ error: pickLang(uiLang, 'Oturum açıla bilmədi.', 'Oturum açılamadı.', 'Session could not be created.') });
          }
          logSecurityEvent(req, 'auth.2fa.verify', 'success', { user_id: user.id });
          return res.json({ message: pickLang(uiLang, 'Giriş uğurludur', 'Giriş başarılı', 'Login successful'), username: emailPlain });
        });
      });
    });
  });
});

// Google OAuth (OIDC) Login
router.get('/auth/google', authLimiter, async (req, res) => {  if (!googleOidc.ready || !googleOidc.client || !googleOidc.generators) {
    await initGoogleOidc({ req, force: true });
  }
  if (!googleOidc.ready || !googleOidc.client || !googleOidc.generators) {
    if (googleOidcInitError) {
      console.warn('[google-auth] unavailable', { reason: googleOidcInitError });
    }
    logSecurityEvent(req, 'auth.google.start', 'blocked', { reason: 'google_unavailable' });
    return res.redirect('/login?error=google_unavailable');
  }

  const redirectUri = getGoogleRedirectUri(req);
  if (!redirectUri) {
    logSecurityEvent(req, 'auth.google.start', 'blocked', { reason: 'missing_redirect_uri' });
    return res.redirect('/login?error=google_unavailable');
  }

  const { generators } = googleOidc;
  const state = generators.state();
  const nonce = generators.nonce();
  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);

  const oauthPayload = {
    state,
    nonce,
    codeVerifier,
    redirectUri,
    createdAt: Date.now()
  };
  req.session.oauth = oauthPayload;

  try {
    const encryptedState = encryptAES256GCM(JSON.stringify(oauthPayload));
    res.cookie('ovlink_oauth', encryptedState, {
      httpOnly: true,
      secure: isProdRuntime,
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000
    });
  } catch (cookieErr) {
    console.warn('[google-auth] failed to set backup oauth cookie', cookieErr && cookieErr.message);
  }

  const url = googleOidc.client.authorizationUrl({
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    redirect_uri: redirectUri
  });

  return req.session.save((saveErr) => {
    if (saveErr) {
      console.error('[google-auth] session save failed', saveErr);
      logSecurityEvent(req, 'auth.google.start', 'failure', { reason: 'session_save_failed' });
      return res.redirect('/login?error=google_failed&reason=verbose');
    }
    logSecurityEvent(req, 'auth.google.start', 'success', { reason: 'redirect_initiated' });
    return res.redirect(url);
  });
});

router.get('/auth/google/callback', authLimiter, async (req, res) => {
  if (!googleOidc.ready || !googleOidc.client) {
    await initGoogleOidc({ req, force: true });
  }
  if (!googleOidc.ready || !googleOidc.client) {
    logSecurityEvent(req, 'auth.google.callback', 'blocked', { reason: 'google_unavailable' });
    return res.redirect('/login?error=google_unavailable');
  }

  try {
    let oauth = req.session && req.session.oauth ? req.session.oauth : null;
    if (!oauth || !oauth.state) {
      const rawCookie = getCookieValue(req, 'ovlink_oauth');
      if (rawCookie) {
        try {
          const decrypted = decryptAES256GCM(rawCookie);
          oauth = JSON.parse(decrypted);
        } catch (err) {
          console.warn('[google-auth] failed to decrypt backup oauth cookie', err && err.message);
        }
      }
    }
    oauth = oauth || {};
    res.clearCookie('ovlink_oauth');

    const callbackState = Array.isArray(req.query.state) ? req.query.state[0] : req.query.state;
    const now = Date.now();

    if (!oauth.state || !callbackState || oauth.state !== callbackState) {
      if (req.session) req.session.oauth = null;
      console.warn('[google-auth] state mismatch', {
        hasSession: !!req.session,
        hasOAuth: !!(oauth && oauth.state),
        hasState: !!(oauth && oauth.state),
        hasCallbackState: !!callbackState,
      });
      logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'state_mismatch' });
      return res.redirect('/login?error=google_failed&reason=state_mismatch');
    }

    if (oauth.createdAt && (now - oauth.createdAt) > 10 * 60 * 1000) {
      req.session.oauth = null;
      logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'oauth_expired' });
      return res.redirect('/login?error=google_failed&reason=oauth_expired');
    }

    const callbackRedirectUri = (oauth.redirectUri || getGoogleRedirectUri(req) || googleOidc.redirectUri || '').toString();
    if (!callbackRedirectUri) {
      req.session.oauth = null;
      logSecurityEvent(req, 'auth.google.callback', 'blocked', { reason: 'missing_redirect_uri' });
      return res.redirect('/login?error=google_unavailable');
    }

    const params = googleOidc.client.callbackParams(req);
    const tokenSet = await googleOidc.client.callback(callbackRedirectUri, params, {
      state: oauth.state,
      nonce: oauth.nonce,
      code_verifier: oauth.codeVerifier
    });

    req.session.oauth = null;

    const claims = tokenSet.claims();
    if (!claims || !claims.email || !claims.email_verified) {
      logSecurityEvent(req, 'auth.google.callback', 'blocked', { reason: 'email_unverified' });
      return res.redirect('/login?error=google_unverified');
    }

    const email = (claims.email || '').toLowerCase();
    const googleId = claims.sub;
    const fallbackLang = normalizeLang(res.locals.defaultLang || 'az', 'az');

    db.get('SELECT * FROM users WHERE google_id_hash = ?', [blindIndex(googleId)], (err, user) => {
      if (err) {
        logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'db_lookup_failed' });
        return res.redirect('/login?error=google_failed&reason=db_lookup_failed');
      }
      if (user) {
        const uiLang = normalizeLang(user.ui_lang || fallbackLang, 'az');
        if (user.banned == 1 && user.ban_until) {
          const untilMs = Date.parse(user.ban_until);
          if (!Number.isNaN(untilMs) && untilMs <= Date.now()) {
            db.run(
              'UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?',
              [user.id],
              () => {}
            );
            user.banned = 0;
          }
        }
        const banActive = (user.banned == 1) && (!user.ban_until || (Date.parse(user.ban_until) > Date.now()));
        if (banActive) {
          const msg = buildBanMessage(uiLang, user.ban_until, user.ban_reason);
          logSecurityEvent(req, 'auth.google.callback', 'blocked', { reason: 'banned', user_id: user.id });
          return res.redirect('/login?error=ban&message=' + encodeURIComponent(msg));
        }
        return req.session.regenerate((regenErr) => {
          if (regenErr) {
            logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'session_regenerate_failed', user_id: user.id });
            return res.redirect('/login?error=google_failed&reason=session_regenerate_failed');
          }
          req.session.userId = user.id;
          req.session.username = decryptAES256GCM(user.email);
          db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), user.id], () => {});
          return upsertUserSessionRecord(req, user.id, { loginMethod: 'google' }, () => {
            return req.session.save((saveErr) => {
              if (saveErr) {
                logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'session_save_failed', user_id: user.id });
                return res.redirect('/login?error=google_failed&reason=session_save_failed');
              }
              logSecurityEvent(req, 'auth.google.callback', 'success', { reason: 'existing_google_user', user_id: user.id });
              return res.redirect('/');
            });
          });
        });
      }

      db.get('SELECT * FROM users WHERE email_hash = ? ORDER BY id DESC', [blindIndex(email)], (err2, existing) => {
        if (err2) {
          logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'email_lookup_failed' });
          return res.redirect('/login?error=google_failed&reason=email_lookup_failed');
        }

        if (existing) {
          const uiLang = normalizeLang(existing.ui_lang || fallbackLang, 'az');
          if (existing.banned == 1 && existing.ban_until) {
            const untilMs = Date.parse(existing.ban_until);
            if (!Number.isNaN(untilMs) && untilMs <= Date.now()) {
              db.run(
                'UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?',
                [existing.id],
                () => {}
              );
              existing.banned = 0;
            }
          }
          const banActive = (existing.banned == 1) && (!existing.ban_until || (Date.parse(existing.ban_until) > Date.now()));
          if (banActive) {
            const msg = buildBanMessage(uiLang, existing.ban_until, existing.ban_reason);
            logSecurityEvent(req, 'auth.google.callback', 'blocked', { reason: 'banned', user_id: existing.id });
            return res.redirect('/login?error=ban&message=' + encodeURIComponent(msg));
          }

          if (!existing.email_verified) {
            logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'google_attach_unverified_email', user_id: existing.id });
            return res.redirect('/login?error=google_failed&msg=' + encodeURIComponent('Mövcud hesab e-poçtu təsdiqlənməyib. / Mevcut hesap e-postası doğrulanmamış.'));
          }

          return db.run(
            'UPDATE users SET google_id = ?, google_id_hash = ?, email_verified = 1 WHERE id = ?',
            [encryptAES256GCM(googleId), blindIndex(googleId), existing.id],
            (updateErr) => {
              if (updateErr) {
                logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'google_attach_failed', user_id: existing.id });
                return res.redirect('/login?error=google_failed&reason=google_attach_failed');
              }
              req.session.regenerate((regenErr) => {
                if (regenErr) {
                  logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'session_regenerate_failed', user_id: existing.id });
                  return res.redirect('/login?error=google_failed&reason=session_regenerate_failed');
                }
                req.session.userId = existing.id;
                req.session.username = decryptAES256GCM(existing.email);
                db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), existing.id], () => {});
                return upsertUserSessionRecord(req, existing.id, { loginMethod: 'google' }, () => {
                  return req.session.save((saveErr) => {
                    if (saveErr) {
                      logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'session_save_failed', user_id: existing.id });
                      return res.redirect('/login?error=google_failed&reason=session_save_failed');
                    }
                    logSecurityEvent(req, 'auth.google.callback', 'success', { reason: 'existing_email_linked', user_id: existing.id });
                    return res.redirect('/');
                  });
                });
              });
            }
          );
        }

        const createdAt = new Date().toISOString();
        const initialLang = fallbackLang;
        db.run(
          'INSERT INTO users (email, email_hash, password, email_verified, google_id, google_id_hash, auth_provider, created_at, ui_lang, ui_theme, notify_report, notify_limit, notify_disabled) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, 1, 1)',
          [encryptAES256GCM(email), blindIndex(email), null, encryptAES256GCM(googleId), blindIndex(googleId), 'google', createdAt, initialLang, 'light'],
          function (err3) {
            if (err3) {
              logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'user_create_failed' });
              return res.redirect('/login?error=google_failed&reason=user_create_failed');
            }
            const newUserId = this.lastID;
            req.session.regenerate((regenErr) => {
              if (regenErr) {
                logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'session_regenerate_failed', user_id: newUserId });
                return res.redirect('/login?error=google_failed&reason=session_regenerate_failed');
              }
              req.session.userId = newUserId;
              req.session.username = email; // email is plain text from req.body
              db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), newUserId], () => {});
              return upsertUserSessionRecord(req, newUserId, { loginMethod: 'google' }, () => {
                return req.session.save((saveErr) => {
                  if (saveErr) {
                    logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'session_save_failed', user_id: newUserId });
                    return res.redirect('/login?error=google_failed&reason=session_save_failed');
                  }
                  logSecurityEvent(req, 'auth.google.callback', 'success', { reason: 'new_google_user', user_id: newUserId });
                  return res.redirect('/');
                });
              });
            });
          }
        );
      });
    });
  } catch (err) {
    console.error('[google-auth] callback failed', err);
    logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'callback_exception' });
    return res.redirect('/login?error=google_failed&reason=callback_exception');
  }
});

function handleLogout(req, res) {
  const sessionToken = normalizeSessionToken(req.session && req.session.userSessionToken);
  const userId = req.session && req.session.userId;
  const revokeNow = new Date().toISOString();

  if (userId && sessionToken) {
    db.run(
      'UPDATE user_sessions SET is_revoked = 1, revoked_at = ? WHERE user_id = ? AND session_token = ?',
      [revokeNow, userId, sessionToken],
      () => {}
    );
  }

  try {
    res.clearCookie('connect.sid');
  } catch {}

  // Best-effort session destroy.
  if (req.session) {
    try {
      req.session.destroy(() => {});
    } catch {}
  }

  // If the browser navigates here directly (GET), always go back home.
  if (req.method === 'GET') return res.redirect('/');

  const accept = (req.get('accept') || '').toLowerCase();
  const isNavigate = (req.get('sec-fetch-mode') || '').toLowerCase() === 'navigate';
  const wantsHtml = isNavigate || (accept.includes('text/html') && !accept.includes('application/json'));
  if (wantsHtml) return res.redirect('/');
  return res.json({ message: pickLang(req.defaultLang || 'az', 'Çıxış edildi.', 'Çıkış yapıldı.', 'Logged out.') });
}

router.post('/api/logout', handleLogout);


// Oturum Bilgisi (GET /api/me)
// Returns 200 with { user: null } for unauthenticated visitors
// so browser devtools are not polluted with 401 noise.
router.get('/api/me', (req, res) => {
  if (!req.session.userId) {
    return res.json({ user: null });
  }

  db.get(
    'SELECT ui_lang, ui_theme, notify_report, notify_limit, notify_disabled, auth_provider, google_id, password, plan_tier, plan_status, pro_expires_at, pro_paused_at, totp_enabled FROM users WHERE id = ?',
    [req.session.userId],
    async (err, row) => {
      if (err || !row) {
        return res.status(500).json({ user: null });
      }

      let plan = buildPlanPayload(row);
      if (isProExpired(row)) {
        try {
          const refreshed = await downgradeExpiredProIfNeeded(req.session.userId);
          plan = buildPlanPayload(refreshed || row);
        } catch {
          // keep current row-derived plan if downgrade fails
        }
      }

      const settings = row ? {
        ui_lang: row.ui_lang || 'az',
        ui_theme: row.ui_theme || 'light',
        notify_report: row.notify_report == 1,
        notify_limit: row.notify_limit == 1,
        notify_disabled: row.notify_disabled == 1,
      } : null;

      return res.json({
        user: {
          id: req.session.userId,
          email: req.session.username,
          isAdmin: !!req.session.adminUserId,
          auth_provider: row && row.auth_provider ? row.auth_provider : 'local',
          has_password: !!(row && row.password),
          has_google: !!(row && row.google_id),
          twofaEnabled: !!(row && row.totp_enabled == 1),
          planTier: plan.tier,
          planStatus: plan.status,
          proExpiresAt: plan.expires_at,
          proPausedAt: plan.paused_at,
          proActive: plan.is_active,
          proFeatures: plan.features,
          settings,
        }
      });
    }
  );
});

router.get('/api/user/sessions', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ sessions: [] });
  }

  upsertUserSessionRecord(req, req.session.userId, { loginMethod: 'session_restore', sendAlert: false }, () => {
    const currentToken = normalizeSessionToken(req.session.userSessionToken);
    db.all(
      `SELECT id, session_token, device_label, browser, os, country, created_at, last_seen_at, last_login_at, last_login_method
       FROM user_sessions
       WHERE user_id = ? AND is_revoked = 0
       ORDER BY last_seen_at DESC
       LIMIT 20`,
      [req.session.userId],
      (err, rows) => {
        if (err) {
          console.error('user sessions load failed:', err.message || err);
          return res.json({ sessions: [] });
        }
        const sessions = (rows || []).map((row) => ({
          id: row.id,
          device_label: row.device_label || 'Unknown device',
          browser: row.browser || 'Unknown',
          os: row.os || 'Unknown',
          country: row.country || 'Unknown',
          created_at: row.created_at || null,
          last_seen_at: row.last_seen_at || null,
          last_login_at: row.last_login_at || null,
          last_login_method: row.last_login_method || 'password',
          is_current: !!currentToken && row.session_token === currentToken,
        }));
        return res.json({ sessions });
      }
    );
  });
});

router.post('/api/user/sessions/revoke', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const sessionId = Number.parseInt((req.body && req.body.session_id) || '', 10);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış sessiya ID.', 'Geçersiz oturum ID.', 'Invalid session id.') });
  }

  const currentToken = normalizeSessionToken(req.session.userSessionToken);

  db.get(
    'SELECT id, session_token FROM user_sessions WHERE id = ? AND user_id = ? AND is_revoked = 0',
    [sessionId, req.session.userId],
    (err, row) => {
      if (err || !row) {
        return res.status(404).json({ error: pickLang(uiLang, 'Sessiya tapılmadı.', 'Oturum bulunamadı.', 'Session not found.') });
      }

      const nowIso = new Date().toISOString();
      db.run(
        'UPDATE user_sessions SET is_revoked = 1, revoked_at = ? WHERE id = ? AND user_id = ?',
        [nowIso, sessionId, req.session.userId],
        function (updateErr) {
          if (updateErr) {
            return res.status(500).json({ error: pickLang(uiLang, 'Sessiya bağlana bilmədi.', 'Oturum kapatılamadı.', 'Session could not be revoked.') });
          }

          if (currentToken && row.session_token === currentToken) {
            try {
              req.session.destroy(() => {});
            } catch {}
            return res.json({ revoked: this.changes || 0, logged_out: true });
          }

          return res.json({ revoked: this.changes || 0, logged_out: false });
        }
      );
    }
  );
});

router.post('/api/user/sessions/revoke-others', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const currentToken = normalizeSessionToken(req.session.userSessionToken);
  const nowIso = new Date().toISOString();

  db.run(
    'UPDATE user_sessions SET is_revoked = 1, revoked_at = ? WHERE user_id = ? AND is_revoked = 0 AND session_token <> ?',
    [nowIso, req.session.userId, currentToken || ''],
    function (err) {
      if (err) {
        return res.status(500).json({ error: 'Server error.' });
      }
      return res.json({ revoked: this.changes || 0 });
    }
  );
});

router.post('/api/user/theme', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Giriş gerekli.' });
  }

  const theme = (req.body && req.body.theme === 'dark') ? 'dark' : 'light';

  db.run(
    'UPDATE users SET ui_theme = ? WHERE id = ?',
    [theme, req.session.userId],
    function (err) {
      if (err) return res.status(500).json({ error: 'Ayarlar kaydedilemedi.' });
      return res.json({ message: 'Tema kaydedildi.' });
    }
  );
});

// Kullanıcı ayarları (POST /api/user/settings)
router.post('/api/user/settings', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Giriş gerekli.' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const theme = (req.body && req.body.theme === 'dark') ? 'dark' : 'light';
  const toFlag = (v) => v === true || v === 'true' || v === '1' || v === 1 || v === 'on';
  const notifyReport = toFlag(req.body && req.body.notify_report) ? 1 : 0;
  const notifyLimit = toFlag(req.body && req.body.notify_limit) ? 1 : 0;
  const notifyDisabled = toFlag(req.body && req.body.notify_disabled) ? 1 : 0;

  db.run(
    'UPDATE users SET ui_lang = ?, ui_theme = ?, notify_report = ?, notify_limit = ?, notify_disabled = ? WHERE id = ?',
    [uiLang, theme, notifyReport, notifyLimit, notifyDisabled, req.session.userId],
    function (err) {
      if (err) return res.status(500).json({ error: pickLang(uiLang, 'Ayarlar yadda saxlanıla bilmədi.', 'Ayarlar kaydedilemedi.', 'Settings could not be saved.') });
      return res.json({ message: pickLang(uiLang, 'Ayarlar yadda saxlanıldı.', 'Ayarlar kaydedildi.', 'Settings saved.') });
    }
  );
});

// Şifre değiştirme (POST /api/user/password)
// ---- Account TOTP 2FA (user-level) ----
router.post('/api/user/2fa/setup', requireSignedIn, sensitiveActionLimiter, (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  db.get('SELECT totp_enabled FROM users WHERE id = ?', [req.session.userId], (err, row) => {
    if (err || !row) return res.status(500).json({ error: 'Server error.' });
    if (row.totp_enabled == 1) {
      return res.status(400).json({ error: pickLang(uiLang, '2FA onsuz da aktivdir.', '2FA zaten etkin.', '2FA is already enabled.') });
    }
    const secret = speakeasy.generateSecret({ length: 20 });
    db.run('UPDATE users SET totp_pending_secret = ? WHERE id = ?', [encryptAES256GCM(secret.base32), req.session.userId], (uErr) => {
      if (uErr) return res.status(500).json({ error: 'Server error.' });
      const otpauthUrl = speakeasy.otpauthURL({ secret: secret.base32, encoding: 'base32', label: encodeURIComponent('Ovlink'), issuer: 'Ovlink' });
      QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 }, (qrErr, dataUrl) => {
        return res.json({ otpauthUrl, qr: qrErr ? null : dataUrl });
      });
    });
  });
});

router.post('/api/user/2fa/enable', requireSignedIn, sensitiveActionLimiter, (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const code = ((req.body && req.body.code) || '').toString().trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: pickLang(uiLang, '6 rəqəmli kodu daxil edin.', '6 haneli kodu girin.', 'Enter the 6-digit code.') });
  }
  db.get('SELECT totp_pending_secret FROM users WHERE id = ?', [req.session.userId], (err, row) => {
    if (err || !row || !row.totp_pending_secret) {
      return res.status(400).json({ error: pickLang(uiLang, 'Əvvəlcə quraşdırmanı başladın.', 'Önce kurulumu başlatın.', 'Start the setup first.') });
    }
    const ok = speakeasy.totp.verify({ secret: decryptAES256GCM(row.totp_pending_secret), encoding: 'base32', token: code, window: 1 });
    if (!ok) {
      return res.status(400).json({ error: pickLang(uiLang, 'Kod yanlışdır.', 'Kod hatalı.', 'Invalid code.') });
    }
    db.run('UPDATE users SET totp_enabled = 1, totp_secret = totp_pending_secret, totp_pending_secret = NULL WHERE id = ?', [req.session.userId], (uErr) => {
      if (uErr) return res.status(500).json({ error: 'Server error.' });
      logSecurityEvent(req, 'auth.2fa.enabled', 'success', { user_id: req.session.userId });
      return res.json({ message: pickLang(uiLang, 'İki faktorlu autentifikasiya aktivləşdirildi.', 'İki faktörlü doğrulama etkinleştirildi.', 'Two-factor authentication enabled.') });
    });
  });
});

router.post('/api/user/2fa/disable', requireSignedIn, sensitiveActionLimiter, (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const password = ((req.body && req.body.password) || '').toString();
  const code = ((req.body && req.body.code) || '').toString().trim();
  db.get('SELECT password, totp_secret, totp_enabled, auth_provider FROM users WHERE id = ?', [req.session.userId], (err, row) => {
    if (err || !row || row.totp_enabled != 1 || !row.totp_secret) {
      return res.status(400).json({ error: pickLang(uiLang, '2FA aktiv deyil.', '2FA etkin değil.', '2FA is not enabled.') });
    }

    const isPasswordless = ['google', 'sso'].includes(row.auth_provider) || !row.password;

    const finalizeDisable = () => {
      const ok = speakeasy.totp.verify({ secret: decryptAES256GCM(row.totp_secret), encoding: 'base32', token: code, window: 1 });
      if (!ok) {
        return res.status(400).json({ error: pickLang(uiLang, 'Kod yanlışdır.', 'Kod hatalı.', 'Invalid code.') });
      }
      db.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_pending_secret = NULL WHERE id = ?', [req.session.userId], (uErr) => {
        if (uErr) return res.status(500).json({ error: 'Server error.' });
        logSecurityEvent(req, 'auth.2fa.disabled', 'success', { user_id: req.session.userId });
        return res.json({ message: pickLang(uiLang, 'İki faktorlu autentifikasiya söndürüldü.', 'İki faktörlü doğrulama devre dışı bırakıldı.', 'Two-factor authentication disabled.') });
      });
    };

    if (isPasswordless) {
      return finalizeDisable();
    }

    bcrypt.compare(password, row.password || '', (cmpErr, passwordOk) => {
      if (cmpErr || !passwordOk) {
        return res.status(401).json({ error: pickLang(uiLang, 'Şifrə yanlışdır.', 'Şifre hatalı.', 'Invalid password.') });
      }
      return finalizeDisable();
    });
  });
});

// ---- Email change (verified, two-step) ----
router.post('/api/user/email/change',
  authLimiter,
  [
    body('new_email').isEmail().withMessage('Düzgün e-poçt ünvanı daxil edin.').normalizeEmail().trim(),
  ],
  (req, res) => {
    const uiLang = normalizeLang(req.body && req.body.lang, 'az');
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: pickLang(uiLang, 'Düzgün e-poçt ünvanı daxil edin.', 'Geçerli bir e-posta adresi girin.', 'Please enter a valid email address.') });
    }
    if (!req.session.userId) return res.status(401).json({ error: 'Giriş gerekli.' });

    const newEmail = (req.body.new_email || '').toString().trim().toLowerCase();
    const password = ((req.body && req.body.current_password) || '').toString();

    const emailDomain = newEmail.split('@')[1].toLowerCase();
    if (tempEmailDomains.includes(emailDomain)) {
      return res.status(400).json({ error: pickLang(uiLang, 'Bu e-poçt ünvanı müvəqqəti (fake) görünür.', 'Bu e-posta adresi geçici görünüyor.', 'This email address appears to be temporary.') });
    }

    db.get('SELECT id, email, password FROM users WHERE id = ?', [req.session.userId], (err, row) => {
      if (err || !row) return res.status(500).json({ error: 'Server error.' });
      const currentEmail = decryptAES256GCM(row.email).trim().toLowerCase();
      if (newEmail === currentEmail) {
        return res.status(400).json({ error: pickLang(uiLang, 'Yeni e-poçt cari e-poçtla eynidir.', 'Yeni e-posta mevcut e-postayla aynı.', 'The new email is the same as the current one.') });
      }
      bcrypt.compare(password, row.password || '', (cmpErr, passwordOk) => {
        if (cmpErr || !passwordOk) {
          return res.status(401).json({ error: pickLang(uiLang, 'Şifrə yanlışdır.', 'Şifre hatalı.', 'Invalid password.') });
        }
        db.get('SELECT id FROM users WHERE email_hash = ?', [blindIndex(newEmail)], (chkErr, existing) => {
          if (chkErr) return res.status(500).json({ error: 'Server error.' });
          if (existing) {
            return res.status(400).json({ error: pickLang(uiLang, 'Bu e-poçt artıq istifadə edilib.', 'Bu e-posta zaten kullanılıyor.', 'This email is already in use.') });
          }
          const rawCode = generateVerificationCode();
          const expiresAt = buildVerificationExpiryIso(15);
          db.run(
            'UPDATE users SET pending_email = ?, pending_email_code = ?, pending_email_expires_at = ? WHERE id = ?',
            [encryptAES256GCM(newEmail), encryptAES256GCM(rawCode), expiresAt, req.session.userId],
            (uErr) => {
              if (uErr) return res.status(500).json({ error: 'Server error.' });
              sendVerificationEmail(newEmail, rawCode, uiLang)
                .then(() => res.json({ message: pickLang(uiLang, `Təsdiq kodu ${newEmail} ünvanına göndərildi.`, `Doğrulama kodu ${newEmail} adresine gönderildi.`, `A confirmation code has been sent to ${newEmail}.`) }))
                .catch(() => res.status(500).json({ error: pickLang(uiLang, 'E-poçt göndərilə bilmədi.', 'E-posta gönderilemedi.', 'The email could not be sent.') }));
            }
          );
        });
      });
    });
  }
);

router.post('/api/user/email/confirm', authLimiter, (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  if (!req.session.userId) return res.status(401).json({ error: 'Giriş gerekli.' });
  const code = ((req.body && req.body.code) || '').toString().trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: pickLang(uiLang, '6 rəqəmli kodu daxil edin.', '6 haneli kodu girin.', 'Enter the 6-digit code.') });
  }

  db.get('SELECT pending_email, pending_email_code, pending_email_expires_at FROM users WHERE id = ?', [req.session.userId], (err, row) => {
    if (err || !row || !row.pending_email || !row.pending_email_code) {
      return res.status(400).json({ error: pickLang(uiLang, 'E-poçt dəyişikliyi tapılmadı.', 'E-posta değişikliği bulunamadı.', 'No pending email change found.') });
    }
    const expiresMs = Date.parse(row.pending_email_expires_at || '');
    if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
      db.run('UPDATE users SET pending_email = NULL, pending_email_code = NULL, pending_email_expires_at = NULL WHERE id = ?', [req.session.userId], () => {});
      return res.status(400).json({ error: pickLang(uiLang, 'Kodun vaxtı bitib.', 'Kodun süresi doldu.', 'The code has expired.') });
    }
    const storedCode = decryptAES256GCM(row.pending_email_code);
    if (storedCode.length !== code.length || !tsscmp(storedCode, code)) {
      return res.status(400).json({ error: pickLang(uiLang, 'Kod yanlışdır.', 'Kod hatalı.', 'Invalid code.') });
    }

    const newEmailPlain = decryptAES256GCM(row.pending_email).trim().toLowerCase();
    db.run(
      'UPDATE users SET email = ?, email_hash = ?, pending_email = NULL, pending_email_code = NULL, pending_email_expires_at = NULL WHERE id = ?',
      [encryptAES256GCM(newEmailPlain), blindIndex(newEmailPlain), req.session.userId],
      (uErr) => {
        if (uErr) {
          return res.status(400).json({ error: pickLang(uiLang, 'Bu e-poçt artıq istifadə edilib.', 'Bu e-posta zaten kullanılıyor.', 'This email is already in use.') });
        }
        req.session.username = newEmailPlain;
        logSecurityEvent(req, 'auth.email.changed', 'success', { user_id: req.session.userId });
        return res.json({ message: pickLang(uiLang, 'E-poçt ünvanınız yeniləndi.', 'E-posta adresiniz güncellendi.', 'Your email address has been updated.'), email: newEmailPlain });
      }
    );
  });
});

router.post('/api/user/password',
  requireSignedIn,
  authLimiter,
  (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const currentPassword = (req.body && req.body.current_password) ? req.body.current_password.toString() : '';
  const newPassword = (req.body && req.body.new_password) ? req.body.new_password.toString() : '';
  const confirmPassword = (req.body && req.body.new_password_confirm) ? req.body.new_password_confirm.toString() : '';

  if (!newPassword || !confirmPassword) {
    return res.status(400).json({ error: pickLang(uiLang, 'Zəhmət olmasa bütün sahələri doldurun.', 'Lütfen tüm alanları doldurun.', 'Please fill in all fields.') });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yeni şifrə ən az 6 simvol olmalıdır.', 'Yeni şifre en az 6 karakter olmalıdır.', 'New password must be at least 6 characters.') });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: pickLang(uiLang, 'Şifrələr uyğun gəlmir.', 'Şifreler eşleşmiyor.', 'Passwords do not match.') });
  }

  db.get('SELECT password, auth_provider FROM users WHERE id = ?', [req.session.userId], (err, row) => {
    if (err || !row) {
      return res.status(500).json({ error: pickLang(uiLang, 'Əməliyyat uğursuz oldu.', 'İşlem başarısız.', 'Operation failed.') });
    }

    const hasPassword = !!row.password;
    const currentToken = normalizeSessionToken(req.session.userSessionToken);
    const nowIso = new Date().toISOString();

    const continueWithHash = () => {
      bcrypt.hash(newPassword, 12, (hashErr, hashed) => {
        if (hashErr || !hashed) {
          return res.status(500).json({ error: pickLang(uiLang, 'Şifrə dəyişdirilə bilmədi.', 'Şifre değiştirilemedi.', 'Password could not be changed.') });
        }
        db.run('UPDATE users SET password = ? WHERE id = ?', [hashed, req.session.userId], (uErr) => {
          if (uErr) return res.status(500).json({ error: pickLang(uiLang, 'Şifrə dəyişdirilə bilmədi.', 'Şifre değiştirilemedi.', 'Password could not be changed.') });

          // Revoke all OTHER active sessions
          db.run(
            'UPDATE user_sessions SET is_revoked = 1, revoked_at = ? WHERE user_id = ? AND is_revoked = 0 AND session_token <> ?',
            [nowIso, req.session.userId, currentToken || ''],
            () => {}
          );

          logSecurityEvent(req, 'auth.password_change', 'success', { user_id: req.session.userId });
          return res.json({ message: pickLang(uiLang, 'Şifrə yeniləndi.', 'Şifre güncellendi.', 'Password updated.') });
        });
      });
    };

    if (hasPassword) {
      if (!currentPassword) {
        return res.status(400).json({ error: pickLang(uiLang, 'Cari şifrə tələb olunur.', 'Mevcut şifre gerekli.', 'Current password is required.') });
      }
      return bcrypt.compare(currentPassword, row.password || '', (cmpErr, ok) => {
        if (cmpErr || !ok) {
          return res.status(400).json({ error: pickLang(uiLang, 'Cari şifrə yalnışdır.', 'Mevcut şifre yanlış.', 'Current password is incorrect.') });
        }
        return continueWithHash();
      });
    }
    return continueWithHash();
  });
});

// Sifre sifirlama istegi (POST /api/forgot-password)
router.post('/api/forgot-password',
  authLimiter,
  [
    body('email').isEmail().withMessage('Düzgün bir e-poçt ünvanı daxil edin.').normalizeEmail().trim(),
  ],
  (req, res) => {
    const uiLang = normalizeLang(req.body && req.body.lang, 'az');
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: pickLang(uiLang, 'Düzgün bir e-poçt ünvanı daxil edin.', 'Düzgün bir e-posta adresi girin.', 'Please enter a valid email address.') });
    }

    const email = (req.body && req.body.email ? req.body.email.toString().trim().toLowerCase() : '');

    db.get('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)], (err, user) => {
      const successMsg = pickLang(uiLang, 'E-poçt mövcuddursa sıfırlama linki göndərildi.', 'E-posta mevcutsa sıfırlama bağlantısı gönderildi.', 'If the email exists, a reset link has been sent.');

      if (err || !user) {
        return res.json({ message: successMsg });
      }

      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const createdAt = new Date().toISOString();

      db.run(
        'INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)',
        [user.id, tokenHash, expiresAt, createdAt],
        (insErr) => {
          if (insErr) return res.json({ message: successMsg });

          const resetUrl = buildAbsoluteUrl(req, `/reset-password?token=${encodeURIComponent(token)}`);
          sendPasswordResetEmail(email, resetUrl, uiLang)
            .then(() => res.json({ message: successMsg }))
            .catch(() => res.json({ message: successMsg }));
        }
      );
    });
  }
);

// Sifre sifirlama (POST /api/reset-password)
router.post('/api/reset-password',
  authLimiter,
  [
    body('token').isLength({ min: 64, max: 64 }).isHexadecimal().withMessage('Yanlış link.'),
    body('new_password').isLength({ min: 6, max: 128 }).withMessage('Şifrə ən az 6 simvol olmalıdır.'),
    body('new_password_confirm').isLength({ min: 6, max: 128 }).withMessage('Şifrə təsdiqi tələb olunur.'),
  ],
  (req, res) => {
    const uiLang = normalizeLang(req.body && req.body.lang, 'az');
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const first = errors.array()[0] || {};
      if (first.param === 'token') {
        return res.status(400).json({ error: pickLang(uiLang, 'Yanlış link.', 'Geçersiz bağlantı.', 'Invalid link.') });
      }
      if (first.param === 'new_password') {
        return res.status(400).json({ error: pickLang(uiLang, 'Şifrə ən az 6 simvol olmalıdır.', 'Şifre en az 6 karakter olmalıdır.', 'Password must be at least 6 characters.') });
      }
      return res.status(400).json({ error: pickLang(uiLang, 'Zəhmət olmasa bütün sahələri doldurun.', 'Lütfen tüm alanları doldurun.', 'Please fill in all fields.') });
    }

    const token = (req.body && req.body.token ? req.body.token.toString() : '');
    const newPassword = (req.body && req.body.new_password ? req.body.new_password.toString() : '');
    const confirmPassword = (req.body && req.body.new_password_confirm ? req.body.new_password_confirm.toString() : '');

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: pickLang(uiLang, 'Şifrələr uyğun gəlmir.', 'Şifreler eşleşmiyor.', 'Passwords do not match.') });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const nowIso = new Date().toISOString();
    db.get(
      'SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ? ORDER BY id DESC LIMIT 1',
      [tokenHash],
      (err, row) => {
        if (err || !row) {
          return res.status(400).json({ error: pickLang(uiLang, 'Link etibarsızdır.', 'Bağlantı geçersiz.', 'Invalid link.') });
        }
        if (row.used_at) {
          return res.status(400).json({ error: pickLang(uiLang, 'Link artıq istifadə edilib.', 'Bağlantı zaten kullanıldı.', 'Link has already been used.') });
        }
        if (Date.parse(row.expires_at) <= Date.now()) {
          return res.status(400).json({ error: pickLang(uiLang, 'Linkin vaxtı bitib.', 'Bağlantının süresi doldu.', 'Link has expired.') });
        }

        // Atomically claim the token to prevent race condition
        db.run(
          'UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?',
          [nowIso, row.id, nowIso],
          function (claimErr) {
            if (claimErr || this.changes === 0) {
              return res.status(400).json({ error: pickLang(uiLang, 'Link artıq istifadə edilib və ya vaxtı bitib.', 'Bağlantı zaten kullanıldı veya süresi doldu.', 'Link has already been used or has expired.') });
            }

            bcrypt.hash(newPassword, 12, (hashErr, hashed) => {
              if (hashErr || !hashed) {
                return res.status(500).json({ error: pickLang(uiLang, 'Şifrə yenilənə bilmədi.', 'Şifre güncellenemedi.', 'Password could not be updated.') });
              }
              db.run('UPDATE users SET password = ? WHERE id = ?', [hashed, row.user_id], (uErr) => {
                if (uErr) return res.status(500).json({ error: pickLang(uiLang, 'Şifrə yenilənə bilmədi.', 'Şifre güncellenemedi.', 'Password could not be updated.') });

                // Revoke all existing sessions for this user
                db.run(
                  'UPDATE user_sessions SET is_revoked = 1, revoked_at = ? WHERE user_id = ? AND is_revoked = 0',
                  [nowIso, row.user_id],
                  () => {}
                );

                logSecurityEvent(req, 'auth.password_reset', 'success', { user_id: row.user_id });
                return res.json({ message: pickLang(uiLang, 'Şifrəniz yeniləndi.', 'Şifreniz güncellendi.', 'Your password has been updated.') });
              });
            });
          }
        );
      }
    );
  }
);

// Bildirimler (GET /api/notifications)
router.get('/api/notifications', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ notifications: [] });
  }

  db.all(
    'SELECT n.id, n.type, n.title_az, n.title_tr, n.title_en, n.body_az, n.body_tr, n.body_en, n.link_short, n.created_at, n.read_at, u.original AS original_url ' +
    'FROM notifications n ' +
    'LEFT JOIN urls u ON u.short = n.link_short ' +
    'WHERE n.user_id = ? ' +
    'ORDER BY n.created_at DESC LIMIT 50',
    [req.session.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ notifications: [] });
      return res.json({ notifications: rows || [] });
    }
  );
});

// Bildirimler (POST /api/notifications/mark-all)
router.post('/api/notifications/mark-all', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const status = (req.body && req.body.status) || 'read';
  if (status !== 'read' && status !== 'unread') {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (status === 'read') {
    const now = new Date().toISOString();
    db.run('UPDATE notifications SET read_at = ? WHERE user_id = ?', [now, req.session.userId], function (err) {
      if (err) return res.status(500).json({ error: 'Server error.' });
      return res.json({ updated: this.changes || 0 });
    });
    return;
  }
  db.run('UPDATE notifications SET read_at = NULL WHERE user_id = ?', [req.session.userId], function (err) {
    if (err) return res.status(500).json({ error: 'Server error.' });
    return res.json({ updated: this.changes || 0 });
  });
});

// Bildirimler (POST /api/notifications/delete-all)
router.post('/api/notifications/delete-all', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  db.run('DELETE FROM notifications WHERE user_id = ?', [req.session.userId], function (err) {
    if (err) return res.status(500).json({ error: 'Server error.' });
    return res.json({ deleted: this.changes || 0 });
  });
});

/* ----------------------
   LİNK İŞLEMLERİ (Kısaltma, Yönlendirme, Şifre Koruma, QR Kod)
------------------------- */

// Internal heuristics (regex/extensions) have been removed. We now strictly rely on live external APIs for threat detection.

// Threat Intelligence Feed (URLhaus live sync - 100% free, no API key required)
const threatUrlSet = new Set();
const threatHostSet = new Set();
module.exports = router;

