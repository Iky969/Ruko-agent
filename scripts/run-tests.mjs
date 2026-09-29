#!/usr/bin/env node
/**
 * Cross-platform launcher for the Node.js built-in test runner.
 *
 * WHY: `node --test dist/tests/*.test.js` depends on the *shell* expanding the
 * glob. That works in bash/sh, but cmd.exe (and PowerShell) do not expand it,
 * so `npm test` silently broke on Windows runners, and `node --test dist/tests`
 * (directory mode) changed behaviour across Node generations (18 → 24).
 * Enumerating the files in Node and passing an explicit argv array makes the
 * command deterministic on Linux, Windows and macOS for every Node ≥ 18.
 *
 * ZERO dependency — `node:*` built-ins only (node:fs, node:path, node:child_process).
 *
 * Usage:
 *   node scripts/run-tests.mjs                          # every dist/tests/**\/*.test.js
 *   node scripts/run-tests.mjs --filter e2e.test.js     # only matching files
 *   node scripts/run-tests.mjs --test-concurrency=1     # extra Node flags are forwarded
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TESTS_DIR = join(PROJECT_ROOT, 'dist', 'tests');

/** Recursively collects every `*.test.js` file below `dir` (sorted, deterministic). */
function collectTestFiles(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.test.js')) found.push(full);
    }
  };
  walk(dir);
  return found;
}

const argv = process.argv.slice(2);
const nodeFlags = [];
let filter = null;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--filter' || arg === '--filter=') {
    filter = argv[i + 1] ?? null;
    i += 1;
  } else if (arg.startsWith('--filter=')) {
    filter = arg.slice('--filter='.length);
  } else {
    nodeFlags.push(arg);
  }
}

const allFiles = collectTestFiles(TESTS_DIR);
const files = filter ? allFiles.filter((file) => file.includes(filter)) : allFiles;

if (allFiles.length === 0) {
  console.error(`✖ No compiled test files found in ${relative(PROJECT_ROOT, TESTS_DIR)} — run "npm run build" first.`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`✖ No test file matched --filter ${JSON.stringify(filter)} (available: ${allFiles.length}).`);
  process.exit(1);
}

const testFiles = files.map((file) => relative(PROJECT_ROOT, file).split(sep).join('/'));

console.log(`▶ node --test (${testFiles.length}/${allFiles.length} file${allFiles.length === 1 ? '' : 's'}) — ${process.platform} / ${process.version}`);
if (filter) console.log(`  filter: ${filter}`);

const result = spawnSync(process.execPath, ['--test', ...nodeFlags, ...testFiles], {
  cwd: PROJECT_ROOT,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`✖ Failed to start the test runner: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
