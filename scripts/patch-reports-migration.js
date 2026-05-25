const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/server.js';
let s = fs.readFileSync(p, 'utf8');

const anchor = "  // Optional notes on user reports\n  db.run('ALTER TABLE reports ADD COLUMN notes TEXT', () => {});\n";
if (!s.includes(anchor)) {
  console.error('Anchor not found for reports migration.');
  process.exit(1);
}

const insert =
  anchor +
  "  db.run('ALTER TABLE reports ADD COLUMN resolved_at TEXT', () => {});\n" +
  "  db.run('ALTER TABLE reports ADD COLUMN resolved_by_admin_id INTEGER', () => {});\n";

s = s.replace(anchor, insert);
fs.writeFileSync(p, s, 'utf8');
console.log('Added reports resolution columns migrations.');
