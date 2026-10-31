const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrateSrc = fs.readFileSync(path.join(__dirname, '..', 'src/db/migrate.js'), 'utf8');

function hasDdl(re, label) {
  assert.ok(re.test(migrateSrc), `${label} must be present in the startup migration flow`);
}

test('DDL-01: qr tables are created idempotently', () => {
  hasDdl(/CREATE TABLE IF NOT EXISTS qr_codes/, 'qr_codes table');
  hasDdl(/CREATE TABLE IF NOT EXISTS qr_scan_daily/, 'qr_scan_daily table');
  assert.match(migrateSrc, /slug TEXT UNIQUE/, 'the scan slug must be unique');
  assert.match(migrateSrc, /PRIMARY KEY \(qr_id, day\)/, 'daily counters are keyed per day');
});

test('DDL-02: qr indexes cover the dashboard and purge access patterns', () => {
  hasDdl(/CREATE INDEX IF NOT EXISTS idx_qr_codes_user ON qr_codes\(created_by, deleted_at\)/, 'user index');
  hasDdl(/CREATE INDEX IF NOT EXISTS idx_qr_codes_url ON qr_codes\(url_id\)/, 'per-link index used by purge');
  hasDdl(/CREATE INDEX IF NOT EXISTS idx_qr_scan_daily_day ON qr_scan_daily\(day\)/, 'day index');
});

test('DDL-03: qr_codes carries no foreign key to urls', () => {
  const block = migrateSrc.slice(
    migrateSrc.indexOf('CREATE TABLE IF NOT EXISTS qr_codes'),
    migrateSrc.indexOf('CREATE TABLE IF NOT EXISTS qr_scan_daily')
  );
  assert.doesNotMatch(block, /REFERENCES/, 'a FK would block link deletion (no ON DELETE CASCADE here)');
});

test('DDL-04: onboarding lifecycle columns are added through tryAddColumn-safe ALTERs', () => {
  hasDdl(/ALTER TABLE users ADD COLUMN onboarding_dismissed_at TEXT/, 'dismissal column');
  hasDdl(/ALTER TABLE users ADD COLUMN onboarding_nudged_at TEXT/, 'nudge guard column');
});

test('DDL-05: no INSERT OR IGNORE is used for the new tables', () => {
  // src/db/index.js only rewrites `INSERT OR IGNORE` for three legacy tables;
  // anything else must use an explicit ON CONFLICT clause.
  const qrSection = migrateSrc.slice(migrateSrc.indexOf('CREATE TABLE IF NOT EXISTS qr_codes'));
  assert.doesNotMatch(qrSection.slice(0, 4000), /INSERT OR IGNORE INTO qr_/, 'qr tables must not rely on INSERT OR IGNORE');
});
