'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('dashboard ships its layout CSS after base and token CSS', () => {
  const tpl = read('views/dashboard.ejs');
  const home = tpl.indexOf('/home.css?v=<%= assetVersion %>');
  const tokens = tpl.indexOf('/tokens.css?v=<%= assetVersion %>');
  const dashboard = tpl.indexOf('/dashboard-ux.css?v=<%= assetVersion %>');
  assert.ok(home >= 0 && tokens > home && dashboard > tokens, 'stylesheet order must be predictable');
});

test('dashboard metadata fields do not rely on unloaded Bootstrap UI classes', () => {
  const script = read('public/script.js');
  assert.match(script, /filtersRow.className = "dashboard-meta-filters"/);
  assert.match(script, /id="dashboardFolderFilter" class="m-adv-select"/);
  assert.match(script, /id="dashboardTagFilter" class="m-adv-select"/);
  assert.doesNotMatch(script, /id="dashboardMetaFilterClear"/);
  assert.match(read('views/dashboard.ejs'), /id="dashboardClearFilters"/);
});

test('dashboard layout styles support responsive grid and visible onboarding progress', () => {
  const css = read('public/dashboard-ux.css');
  for (const selector of ['.m-dash-actions', '#onboardingChecklist', '#dashboardFilterForm', '#dashboardMetaFilters', '.m-dash-clear-filters']) {
    assert.ok(css.includes(selector), selector);
  }
  assert.match(css, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(max-width:900px\)/);
  assert.match(css, /@media\(max-width:560px\)/);
  assert.match(css, /@media\(max-width:359px\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test('asset version derives from shipped CSS/JS content unless explicitly overridden', () => {
  const source = read('src/config/index.js');
  assert.match(source, /function fingerprintStaticAssets\(\)/);
  assert.match(source, /fingerprint\.update\(fs\.readFileSync\(filename\)\)/);
  assert.match(source, /'dashboard-ux\.css'/);
  assert.doesNotMatch(source, /\|\| '20261102-01'/);
});

test('MCP and API guide flex/grid containers cannot force viewport wider than mobile screens', () => {
  const css = read('public/home.css');
  assert.match(css, /\.ovx\.api-guide-page \.m-legal-layout \{ min-width:0/);
  assert.match(css, /grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /\.ovx\.api-guide-page \.m-api-tabs-nav \{ width:100%;.*overflow-x:auto/);
});
