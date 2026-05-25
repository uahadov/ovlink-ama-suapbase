const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/public/script.js';
let s = fs.readFileSync(p, 'utf8');

const reasonLine = '    const reportReason = document.getElementById("reportReason")?.value?.trim();';
if (!s.includes(reasonLine)) {
  console.error('Reason line not found.');
  process.exit(1);
}

if (!s.includes('const reportNotes =')) {
  s = s.replace(reasonLine, reasonLine + "\n    const reportNotes = document.getElementById(\"reportNotes\")?.value?.trim();");
}

const bodyLine = '        body: JSON.stringify(withCsrf({ short: reportLink, reason: reportReason })),';
if (!s.includes(bodyLine)) {
  console.error('Report fetch body line not found.');
  process.exit(1);
}

s = s.replace(
  bodyLine,
  '        body: JSON.stringify(withCsrf({\n' +
    '          short: reportLink,\n' +
    '          reason: reportReason,\n' +
    '          notes: reportNotes || undefined,\n' +
    '          lang: currentLang\n' +
    '        })),',
);

fs.writeFileSync(p, s, 'utf8');
console.log('Patched report request in public/script.js');
