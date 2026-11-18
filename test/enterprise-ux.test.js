'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('enterprise dashboard quick actions target existing navigation and internal anchors', () => {
  const dashboard = read('views/dashboard.ejs');
  for (const destination of ['#dashboardQuickCreateForm', '#qrCodesSection', '/campaigns', '/workspaces']) {
    assert.ok(dashboard.includes(`href="${destination}"`), `missing navigation: ${destination}`);
  }
  assert.match(dashboard, /id="dashboardQuickCreateForm"/);
  assert.match(dashboard, /id="qrCodesSection"/);
  assert.match(dashboard, /m-dash-actions/);
});

test('onboarding progress is rendered from real completed state, not hardcoded', () => {
  const template = read('views/partials/onboarding-checklist.ejs');
  assert.match(template, /steps\.filter\(\(step\) => step\.done\)\.length/);
  assert.match(template, /role="progressbar"/);
  assert.match(template, /aria-valuenow="<%= completedSteps %>"/);
  assert.match(template, /aria-valuemax="<%= steps\.length %>"/);
});

test('new product navigation copy is available in all three languages', () => {
  const dict = read('public/lang.js');
  for (const key of ['dash_action_create','dash_action_qr','dash_action_campaigns','dash_action_team','dash_actions_aria','onboard_progress','updates_release_20261118_ux_title','updates_release_20261118_ux_desc']) {
    assert.equal((dict.match(new RegExp('^\\s*'+key+'\\s*:', 'gm')) || []).length, 3, `missing translations for ${key}`);
  }
});

test('responsive navigation respects reduced motion', () => {
  const css = read('public/home.css');
  assert.match(css, /\.m-dash-actions/);
  assert.match(css, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});
