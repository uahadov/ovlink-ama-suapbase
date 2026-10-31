const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ANALYTICS_TABLES,
  QR_TABLES,
  normalizeUrlIds,
  buildPurgeSteps,
  purgeLinkAnalyticsRows,
} = require('../src/lib/link-purge');

test('PURGE-01: every link-scoped table is emptied before the link row is deleted', async () => {
  const calls = [];
  const tx = {
    run: async (sql, params) => {
      calls.push({ sql, params });
      return { changes: 1 };
    },
  };

  const processed = await purgeLinkAnalyticsRows(tx, [3, '4', 3, 0, 'x', -1]);

  assert.equal(processed, 2, 'only valid, de-duplicated ids are processed');
  assert.equal(calls.length, QR_TABLES.length + ANALYTICS_TABLES.length);

  const tables = calls.map((call) => call.sql.split(' ')[2]);
  assert.deepEqual(tables, [...QR_TABLES, ...ANALYTICS_TABLES]);
  assert.ok(tables.includes('link_funnel_steps'), 'the funnel table must be purged too');
  assert.ok(tables.includes('click_uniques'));
  assert.ok(tables.includes('stats_shares'));

  calls.forEach((call) => {
    assert.deepEqual(call.params, [3, 4]);
    assert.ok(call.sql.includes('IN (?, ?)'));
  });
});

test('PURGE-03: qr_scan_daily is removed through qr_codes before qr_codes itself', () => {
  const steps = buildPurgeSteps([7]);
  assert.equal(steps[0].table, 'qr_scan_daily');
  assert.equal(steps[1].table, 'qr_codes');
  assert.match(steps[0].sql, /qr_id IN \(SELECT id FROM qr_codes WHERE url_id IN \(\?\)\)/);
  assert.equal(steps.length, QR_TABLES.length + ANALYTICS_TABLES.length);
});

test('PURGE-02: invalid input is a no-op', async () => {
  assert.deepEqual(normalizeUrlIds([]), []);
  assert.deepEqual(normalizeUrlIds(['nope', null, undefined]), []);
  assert.equal(await purgeLinkAnalyticsRows(null, [1]), 0);
  assert.equal(await purgeLinkAnalyticsRows({}, [1]), 0);

  let called = false;
  const tx = { run: async () => { called = true; return { changes: 0 }; } };
  assert.equal(await purgeLinkAnalyticsRows(tx, []), 0);
  assert.equal(called, false);
});
