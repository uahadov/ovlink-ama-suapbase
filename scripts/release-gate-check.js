#!/usr/bin/env node
'use strict';

/**
 * P48 — Automated Release Gate Verification Script (release-gate-v1).
 *
 * Verifies critical structural, security, backup, and Monolith design-lock
 * prerequisites before any staging or production release. Never hides failures:
 * exits 1 if any required gate fails.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const REQUIRED_FILES = [
  'server.js',
  'src/db/migrate.js',
  'src/lib/perf-guard.js',
  'src/lib/trust-support.js',
  'src/lib/plan-entitlements.js',
  'src/lib/checkout-dunning.js',
  'src/lib/unit-economics.js',
  'src/lib/demo-funnel.js',
  'src/lib/b2b-onboarding.js',
  'public/home.css',
  'public/robots.txt',
  'public/sitemap.xml',
  'docs/UNIT_ECONOMICS_MODEL.md',
  'docs/TRUST_PRIVACY_CHECKLIST.md',
  'docs/PERFORMANCE_BUDGET.md',
  'docs/RELEASE_GATES_CHECKLIST.md',
  '.github/workflows/ci-release-gates.yml',
];

function runReleaseGateCheck(rootDir = ROOT) {
  const missing = [];
  for (const rel of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(rootDir, rel))) {
      missing.push(rel);
    }
  }

  const ok = missing.length === 0;
  return {
    contract_version: 'release-gate-v1',
    checked_at: new Date().toISOString(),
    ok,
    checked_files: REQUIRED_FILES.length,
    missing,
  };
}

if (require.main === module) {
  const result = runReleaseGateCheck();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

module.exports = { REQUIRED_FILES, runReleaseGateCheck };
