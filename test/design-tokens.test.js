const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('design tokens are defined once and never redefined', () => {
  const home = read('public/home.css');
  for (const token of ['--space-1', '--space-4', '--radius-md', '--text-base', '--focus-ring']) {
    const occurrences = (home.match(new RegExp(`${token}\\s*:`, 'g')) || []).length;
    assert.equal(occurrences, 1, `${token} must be defined exactly once`);
  }
});

test('utility layer exists and only consumes tokens', () => {
  const tokens = read('public/tokens.css');
  assert.match(tokens, /\.u-mb-4\s*\{\s*margin-bottom:\s*var\(--space-4\)/);
  assert.equal(/#[0-9a-fA-F]{3,6}/.test(tokens.replace(/rgba?\([^)]*\)/g, '')), false,
    'tokens.css must not hardcode colours');
});

test('adopted views no longer inline the converted spacing values', () => {
  const adopted = ['views/dashboard.ejs', 'views/account.ejs', 'views/workspaces.ejs'];
  for (const rel of adopted) {
    const source = read(rel);
    assert.equal(/style="margin-bottom:\s*16px;?"/.test(source), false, `${rel} still inlines margin-bottom:16px`);
    assert.equal(/style="margin-bottom:\s*12px;?"/.test(source), false, `${rel} still inlines margin-bottom:12px`);
    assert.match(source, /tokens\.css/, `${rel} must load the utility layer it uses`);
  }
});
