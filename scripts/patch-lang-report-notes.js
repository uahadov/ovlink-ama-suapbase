const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/public/lang.js';
let s = fs.readFileSync(p, 'utf8');

if (!s.includes('report_notes')) {
  s = s.replace(
    /report_reason:\s*"Səbəb",\s*(\r?\n)/,
    (m, nl) => `report_reason: "Səbəb",${nl}        report_notes: "Qeyd (istəyə bağlı)",${nl}`,
  );

  s = s.replace(
    /report_reason:\s*"Sebep",\s*(\r?\n)/,
    (m, nl) => `report_reason: "Sebep",${nl}        report_notes: "Not (isteğe bağlı)",${nl}`,
  );
}

fs.writeFileSync(p, s, 'utf8');
console.log('Inserted report_notes translations (if missing).');
