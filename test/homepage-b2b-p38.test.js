'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadHomeTranslations() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'lang-home.js'), 'utf8');
  const sandbox = {
    window: {},
    document: { cookie: '', addEventListener() {}, querySelectorAll() { return []; }, getElementById() { return null; } },
    navigator: { languages: ['en'] },
    localStorage: { getItem() { return null; }, setItem() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${code}\nthis.__t = homeTranslations;`, sandbox);
  return sandbox.__t;
}

test('P38 unit: AZ/TR/EN homepage B2B copy keys exist with full parity and zero placeholder claims', () => {
  const t = loadHomeTranslations();
  const requiredKeys = [
    'hero_sub',
    'hero_cta_trial',
    'hero_cta_demo',
    'feat_title',
    'feat_sub',
    'feat_dashboard_title',
    'feat_dashboard_text',
    'feat_workspaces_title',
    'feat_workspaces_text',
    'how_cta',
    'how_link',
  ];

  for (const lang of ['az', 'tr', 'en']) {
    assert.ok(t[lang], `missing locale ${lang}`);
    for (const key of requiredKeys) {
      const val = String(t[lang][key] || '').trim();
      assert.ok(val.length >= 6, `${lang}.${key} must be non-empty`);
      assert.doesNotMatch(val, /lorem|placeholder|TBD|\[insert/i, `${lang}.${key} must not contain placeholders`);
    }
  }
});

test('P38 unit: views/index.ejs preserves Monolith stylesheet, URL composer, and wires Demo + Trial CTAs', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'views', 'index.ejs'), 'utf8');
  // Monolith CSS & composer preserved
  assert.match(html, /href="\/home\.css\?v=/);
  assert.match(html, /id="shortenForm"/);
  assert.match(html, /id="originalUrl"/);
  // B2B Demo & Start Trial CTAs wired
  assert.match(html, /href="\/register\?intent=trial"/);
  assert.match(html, /href="\/contact\?intent=demo"/);
  assert.match(html, /data-i18n="hero_cta_trial"/);
  assert.match(html, /data-i18n="hero_cta_demo"/);
  // Semantic landmarks preserved
  assert.match(html, /<main id="mainContent">/);
  assert.match(html, /<h1 class="m-hero-h1" id="heroTitle">/);
});
