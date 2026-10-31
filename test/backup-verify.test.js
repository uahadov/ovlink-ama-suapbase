const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('node:path');

/*
 * A10 (W8) — the restore drill.
 *
 * Node.js is not always available where the backup cron runs, so the value of
 * scripts/verify-backup.js is entirely in its guard rail: it must be impossible
 * for the script to drop, overwrite or `pg_restore` into the live database.
 * These tests freeze that contract (guard order, identifier shape) and the
 * workflow that is allowed to run it.
 */

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/verify-backup.js');
const WORKFLOW = path.join(ROOT, '.github/workflows/backup-verify.yml');
const RUNBOOK = path.join(ROOT, 'INCIDENT_RUNBOOK.md');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const { evaluateSafety, withDatabase, sslOptions, REQUIRED_TABLES } = require(SCRIPT);
const scriptSource = fs.readFileSync(SCRIPT, 'utf8');

const BASE = Object.freeze({
  NODE_ENV: 'test',
  ALLOW_RESTORE: '1',
  DATABASE_URL: 'postgres://ovlink:ovlink@localhost:5432/ovlink_test',
  RESTORE_VERIFY_DB: 'ovlink_verify',
});

function env(overrides) {
  return Object.assign({}, BASE, overrides);
}

test('BACKUP-VERIFY-01: required tables cover every analytics surface', () => {
  assert.deepEqual([...REQUIRED_TABLES], ['users', 'urls', 'clicks', 'link_stats_daily', 'qr_codes']);
});

test('BACKUP-VERIFY-02: production and missing opt-in are refused', () => {
  assert.match(evaluateSafety(env({ NODE_ENV: 'production' })).errors[0], /NODE_ENV=production/);
  assert.match(evaluateSafety(env({ ALLOW_RESTORE: '' })).errors[0], /ALLOW_RESTORE=1/);
  // Both at once still reports both problems — the operator must not have to
  // guess which gate stopped the run.
  const both = evaluateSafety(env({ NODE_ENV: 'production', ALLOW_RESTORE: '' }));
  assert.ok(both.errors.length >= 2);
  assert.equal(evaluateSafety(env()).errors.length, 0, 'the happy-path environment should pass');
});

test('BACKUP-VERIFY-03: the target database must be a suffixed throwaway', () => {
  for (const bad of ['', 'ovlink', 'ovlink_test', 'ovlinkverify', 'ovlink_backup']) {
    assert.ok(evaluateSafety(env({ RESTORE_VERIFY_DB: bad })).errors.length, `${bad} was accepted`);
  }
  // Suffix alone is not enough — a hostile/quoted name must not reach psql.
  for (const bad of ['ovlink_verify"; DROP DATABASE postgres; --', 'ovlink verify', '9ovlink_verify', 'ovlink-verify']) {
    const res = evaluateSafety(env({ RESTORE_VERIFY_DB: bad }));
    assert.ok(res.errors.length, `${bad} was accepted`);
  }
  assert.equal(evaluateSafety(env({ RESTORE_VERIFY_DB: 'ovlink_restore_verify' })).errors.length, 0);
});

test('BACKUP-VERIFY-04: the target can never be the source database', () => {
  const same = evaluateSafety(env({
    DATABASE_URL: 'postgres://ovlink:ovlink@localhost:5432/ovlink_verify',
    RESTORE_VERIFY_DB: 'ovlink_verify',
  }));
  assert.match(same.errors.join('\n'), /must differ from the source/);

  const noDb = evaluateSafety(env({ DATABASE_URL: 'postgres://ovlink:ovlink@localhost:5432/' }));
  assert.match(noDb.errors.join('\n'), /specific database/);
  assert.match(evaluateSafety(env({ DATABASE_URL: '' })).errors.join('\n'), /DATABASE_URL is required/);
  assert.match(evaluateSafety(env({ DATABASE_URL: 'not-a-url' })).errors.join('\n'), /not a valid postgres URL/);
});

