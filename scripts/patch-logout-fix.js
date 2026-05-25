const fs = require('fs');

const p = 'C:/Users/exlorin/Desktop/öldü mence/server.js';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);

let removed = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === '});') {
    const prev = (lines[i - 1] || '').trim();
    const prev2 = (lines[i - 2] || '').trim();
    if (prev === "app.post('/api/logout', handleLogout);" || prev2 === "app.post('/api/logout', handleLogout);") {
      lines.splice(i, 1);
      removed++;
      break;
    }
  }
}

if (!removed) {
  console.error('Did not find the stray logout-closing line to remove.');
  process.exit(1);
}

fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('Removed stray logout closing line.');
