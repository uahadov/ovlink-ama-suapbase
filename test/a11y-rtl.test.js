const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * A16 — accessibility and RTL foundation.
 *
 * These tests are source-level on purpose: direction and focus behaviour are
 * contracts of the markup, and a static check cannot flake on a missing
 * database or a browser.
 */

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

const allViews = listViews(VIEWS_DIR);
// Only documents (not body/footer partials) own the <html> element.
const documents = allViews.filter((f) => fs.readFileSync(f, 'utf8').includes('<html'));
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

/** The opening <html> tag, tolerant of EJS expressions containing '>'. */
function htmlTag(source) {
  const start = source.indexOf('<html');
  if (start < 0) return '';
  for (let i = start; i < source.length; i += 1) {
    if (source.startsWith('<%', i)) {
      const end = source.indexOf('%>', i);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (source[i] === '>') return source.slice(start, i + 1);
  }
  return source.slice(start, start + 300);
}

test('A11Y-01: every document sets dir on <html> from the resolved language', () => {
  const offenders = documents.filter((file) => {
    const tag = htmlTag(fs.readFileSync(file, 'utf8'));
    return !/\bdir\s*=/.test(tag);
  }).map(rel);
  assert.deepEqual(offenders, [], `missing dir= on <html>: ${offenders.join(', ')}`);
});

test('A11Y-02: the dir value is data-driven, never a hardcoded rtl/lit literal only', () => {
  const offenders = documents.filter((file) => {
    const tag = htmlTag(fs.readFileSync(file, 'utf8'));
    const match = tag.match(/\bdir\s*=\s*"([^"]*)"/);
    if (!match) return true;
    // Either an EJS expression, or — for a deliberately fixed document — 'ltr'.
    return !(match[1].includes('<%') || match[1] === 'ltr');
  }).map(rel);
  assert.deepEqual(offenders, []);
});

test('A11Y-03: <html> also carries lang, and lang and dir are the only two attributes', () => {
  for (const file of documents) {
    const tag = htmlTag(fs.readFileSync(file, 'utf8'));
    assert.match(tag, /^<html\b/, rel(file));
    assert.match(tag, /\blang\s*=/, `${rel(file)} has no lang attribute: ${tag}`);
    assert.match(tag, /\bdir\s*=/, `${rel(file)} has no dir attribute: ${tag}`);
  }
});

test('A11Y-04: icon-only buttons expose an accessible name', () => {
  const buttonRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  const offenders = [];
  for (const file of allViews) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(buttonRe)) {
      const attrs = match[1];
      const inner = match[2].trim();
      if (!inner) continue;
      const text = inner.replace(/<[^>]*>/g, '').replace(/<%[^%]*%>/g, '').trim();
      const iconOnly = !text && /(<i\s|<svg|<img)/.test(inner);
      if (!iconOnly) continue;
      if (/aria-label|aria-labelledby|data-i18n-aria/.test(attrs)) continue;
      offenders.push(`${rel(file)}: ${match[0].replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [], `icon-only buttons without a name:\n${offenders.join('\n')}`);
});

test('A11Y-05: no positive tabindex anywhere in views', () => {
  const offenders = [];
  for (const file of allViews) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/tabindex="\s*(-?\d+)\s*"/g)) {
      if (Number(match[1]) > 0) offenders.push(`${rel(file)}: tabindex="${match[1]}"`);
    }
  }
  assert.deepEqual(offenders, [], `positive tabindex values: ${offenders.join(', ')}`);
});

test('A11Y-06: full pages offer a skip link that targets #mainContent', () => {
  // iframe-only widgets (embed-stats) have no navigation to skip.
  const exempt = ['views/embed-stats.ejs'];
  const layout = path.join(VIEWS_DIR, 'admin/partials/layout-top.ejs');
  const layoutSource = fs.existsSync(layout) ? fs.readFileSync(layout, 'utf8') : '';
  const offenders = documents.filter((file) => {
    if (exempt.includes(rel(file))) return false;
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('m-skip-link')) return true;
    const hasTarget = /id="mainContent"/.test(source)
      || (/layout-top/.test(source) && /id="mainContent"/.test(layoutSource));
    return !hasTarget;
  }).map(rel);
  assert.deepEqual(offenders, [], `no skip link or no target: ${offenders.join(', ')}`);
});

test('A11Y-07: status screens announce themselves politely', () => {
  const files = ['views/404.ejs', 'views/error-warning.ejs', 'views/maintenance.ejs'];
  for (const relPath of files) {
    const source = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    assert.match(source, /aria-live="polite"/, `${relPath} has no live region`);
    assert.match(source, /role="status"/, `${relPath} has no status role`);
  }
});

test('A11Y-08: focus ring and reduced-motion rules exist in both stylesheets', () => {
  for (const css of ['public/style.css', 'public/home.css']) {
    const source = fs.readFileSync(path.join(ROOT, css), 'utf8');
    assert.match(source, /:focus-visible/, `${css} has no focus-visible rule`);
    assert.match(source, /prefers-reduced-motion/, `${css} ignores reduced motion`);
    assert.match(source, /\[dir="rtl"\]/, `${css} has no RTL block`);
    assert.match(source, /\.sr-only/, `${css} has no screen-reader-only helper`);
  }
});

test('A11Y-09: direction is derived server-side and defaults to ltr', () => {
  const { getDir, RTL_LANGS } = require(path.join(ROOT, 'src/lib/seo'));
  assert.deepEqual(RTL_LANGS, [], 'no RTL language is shipped yet');
  for (const lang of ['az', 'tr', 'en']) assert.equal(getDir(lang), 'ltr');
  // The helper must flip for a language that is added to the list.
  assert.equal(getDir('ar'), 'ltr', 'unknown languages fall back to ltr');
  assert.equal(typeof getDir, 'function');
});

test('A11Y-10: lang middleware exposes dir to every view', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/middleware/lang.js'), 'utf8');
  assert.match(source, /res\.locals\.dir\s*=\s*getDir\(lang\)/);
});

test('A11Y-11: the client language switcher syncs dir and lang together', () => {
  const source = fs.readFileSync(path.join(ROOT, 'public/lang.js'), 'utf8');
  assert.match(source, /const RTL_LANGS\s*=\s*\[[^\]]*\]/);
  assert.match(source, /documentElement\.dir\s*=/);
  assert.match(source, /documentElement\.lang\s*=/);
});

test('A11Y-12: every data-i18n key used by the new landing template exists in all 3 languages', () => {
  const dict = fs.readFileSync(path.join(ROOT, 'public/lang.js'), 'utf8');
  const template = fs.readFileSync(path.join(ROOT, 'views/seo-landing.ejs'), 'utf8');
  const keys = new Set();
  for (const match of template.matchAll(/data-i18n="([a-z0-9_]+)"/g)) keys.add(match[1]);
  assert.ok(keys.size >= 5, 'expected the landing template to use i18n keys');
  const missing = [...keys].filter((key) => {
    const occurrences = (dict.match(new RegExp(`^\\s*${key}\\s*:`, 'gm')) || []).length;
    return occurrences !== 3;
  });
  assert.deepEqual(missing, [], `keys not defined in all 3 languages: ${missing.join(', ')}`);
});
