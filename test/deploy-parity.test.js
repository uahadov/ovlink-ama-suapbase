const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the serverless function only requires the Express app, not the boot graph', () => {
  const fn = read('netlify/functions/api.js');
  assert.equal(/require\(['"]\.\.[/\\]\.\.[/\\]server\.js['"]\)/.test(fn), false,
    'netlify function must not require server.js');
  assert.match(fn, /require\(['"]\.\.\/\.\.\/src\/app['"]\)/,
    'netlify function must require src/app.js directly');
});

test('netlify is declared as a limited, web-only runtime', () => {
  const toml = read('netlify.toml');
  assert.match(toml, /WEB_ONLY\s*=\s*"1"/);
});

test('src/app.js exports the app object the function destructures', () => {
  const app = read('src/app.js');
  assert.match(app, /module\.exports\s*=\s*\{\s*app\s*\}/);
});
