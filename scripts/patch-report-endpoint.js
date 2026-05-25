const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/server.js';
let s = fs.readFileSync(p, 'utf8');

const re = /\/\/ Raporlama \(POST \/api\/report\)\s*\napp\.post\('\/api\/report',[\s\S]*?\n\}\);\s*\n/;
const m = s.match(re);
if (!m) {
  console.error('Could not find /api/report block to patch.');
  process.exit(1);
}

const replacement = `// Raporlama (POST /api/report)
app.post('/api/report', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Rapor göndermek için giriş yapmalısınız.' });
  }

  const { short, reason, notes, lang } = req.body || {};
  if (!short) return res.status(400).json({ error: 'Kısaltılmış link gerekli.' });

  const createdAt = new Date().toISOString();
  const cleanReason = (reason || '').toString().trim().slice(0, 500);
  const cleanNotes = (notes || '').toString().trim().slice(0, 1000);
  const uiLang = (lang === 'tr' || lang === 'az') ? lang : 'az';

  db.get(
    'SELECT id FROM reports WHERE short = ? AND user_id = ? AND resolved_at IS NULL',
    [short, req.session.userId],
    (err, reportRow) => {
      if (err) return res.status(500).json({ error: 'Server error.' });

      if (reportRow) {
        return res.status(400).json({
          error: uiLang === 'az' ? 'Bu linki artiq sikayet etmisiniz.' : 'Bu linki zaten raporladınız.'
        });
      }

      db.get('SELECT id FROM urls WHERE short = ?', [short], (err, row) => {
        if (err || !row) return res.status(404).json({ error: 'Belə Bir Link Tapılmadı' });

        db.run(
          'INSERT INTO reports (short, created_at, reason, notes, user_id) VALUES (?, ?, ?, ?, ?)',
          [short, createdAt, cleanReason, cleanNotes, req.session.userId],
          function (err) {
            if (err) return res.status(500).json({ error: err.message });
            // Mark as potentially risky once reported.
            db.run('UPDATE urls SET reports = reports + 1, dangerous = 1 WHERE id = ?', [row.id]);
            return res.json({ message: uiLang === 'az' ? 'Sikayetiniz gonderildi.' : 'Raporunuz gönderildi.' });
          }
        );
      });
    }
  );
});
`;

s = s.replace(re, replacement + '\n');
fs.writeFileSync(p, s, 'utf8');
console.log('Patched /api/report to support notes + resolution + dangerous flag.');
