const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VIEWS_DIR = path.join(ROOT, 'views');

function listViews(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) listViews(abs, acc);
    else if (entry.name.endsWith('.ejs')) acc.push(abs);
  }
  return acc;
}

const views = listViews(VIEWS_DIR);

test('no view loads FontAwesome from a third-party CDN', () => {
  const offenders = views.filter((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return source.includes('cdnjs.cloudflare.com/ajax/libs/font-awesome')
      || source.includes('cdn.jsdelivr.net/npm/@fortawesome');
  }).map((file) => path.relative(ROOT, file));

  assert.deepEqual(offenders, [], `third-party icon CDN still referenced by: ${offenders.join(', ')}`);
});

test('every view that preloads FontAwesome also links the local stylesheet exactly once', () => {
  const problems = [];
  for (const file of views) {
    const source = fs.readFileSync(file, 'utf8');
    const links = (source.match(/\/vendor\/fontawesome\/css\/all\.min\.css/g) || []).length;
    if (links > 1) problems.push(`${path.relative(ROOT, file)}: ${links} stylesheet links`);
  }
  assert.deepEqual(problems, []);
});

test('icon classes used in views exist in the vendored FontAwesome bundle', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/vendor/fontawesome/css/all.min.css'), 'utf8');
  const used = new Set();
  for (const file of views) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bfa-[a-z0-9-]+/g)) used.add(match[0]);
  }
  const missing = [...used].filter((cls) => !css.includes(cls));
  assert.deepEqual(missing, [], `icons missing from the local bundle: ${missing.join(', ')}`);
});
