const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/server.js';
let s = fs.readFileSync(p, 'utf8');

const oldBlock = "    // Admin moderation controls: disabled links + blocked destination domains\n    if (row.disabled == 1) return res.status(410).send('Link devre disi.');\n    const originalAbs = ensureAbsoluteUrl(row.original);\n    let hostname = '';\n    try { hostname = new URL(originalAbs).hostname.toLowerCase(); } catch (e) { hostname = ' '; }\n\n    if (!hostname) return handleRedirection(req, res, row);\n    db.get('SELECT id FROM blocked_domains WHERE domain = ?', [hostname], (blockErr, blocked) => {\n      if (blocked) return res.status(451).send('Engellendi.');\n      handleRedirection(req, res, row);\n    });";

if (!s.includes(oldBlock)) {
  console.error('Old moderation block not found for /:short route.');
  process.exit(1);
}

const newBlock = "    // Admin moderation controls: disabled links + blocked destination domains\n    if (row.disabled == 1) {\n      return res.status(410).render('error-disabled', { csrfToken: res.locals._csrf, reason: row.disabled_reason || '' });\n    }\n\n    const originalAbs = ensureAbsoluteUrl(row.original);\n    let hostname = '';\n    try { hostname = new URL(originalAbs).hostname.toLowerCase(); } catch { hostname = ''; }\n\n    if (!hostname) return handleRedirection(req, res, row);\n\n    db.get(\"SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1\", [hostname, hostname], (blockErr, blockedRow) => {\n      if (blockedRow) {\n        return res.status(451).render('error-blocked', { csrfToken: res.locals._csrf });\n      }\n      return handleRedirection(req, res, row);\n    });";

s = s.replace(oldBlock, newBlock);
fs.writeFileSync(p, s, 'utf8');
console.log('Patched /:short moderation block to render templates + subdomain matching.');
