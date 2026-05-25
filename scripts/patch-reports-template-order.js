const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/views/admin/reports.ejs';
let s = fs.readFileSync(p, 'utf8');

const block =
`            <td style="white-space: nowrap;">
              <% if (r.has_password) { %>
                <span class="pill">Password</span>
              <% } else { %>
                <span class="badge">-</span>
              <% } %>
            </td>
            <td><%= r.last_report_at ? new Date(r.last_report_at).toLocaleString() : '-' %></td>`;

if (!s.includes(block)) {
  console.error('Expected block not found for reorder.');
  process.exit(1);
}

const replacement =
`            <td><%= r.last_report_at ? new Date(r.last_report_at).toLocaleString() : '-' %></td>
            <td style="white-space: nowrap;">
              <% if (r.has_password) { %>
                <span class="pill">Password</span>
              <% } else { %>
                <span class="badge">-</span>
              <% } %>
            </td>`;

s = s.replace(block, replacement);
fs.writeFileSync(p, s, 'utf8');
console.log('Reordered reports columns (Son Rapor before Password).');
