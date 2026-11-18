'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('dashboard mounts advanced folder/tag filters on an existing toolbar', () => {
  const view = read('views/dashboard.ejs');
  const script = read('public/script.js');
  assert.match(view, /id="dashboardFilterForm"/);
  assert.match(script, /dashboardFilterForm\.appendChild\(filtersRow\)/);
  assert.match(script, /filtersRow\.dataset\.initialized/);
});

test('dashboard search does not allow stale responses to replace recent results', () => {
  const script = read('public/script.js');
  assert.match(script, /dashboardFilterRequest\.abort\(\)/);
  assert.match(script, /generation !== dashboardFilterGeneration/);
  assert.match(script, /signal: dashboardFilterRequest\.signal/);
  assert.match(script, /if \(!r\.ok\) throw new Error/);
  assert.match(script, /window\.history\.replaceState/);
});

test('dashboard filter feedback and reset are accessible and localized', () => {
  const view = read('views/dashboard.ejs');
  const lang = read('public/lang.js');
  assert.match(view, /id="dashboardFilterStatus" role="status" aria-live="polite"/);
  assert.match(view, /id="dashboardClearFilters"/);
  for (const key of ['dashboard_filter_panel_label', 'dashboard_filters_reset', 'dashboard_filters_loading', 'dashboard_filters_results', 'dashboard_filters_error']) {
    assert.equal((lang.match(new RegExp('^\\s*' + key + '\\s*:', 'gm')) || []).length, 3, key);
  }
});

test('onboarding completion uses actual account links rather than filtered count', () => {
  const route = read('src/routes/dashboard.js');
  assert.match(route, /SELECT 1 AS ok FROM urls WHERE user_id = \? LIMIT 1/);
  assert.match(route, /totalLinks: accountHasLink \? 1 : 0/);
});

test('enterprise UX messages belong to the correct az/tr/en dictionaries', () => {
  const source = read('public/lang.js');
  const chunks = [
    source.split('    az: {')[1].split('    tr: {')[0],
    source.split('    tr: {')[1].split('    en: {')[0],
    source.split('    en: {')[1].split('\n};')[0],
  ];
  const keys = [
    'dash_action_create', 'dash_action_qr', 'dash_action_campaigns', 'dash_action_team',
    'dashboard_filters_reset', 'dashboard_filters_error', 'dashboard_selected_count',
    'updates_release_20261118_campaigns_desc',
  ];
  for (const chunk of chunks) {
    for (const key of keys) {
      assert.equal((chunk.match(new RegExp('^\\s*' + key + ':', 'gm')) || []).length, 1, `${key} must be defined once per language`);
    }
  }
  assert.match(chunks[0], /dash_action_create: "Yeni link yarat"/);
  assert.match(chunks[1], /dash_action_create: "Yeni bağlantı oluştur"/);
  assert.match(chunks[2], /dash_action_create: "Create a link"/);
});