test('BACKUP-VERIFY-05: the throwaway URL only swaps the database name', () => {
  const target = withDatabase('postgres://ovlink:ovlink@localhost:5432/ovlink_test?sslmode=require', 'ovlink_verify');
  assert.equal(target, 'postgres://ovlink:ovlink@localhost:5432/ovlink_verify?sslmode=require');
  assert.notEqual(decodeURIComponent(new URL(target).pathname), '/ovlink_test');
  // SSL policy mirrors src/db/pool.js: plaintext locally, verified elsewhere.
  assert.equal(sslOptions('postgres://u@localhost:5432/ovlink_verify'), false);
  assert.deepEqual(sslOptions('postgres://u:8f2a1c@db.example.com:5432/ovlink_verify', {}), { rejectUnauthorized: true });
  assert.deepEqual(
    sslOptions('postgres://u:8f2a1c@db.example.com:5432/ovlink_verify', { DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' }),
    { rejectUnauthorized: false }
  );
});

test('BACKUP-VERIFY-06: guards run before any command and cleanup is unconditional', () => {
  const main = scriptSource.slice(scriptSource.indexOf('async function main()'));
  const safetyCheck = main.indexOf('if (safety.errors.length)');
  const firstRun = main.indexOf('run(');
  assert.ok(safetyCheck > -1 && firstRun > safetyCheck, 'a command can run before the safety gate');
  assert.match(main, /process\.exitCode = 1;\s*\n\s*return;/, 'the guard must stop the drill, not warn');

  const finallyBlock = main.slice(main.indexOf('} finally {'));
  assert.ok(finallyBlock.length > 0 && finallyBlock.indexOf('DROP DATABASE IF EXISTS') < finallyBlock.indexOf('}'));
  assert.ok(finallyBlock.includes('pg_terminate_backend'), 'lingering connections would block the drop');
  // Every drop statement must be conditional — a bare `DROP DATABASE x` would
  // abort the whole drill (and the workflow) when the throwaway is absent.
  for (const stmt of main.split('DROP DATABASE').slice(1)) {
    assert.ok(stmt.startsWith(' IF EXISTS'), 'unconditional DROP DATABASE is not idempotent');
  }
  assert.match(scriptSource, /--format=custom/);
  assert.match(scriptSource, /pg_restore', \['--no-owner'/);
  assert.match(scriptSource, /information_schema\.tables/);
  // Cleanup is not trusted blindly — the drill re-reads pg_database and fails
  // if the throwaway is still there.
  assert.match(scriptSource, /function databaseExists/);
  assert.match(main, /await databaseExists\(dbUrl, verifyDb\)/);
  assert.match(scriptSource, /await client\.end\(\)\.catch\(\(\) => \{\}\);/);
  // The drill must never write to the live database name it was given.
  assert.ok(!/run\('(psql|pg_dump|pg_restore)', \[[^\]]*\bdbUrl\b[^\]]*\][^\n]*\n[^\n]*DROP/.test(main));
});

test('BACKUP-VERIFY-07: the weekly workflow is schedule/dispatch only and never prod', () => {
  assert.ok(fs.existsSync(WORKFLOW), 'backup-verify workflow is missing');
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(yml, /schedule:\n\s*-\s*cron:/);
  assert.match(yml, /workflow_dispatch/);
  assert.ok(!/^ {2}pull_request:/m.test(yml) && !/^ {2}push:/m.test(yml), 'the drill must not run on every PR');
  assert.match(yml, /timeout-minutes: 10/);
  assert.match(yml, /postgres:16/);
  assert.match(yml, /NODE_ENV: test/);
  assert.match(yml, /ALLOW_RESTORE: '1'/);
  assert.match(yml, /RESTORE_VERIFY_DB: \w*_verify/);
  assert.ok(!/NODE_ENV: production/.test(yml), 'the drill must never target production');
  assert.match(yml, /scripts\/verify-backup\.js/);
  // A dump of an empty cluster restores "fine" and proves nothing, so the
  // source database has to be seeded through the real migration flow first.
  assert.match(yml, /node scripts\/seed-schema\.js/);
  assert.match(yml, /actions\/setup-node@v4/);
  // Scheduled jobs also fire on every fork; the guard keeps them off.
  assert.match(yml, /if: github\.repository == .+ \|\| github\.event_name == 'workflow_dispatch'/);
  assert.ok(!yml.includes('src/db/schema.sql'), 'there is no schema.sql — do not invent one');
});

test('BACKUP-VERIFY-08: the runbook documents the drill and npm exposes it', () => {
  const runbook = fs.readFileSync(RUNBOOK, 'utf8');
  assert.match(runbook, /^## .*[Rr]estore drill/m, 'INCIDENT_RUNBOOK.md has no restore-drill section');
  assert.ok(runbook.includes('scripts/verify-backup.js'));
  assert.ok(runbook.includes('ALLOW_RESTORE'));
  assert.ok(runbook.includes('RESTORE_VERIFY_DB'));
  assert.match(PKG.scripts['verify:backup'], /scripts\/verify-backup\.js/);
  assert.match(PKG.scripts['verify:backup:seed'], /scripts\/seed-schema\.js/);
  // A syntax gate built on `git ls-files` cannot see a file that has not been
  // committed, so the release gate must use the working-tree variant.
  assert.match(PKG.scripts['check:syntax:working'], /check-syntax\.js --all/);
  assert.ok(PKG.scripts['check:release'].includes('check:syntax:working'), 'check:release still skips untracked files');
});

test('BACKUP-VERIFY-09: the schema seeder is a non-production helper', () => {
  const seed = fs.readFileSync(path.join(ROOT, 'scripts/seed-schema.js'), 'utf8');
  const { assertSafeTarget } = require(path.join(ROOT, 'scripts/seed-schema.js'));
  assert.throws(() => assertSafeTarget({ NODE_ENV: 'production' }), /refuses to run with NODE_ENV=production/);
  assertSafeTarget({ NODE_ENV: 'test' });
  // It must reuse the app's own migration flow rather than a hand-written DDL.
  assert.match(seed, /require\('\.\.\/server'\)/);
  assert.match(seed, /isDbMigrationQueueDrained/);
  assert.ok(!seed.includes('schema.sql'));
});
