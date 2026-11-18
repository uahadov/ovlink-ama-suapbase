'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {toCsv, filename} = require('../public/campaign-report');
const sample = () => ({
  campaign: { name: 'Qış, kampaniyası', slug: 'qis-kampaniyasi' },
  range: { from: '2026-11-01T00:00:00Z', to: '2026-11-18T00:00:00Z', bots: 'exclude' },
  generated_at: '2026-11-18T09:00:00Z', links_count: 2, clicks: 100,
  uniques: 81, conversions: 9, conversion_rate: 9,
  clicks_by_day: [{ date: '2026-11-18', count: 100 }],
  top_links: [{ short: 'win', original: '=HYPERLINK("https://evil.test")', clicks: 100, uniques: 81, conversions: 9 }],
  top_sources: [{ name: '+cmd', count: 10 }],
  top_goals: [{ name: '@SUM(A1:A2)', count: 9 }],
});

test('campaign CSV represents server-provided metrics and date boundaries', () => {
  const csv = toCsv(sample());
  assert.ok(csv.startsWith('\uFEFF'), 'UTF-8 BOM supports Excel');
  assert.match(csv, /"Clicks","100"/);
  assert.match(csv, /"Unique visitors","81"/);
  assert.match(csv, /"Conversions","9"/);
  assert.match(csv, /"Date from \(UTC\)","2026-11-01T00:00:00Z"/);
  assert.match(csv, /"Bot filter","Excluded"/);
  assert.match(csv, /"Metric source","unspecified"/);
  assert.match(csv, /"Qış, kampaniyası"/);
  assert.match(csv, /"Date","Clicks"\r\n"2026-11-18","100"/);
});

test('campaign CSV escapes quotes and neutralizes formula-like input', () => {
  const csv = toCsv(sample());
  assert.ok(csv.includes("'="), 'URL formula must be escaped');
  assert.ok(csv.includes("'+cmd"), 'source formula must be escaped');
  assert.ok(csv.includes("'@SUM"), 'goal formula must be escaped');
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/evil\.test""\)"/);
});

test('campaign CSV rejects invalid payload and creates stable safe filenames', () => {
  assert.throws(() => toCsv(null), TypeError);
  assert.throws(() => toCsv({}), TypeError);
  assert.equal(filename(sample()), 'ovlink-campaign-qis-kampaniyasi-report.csv');
  assert.equal(filename({campaign:{slug:'../../evil='}}), 'ovlink-campaign-------evil--report.csv');
});

test('campaign interface uses localized accessible export control and script asset', () => {
  const fs = require('node:fs');
  const view = fs.readFileSync(require('node:path').resolve(__dirname,'../views/campaigns.ejs'),'utf8');
  assert.match(view, /id="campaignExportCsv" disabled/);
  assert.match(view, /campaign-report\.js\?v=<%= assetVersion %>/);
  assert.match(view, /campaigns-page\.js\?v=<%= assetVersion %>/);
  const campaignScript = fs.readFileSync(require('node:path').resolve(__dirname,'../public/campaigns-page.js'),'utf8');
  assert.equal((campaignScript.match(/^\s*campaigns_export_csv:/gm) || []).length, 3);
  assert.match(campaignScript, /currentCampaignSnapshot = data/);
});

test('campaign business controls have correct locale-specific translations', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '../public/campaigns-page.js'), 'utf8');
  const parts = {
    az: source.split('        az: {')[1].split('        tr: {')[0],
    tr: source.split('        tr: {')[1].split('        en: {')[0],
    en: source.split('        en: {')[1].split('      };')[0],
  };
  for (const part of Object.values(parts)) {
    for (const key of ['campaigns_export_csv', 'campaigns_export_error', 'campaigns_empty_title', 'campaigns_load_error']) {
      assert.equal((part.match(new RegExp('^\\s*' + key + ':', 'gm')) || []).length, 1, `${key} must exist exactly once per locale`);
    }
  }
  assert.match(parts.az, /campaigns_export_csv: 'CSV hesabatı endir'/);
  assert.match(parts.tr, /campaigns_export_csv: 'CSV raporu indir'/);
  assert.match(parts.en, /campaigns_export_csv: 'Download CSV report'/);
});
