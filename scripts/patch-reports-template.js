const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/views/admin/reports.ejs';
let s = fs.readFileSync(p, 'utf8');

const from = "            <td>\n              <% if (r.disabled) { %>\n                <span class=\"pill pill--danger\">Disabled</span>\n              <% } else if (r.dangerous) { %>\n                <span class=\"pill pill--warn\">Dangerous</span>\n              <% } else { %>\n                <span class=\"pill pill--ok\">Active</span>\n              <% } %>\n            </td>";

if (!s.includes(from)) {
  console.error('Expected status cell snippet not found in reports.ejs');
  process.exit(1);
}

const to = from + "\n            <td style=\"white-space: nowrap;\">\n              <% if (r.has_password) { %>\n                <span class=\"pill\">Password</span>\n              <% } else { %>\n                <span class=\"badge\">-</span>\n              <% } %>\n            </td>";

// Also adjust header to include Password column if not already.
if (!s.includes('<th>Password</th>')) {
  s = s.replace('<th>Son Rapor</th>\n          <th></th>', '<th>Son Rapor</th>\n          <th>Password</th>\n          <th></th>');
}

s = s.replace(from, to);
fs.writeFileSync(p, s, 'utf8');
console.log('Updated admin reports list (password indicator column).');
