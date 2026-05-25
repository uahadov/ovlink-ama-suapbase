const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/views/admin/partials/layout-top.ejs';
let s = fs.readFileSync(p, 'utf8');

const marker = '          </a>\n          <a href="/admin/domains"';
if (!s.includes(marker)) {
  console.error('marker not found in layout-top.ejs');
  process.exit(1);
}

const insert =
  '          </a>\n' +
  '          <a href="/admin/links" class="<%= active === \'links\' ? \'active\' : \'\' %>">\n' +
  '            <span>Links</span>\n' +
  '            <span class="badge">All</span>\n' +
  '          </a>\n' +
  '          <a href="/admin/domains"';

s = s.replace(marker, insert);
fs.writeFileSync(p, s, 'utf8');
console.log('Updated admin sidebar (added Links).');
