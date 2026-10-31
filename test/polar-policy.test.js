const test = require('node:test');
const assert = require('node:assert/strict');

const { resolvePolarProductPolicy } = require('../utils/polar');

// F1 regression: the product allowlist must never silently disable itself in
// production when POLAR_PRODUCT_ID is missing.
test('polar product policy enforces when a product id is configured', () => {
  assert.deepEqual(resolvePolarProductPolicy('prod_123', false), { mode: 'enforce', expectedProductId: 'prod_123' });
  assert.deepEqual(resolvePolarProductPolicy('  prod_123  ', true), { mode: 'enforce', expectedProductId: 'prod_123' });
});

test('polar product policy fails closed in production without a product id', () => {
  assert.deepEqual(resolvePolarProductPolicy('', true), { mode: 'fail_closed', expectedProductId: '' });
  assert.deepEqual(resolvePolarProductPolicy(undefined, true), { mode: 'fail_closed', expectedProductId: '' });
  assert.deepEqual(resolvePolarProductPolicy(null, true), { mode: 'fail_closed', expectedProductId: '' });
});

test('polar product policy is disabled outside production without a product id', () => {
  assert.deepEqual(resolvePolarProductPolicy('', false), { mode: 'disabled', expectedProductId: '' });
  assert.deepEqual(resolvePolarProductPolicy(undefined, false), { mode: 'disabled', expectedProductId: '' });
});
