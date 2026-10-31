#!/usr/bin/env node
/**
 * Syntax gate for every JavaScript file we own.
 *
 * The CI workflow used to check a hand-maintained list of 11 files, which meant
 * nothing under src/ was ever parsed. This script walks the repository instead,
 * so a broken import in a new module fails the build before tests do.
 *
 * Usage: node scripts/check-syntax.js [--quiet] [--all]
 *        --all walks the working tree (includes files that are not committed yet).
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'bot_data']);
const SKIP_PREFIXES = [
  path.join('public', 'vendor'),
  path.join('public', 'dist'),
];

function normalize(p) {
  return p.split(path.sep).join('/');
}

function isSkipped(relPath) {
  return SKIP_PREFIXES.some((prefix) => relPath.startsWith(normalize(prefix) + '/'));
}

function listFromGit() {
  try {
    const out = execFileSync('git', ['ls-files', '*.js'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (err) {
    return null;
  }
}

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, acc);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      acc.push(normalize(path.relative(ROOT, abs)));
    }
  }
  return acc;
}

function collectFiles(useGit) {
  const gitFiles = useGit ? listFromGit() : null;
  const files = gitFiles || walk(ROOT, []);
  return files
    .filter((file) => !isSkipped(file))
    .filter((file) => {
      try {
        return fs.statSync(path.join(ROOT, file)).isFile();
      } catch (err) {
        return false;
      }
    })
    .sort();
}

function main() {
  const quiet = process.argv.includes('--quiet');
  // `git ls-files` is the CI default (it matches what actually ships), but a
  // file that has not been committed yet is invisible to it — --all closes that
  // gap for local gates.
  const files = collectFiles(!process.argv.includes('--all'));
  const failures = [];

  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
    } catch (err) {
      const stderr = (err.stderr && err.stderr.toString()) || err.message || '';
      failures.push({ file, stderr: stderr.trim().split('\n').slice(0, 6).join('\n') });
    }
  }

  if (failures.length) {
    for (const failure of failures) {
      process.stderr.write(`\n[x] ${failure.file}\n${failure.stderr}\n`);
    }
    process.stderr.write(`\nSyntax check failed: ${failures.length}/${files.length} file(s).\n`);
    process.exit(1);
  }

  if (!quiet) {
    process.stdout.write(`Syntax check passed: ${files.length} file(s).\n`);
  }
}

main();
