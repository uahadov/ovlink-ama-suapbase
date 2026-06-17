// DEPRECATED: This file is NOT mounted in server.js. All auth logic lives in server.js.
// This file is kept only for `node --check` syntax validation per AGENTS.md.
// DO NOT import or mount this router — it lacks CSRF protection, rate limiting,
// session regeneration, and PII encryption that the server.js routes provide.
const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const crypto = require("crypto");

module.exports = (db, transporter, tempEmailDomains) => {
  // Kayıt
  router.post("/register", (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "E-posta ve şifre gerekli." });

    const emailDomain = email.split("@")[1].toLowerCase();
    if (tempEmailDomains.includes(emailDomain)) {
      return res
        .status(400)
        .json({ error: "Geçici e-posta adresi kullanılamaz." });
    }

    const verificationCode = crypto.randomInt(0, 1000000).toString().padStart(6, "0");
    const verificationExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    bcrypt.hash(password, 10, (hashErr, hashed) => {
      if (hashErr || !hashed) {
        return res.status(500).json({ error: "Şifre güvenli şekilde oluşturulamadı." });
      }

      db.run(
        "INSERT INTO users (email, password, verification_code, verification_expires_at) VALUES (?, ?, ?, ?)",
        [email, hashed, verificationCode, verificationExpiresAt],
        function (err) {
          if (err)
            return res
              .status(500)
              .json({ error: "E-posta zaten kullanılıyor olabilir." });

          const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: "Doğrulama Kodunuz",
            text: `Kodunuz: ${verificationCode}`,
          };

          transporter
            .sendMail(mailOptions)
            .then(() => {
              req.session.tempEmail = email;
              res.json({ message: "Doğrulama kodu gönderildi." });
            })
            .catch((err) =>
              res.status(500).json({ error: "E-posta gönderilemedi." }),
            );
        },
      );
    });
  });

  // E-posta doğrulama
  router.post("/verify-email", (req, res) => {
    const { email, verificationCode } = req.body;
    if (!email || !verificationCode)
      return res.status(400).json({ error: "E-posta ve kod gerekli." });

    db.get("SELECT * FROM users WHERE email = ?", [email], (err, user) => {
      if (err || !user)
        return res.status(404).json({ error: "Kullanıcı bulunamadı." });
      const expiresMs = Date.parse((user.verification_expires_at || "").toString());
      if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
        return res.status(400).json({ error: "Kod süresi dolmuş." });
      }
      if (user.verification_code === verificationCode) {
        db.run(
          "UPDATE users SET email_verified = 1, verification_code = NULL, verification_expires_at = NULL WHERE email = ?",
          [email],
        );
        res.json({ message: "Doğrulama başarılı." });
      } else {
        res.status(400).json({ error: "Kod yanlış." });
      }
    });
  });

  // Giriş
  router.post("/login", (req, res) => {
    const { email, password } = req.body;
    db.get("SELECT * FROM users WHERE email = ?", [email], (err, user) => {
      if (err || !user)
        return res.status(401).json({ error: "Hatalı bilgiler." });
      bcrypt.compare(password, user.password, (cmpErr, ok) => {
        if (cmpErr || !ok)
          return res.status(401).json({ error: "Şifre yanlış." });
        if (user.email_verified !== 1)
          return res.status(403).json({ error: "E-posta doğrulanmamış." });

        req.session.userId = user.id;
        req.session.username = email;
        return res.json({ message: "Giriş başarılı." });
      });
    });
  });

  // Çıkış
  router.get("/logout", (req, res) => {
    req.session.destroy();
    res.json({ message: "Çıkış yapıldı." });
  });

  return router;
};
