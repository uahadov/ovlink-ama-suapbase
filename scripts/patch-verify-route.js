const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/server.js';
let s = fs.readFileSync(p, 'utf8');

const re = /\/\/ \u015eifre do\u011frulama \(POST \/verify\/:short\)[\s\S]*?app\.post\('\/verify\/:short',[\s\S]*?\n\}\);\s*\n/;
if (!re.test(s)) {
  console.error('Could not find /verify/:short route block to patch.');
  process.exit(1);
}

const replacement = `// Şifre doğrulama (POST /verify/:short)
app.post('/verify/:short', (req, res) => {
  const short = req.params.short;
  const password = (req.body.password || '').toString();
  const uiLang = (req.body && (req.body.lang === 'tr' || req.body.lang === 'az')) ? req.body.lang : 'az';

  db.get('SELECT * FROM urls WHERE short = ?', [short], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: uiLang === 'az' ? 'Link tapılmadı.' : 'Link bulunamadı.' });
    }

    // Enforce admin moderation here too (avoid bypass via /proceed + /verify)
    if (row.disabled == 1) {
      return res.status(410).json({ error: uiLang === 'az' ? 'Link deaktiv edilib.' : 'Link devre dışı.' });
    }

    const targetUrl = ensureAbsoluteUrl(row.original);
    let hostname = '';
    try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { hostname = ''; }

    const checkBlockedDomain = (cb) => {
      if (!hostname) return cb(false);
      db.get(
        "SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1",
        [hostname, hostname],
        (blockErr, blockedRow) => cb(!!blockedRow)
      );
    };

    checkBlockedDomain((isBlocked) => {
      if (isBlocked) {
        return res.status(451).json({
          error: uiLang === 'az' ? 'Bu domen bloklanib.' : 'Bu alan adı engellenmiştir.'
        });
      }

      // Expiry check
      if (row.expires_at && new Date() > new Date(row.expires_at)) {
        return res.status(410).json({
          error: uiLang === 'az' ? 'Bu linkin vaxtı bitib.' : 'Bu linkin süresi doldu.'
        });
      }

      // Max clicks check
      db.get('SELECT COUNT(*) as count FROM clicks WHERE url_id = ?', [row.id], (countErr, result) => {
        const current = result ? (result.count || 0) : 0;
        if (row.max_clicks && current >= row.max_clicks) {
          return res.status(410).json({
            error: uiLang === 'az' ? 'Bu link limitə çatıb.' : 'Bu link maksimum tıklama limitine ulaştı.'
          });
        }

        if (row.link_password === password) {
          // Tıklama kaydı ekle
          const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
          const agent = useragent.parse(req.headers['user-agent']);
          const geo = geoip.lookup(ip);
          let country = 'Unknown';
          let city = 'Unknown';
          if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
            country = 'Local Dev';
            city = 'Localhost';
          } else if (geo) {
            country = geo.country || 'Unknown';
            city = geo.city || 'Unknown';
          }
          const clickTime = new Date().toISOString();
          let osDisplay = agent.os.toString();
          if (osDisplay.includes('0.0.0')) osDisplay = agent.os.family;

          db.run(
            'INSERT INTO clicks (url_id, click_time, ip, browser, os, country, city) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [row.id, clickTime, ip, agent.toAgent(), osDisplay, country, city]
          );

          return res.json({ success: true, redirect: targetUrl });
        }

        return res.status(401).json({ error: uiLang === 'az' ? 'Yanlış şifrə.' : 'Yanlış şifre.' });
      });
    });
  });
});
`;

s = s.replace(re, replacement + '\n');
fs.writeFileSync(p, s, 'utf8');
console.log('Patched /verify/:short to enforce moderation + expiry + max-clicks and localize errors.');
