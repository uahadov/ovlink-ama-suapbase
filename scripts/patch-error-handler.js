const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/server.js';
let s = fs.readFileSync(p, 'utf8');

const from = "  if (isApi || req.accepts('json')) {\r\n    return res.status(status).json({ error: message });\r\n  }";
const to = "  const accept = (req.get('accept') || '').toLowerCase();\r\n  const wantsJson =\r\n    isApi ||\r\n    req.is('application/json') ||\r\n    (accept.includes('application/json') && !accept.includes('text/html'));\r\n\r\n  if (wantsJson) {\r\n    return res.status(status).json({ error: message });\r\n  }";

if (!s.includes(from)) {
  // Fallback: handle LF-only files
  const fromLf = from.replaceAll('\r\n', '\n');
  const toLf = to.replaceAll('\r\n', '\n');
  if (!s.includes(fromLf)) {
    console.error('Patch failed: expected error-handler snippet not found.');
    process.exit(1);
  }
  s = s.replace(fromLf, toLf);
} else {
  s = s.replace(from, to);
}

fs.writeFileSync(p, s, 'utf8');
console.log('Patched server.js error handler JSON detection.');
