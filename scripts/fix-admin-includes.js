const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'views', 'admin');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ejs'));

const replacements = [
  ["include('admin/partials/layout-top'", "include('partials/layout-top'"],
  ["include('admin/partials/layout-bottom')", "include('partials/layout-bottom')"],
];

const changed = [];
for (const f of files) {
  const p = path.join(dir, f);
  let s = fs.readFileSync(p, 'utf8');
  const before = s;
  for (const [from, to] of replacements) s = s.split(from).join(to);
  if (s !== before) {
    fs.writeFileSync(p, s, 'utf8');
    changed.push(f);
  }
}

console.log('Updated includes in:', changed.length ? changed.join(', ') : '(none)');
