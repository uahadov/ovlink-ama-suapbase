const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/server.js';
let s = fs.readFileSync(p, 'utf8');

const anchor = "function ensureAbsoluteUrl(url) {\n  if (!url) return '';\n  if (url.startsWith('http://') || url.startsWith('https://')) {\n    return url;\n  }\n  return 'http://' + url;\n}\n";

if (!s.includes(anchor)) {
  console.error('Anchor ensureAbsoluteUrl not found.');
  process.exit(1);
}

if (!s.includes('function escapeHtml(')) {
  const insert = `${anchor}
// Basic HTML escaping for server-rendered error pages
function escapeHtml(value) {
  return (value || '').toString().replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}
`;

  s = s.replace(anchor, insert);
}

fs.writeFileSync(p, s, 'utf8');
console.log('Added escapeHtml helper.');
