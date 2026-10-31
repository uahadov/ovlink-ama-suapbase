const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * i18n parity guard.
 *
 * public/lang.js holds three language blocks (az/tr/en) for every shared page.
 * A key added to one block only falls back to the raw key in the other two
 * languages, which is exactly the drift this test prevents.
 *
 * views/campaigns.ejs keeps its own three-language dictionary, so its keys are
 * checked against that file instead.
 *
 * The check is intentionally simple: each key line must appear exactly three
 * times. Keys are unique inside a block, so three occurrences mean az + tr + en.
 */

const ROOT = path.join(__dirname, '..');
const LANG_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'lang.js'), 'utf8');
const CAMPAIGN_SOURCE = fs.readFileSync(path.join(ROOT, 'views', 'campaigns.ejs'), 'utf8');

function countKey(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('^\\s*' + escaped + '\\s*:', 'gm');
  return (source.match(pattern) || []).length;
}

test('I18N-01: shared analytics and alert keys exist in all three languages', () => {
  const keys = Array.from(new Set(
    (LANG_SOURCE.match(/^\s*(?:stats_|alerts_|updates_release_|qr_|onboard_|billing_)[a-z0-9_]+(?=\s*:)/gm) || [])
      .map((line) => line.trim().replace(/:$/, ''))
  ));

  assert.ok(keys.length > 100, `expected the analytics key set, got ${keys.length}`);

  const missing = keys.filter((key) => countKey(LANG_SOURCE, key) !== 3);
  assert.deepEqual(missing, [], `keys must exist exactly 3 times (az/tr/en): ${missing.join(', ')}`);
});

test('I18N-02: the new v2 keys are present by name', () => {
  const required = [
    'stats_funnel_title',
    'stats_new_vs_returning',
    'stats_ab_confidence',
    'stats_geo_title',
    'stats_segments_label',
    'stats_audit_title',
    'alerts_title',
    'alerts_save',
    'updates_release_20261101_insights_title',
    'qr_title',
    'qr_create',
    'qr_empty',
    'onboard_step_link',
    'onboard_cta_stats',
    'billing_manage_cta',
  ];

  required.forEach((key) => {
    assert.equal(countKey(LANG_SOURCE, key), 3, `${key} must exist in az, tr and en`);
  });
});

test('I18N-03: the campaigns page dictionary carries the goal keys in three languages', () => {
  ['campaigns_goal_clicks', 'campaigns_goal_conversions', 'campaigns_goal_save', 'campaigns_goal_saved'].forEach((key) => {
    assert.equal(countKey(CAMPAIGN_SOURCE, key), 3, `${key} must exist in az, tr and en`);
  });
});
