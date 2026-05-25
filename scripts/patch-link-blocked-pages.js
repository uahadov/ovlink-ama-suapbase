const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const target = path.join(projectRoot, 'server.js');

if (!fs.existsSync(target)) {
  console.error('server.js not found.');
  process.exit(1);
}

const source = fs.readFileSync(target, 'utf8');

if (source.includes('function sendLinkDisabledPage(') && source.includes('function sendDomainBlockedPage(')) {
  console.log('Helpers already exist. No patch needed.');
  process.exit(0);
}

console.log('Helpers not found. This legacy patch script is intentionally disabled to avoid partial writes.');
console.log('Apply changes manually in server.js if needed.');
