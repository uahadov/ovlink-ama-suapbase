const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/views/index.ejs';
let s = fs.readFileSync(p, 'utf8');

const anchor = '                  aria-label="Rapor Nedeni"></textarea>';
if (!s.includes(anchor)) {
  console.error('Anchor not found in index.ejs report form.');
  process.exit(1);
}

if (!s.includes('id="reportNotes"')) {
  const insert = anchor + "\n" +
    '                <textarea id="reportNotes" class="form-control rounded-4 shadow-sm"\n' +
    '                  placeholder="Not (opsiyonel)" data-i18n="report_notes" rows="2"\n' +
    '                  aria-label="Report Notes"></textarea>';
  s = s.replace(anchor, insert);
}

fs.writeFileSync(p, s, 'utf8');
console.log('Added reportNotes field to report form.');
