'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runReleaseGateCheck } = require('../scripts/release-gate-check');

test('P48 unit: release-gate-check passes all structural, CI, Monolith & docs gates', () => {
  const res = runReleaseGateCheck();
  assert.equal(res.contract_version, 'release-gate-v1');
  assert.equal(res.ok, true, `missing files: ${res.missing.join(', ')}`);
  assert.deepEqual(res.missing, []);

  const ciYaml = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'ci-release-gates.yml'),
    'utf8'
  );
  assert.match(ciYaml, /postgres:16/);
  assert.match(ciYaml, /redis:7/);
  assert.match(ciYaml, /npm test/);
  assert.match(ciYaml, /release-gate-check\.js/);
});
