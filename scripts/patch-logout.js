const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/server.js';
let s = fs.readFileSync(p, 'utf8');

const re = /app\.get\('\/api\/logout',\s*\(req,\s*res\)\s*=>\s*\{[\s\S]*?\}\);\s*/m;
if (!re.test(s)) {
  console.error('Patch failed: /api/logout handler not found in expected form.');
  process.exit(1);
}

const replacement = `function handleLogout(req, res) {
  try {
    res.clearCookie('connect.sid');
  } catch {}

  // Best-effort session destroy.
  if (req.session) {
    try {
      req.session.destroy(() => {});
    } catch {}
  }

  const accept = (req.get('accept') || '').toLowerCase();
  const isNavigate = (req.get('sec-fetch-mode') || '').toLowerCase() === 'navigate';
  const wantsHtml = isNavigate || (accept.includes('text/html') && !accept.includes('application/json'));
  if (wantsHtml) return res.redirect('/');
  return res.json({ message: 'Çıkış yapıldı.' });
}

app.get('/api/logout', handleLogout);
app.post('/api/logout', handleLogout);
`;

s = s.replace(re, replacement + '\n');
fs.writeFileSync(p, s, 'utf8');
console.log('Patched /api/logout to support redirect for navigations + POST support.');
