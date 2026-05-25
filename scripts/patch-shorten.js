const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/server.js';
let s = fs.readFileSync(p, 'utf8');

const re = /\/\/ URL k\u0131saltma \(POST \/api\/shorten\)[\s\S]*?app\.post\('\/api\/shorten',[\s\S]*?\n\s*\}\);\s*\n\s*\n/;
if (!re.test(s)) {
  console.error('Could not find /api/shorten block to patch.');
  process.exit(1);
}

const replacement = `// URL kısaltma (POST /api/shorten)
// Eğer kullanıcı özel link girmişse (customLink) onu kullan, aksi halde random üret.
app.post('/api/shorten',
  [
    body('original')
      .isURL().withMessage('Zəhmət olmasa düzgün bir URL daxil edin.')
      .trim(),
    body('customLink')
      .optional({ checkFalsy: true })
      .matches(/^[a-zA-Z0-9_-]+$/).withMessage('Xüsusi link yalnız hərf, rəqəm, tire və alt xətt simvollarından ibarət ola bilər.')
      .isLength({ max: 50 }).withMessage('Xüsusi link ən çox 50 simvoldan ibarət ola bilər.')
      .trim()
      .escape(),
    body('max_clicks')
      .optional({ checkFalsy: true })
      .isInt({ min: 1 }).withMessage('Maksimum klik sayı 1 və ya daha çox olmalıdır.')
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    if (!req.session.userId)
      return res.status(401).json({ error: 'Link qısaltmaq üçün giriş etməlisiniz.' });

    const uiLang = (req.body && (req.body.lang === 'tr' || req.body.lang === 'az')) ? req.body.lang : 'az';

    const { original, link_password, customLink, expires_at, max_clicks } = req.body;
    const originalAbs = ensureAbsoluteUrl(original);

    let hostname = '';
    try { hostname = new URL(originalAbs).hostname.toLowerCase(); } catch { hostname = ''; }

    // Blocked domain check (prevents creating links for blocked destinations)
    const checkBlockedDomain = (cb) => {
      if (!hostname) return cb(null);
      db.get(
        "SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1",
        [hostname, hostname],
        (err, row) => {
          if (err) return cb(null);
          return cb(row ? row.domain : null);
        }
      );
    };

    checkBlockedDomain((blockedDomain) => {
      if (blockedDomain) {
        return res.status(403).json({
          error: uiLang === 'az'
            ? 'Bu domen bloklanib. Bu linki qısaltmaq mümkün deyil.'
            : 'Bu alan adı engellendi. Bu link kısaltılamaz.'
        });
      }

      let short = "";
      if (customLink && customLink.trim() !== "") {
        short = customLink.trim();

        // Rezerve edilen path'ler (admin ve sistem route'lari) kullanilamaz
        const reserved = new Set([
          'admin', 'admin/', 'api', 'dashboard', 'login', 'register', 'privacy', 'stats',
          'proceed', 'qrcode', 'verify-email', 'verify', 'logout',
        ]);
        if (reserved.has(short.toLowerCase())) {
          return res.status(400).json({ error: 'Bu xususi link kullanilamaz.' });
        }

        // Özel link zaten kullanılmış mı kontrol et
        db.get('SELECT * FROM urls WHERE short = ?', [short], (err, row) => {
          if (row) {
            return res.status(400).json({ error: 'Bu xüsusi link istifadə olunub' });
          } else {
            insertLink();
          }
        });
      } else {
        short = shortid.generate();
        insertLink();
      }

      function insertLink() {
        const createdAt = new Date().toISOString();
        const shortUrl = req.protocol + '://' + req.get('host') + '/' + short;
        db.run(
          'INSERT INTO urls (original, short, created_at, user_id, link_password, expires_at, max_clicks) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [originalAbs, short, createdAt, req.session.userId, link_password || '', expires_at || null, max_clicks || null],
          function (err) {
            if (err) return res.status(500).json({ error: 'Link qısaldıla bilmədi.' });
            return res.json({
              message: 'Qısaldılmış link: ' + shortUrl,
              short: short,
              shortUrl: shortUrl,
            });
          }
        );
      }
    });
  });

`;

s = s.replace(re, replacement);
fs.writeFileSync(p, s, 'utf8');
console.log('Patched /api/shorten to block blocked_domains at creation time.');
