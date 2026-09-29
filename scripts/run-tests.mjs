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

import { spawn } from 'node:child_process';
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

// ─── Watchdog anti-hang (temuan CI Windows: suite menggantung >19 menit) ───
// Satu file test yang menggantung (spawn/pipe yang tak selesai) membekukan
// SELURUH runner sampai job-level timeout 20 menit memakan sisa budget job.
// `--test-timeout` (Node 18.24+/20.15+) membatasi DURASI per test; watchdog
// idle membatasi JEDA tanpa output sama sekali — penutup total untuk semua
// bentuk hang, di semua versi Node ≥ 18.
const STREAM_IDLE_TIMEOUT_MS = 60_000; // 1 menit tanpa output → panic

const versionParts = process.version.slice(1).split('.').map(Number);
const nodeMajor = versionParts[0] ?? 0;
const nodeMinor = versionParts[1] ?? 0;
const supportsTestTimeout =
  nodeMajor > 20 || (nodeMajor === 20 && nodeMinor >= 15) || (nodeMajor === 18 && nodeMinor >= 24);

let idleTimer = null;
const armIdleTimer = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.error(`\n✖ Watchdog: tidak ada output dari test runner selama ${STREAM_IDLE_TIMEOUT_MS / 1000}s — kemungkinan test menggantung; runner dibunuh.`);
    try {
      child.kill('SIGKILL');
    } catch {}
  }, STREAM_IDLE_TIMEOUT_MS);
};

// Output di-stream LIVE (seperti stdio:'inherit') sekaligus dikumpulkan supaya
// kegagalan bisa dilaporkan sebagai annotation CI — job log GitHub Action tidak
// selalu mudah diakses/dibaca, sedangkan annotation muncul langsung di PR.
// Catatan: memakai `spawn` (streaming), BUKAN `spawnSync` — buffer `spawnSync`
// dibatasi maxBuffer (default 1 MB) dan suite ini mencetak output TAP jauh lebih
// besar dari itu, sehingga test runner akan terpotong/killed tanpa pesan jelas.
const IN_GITHUB_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
const collected = [];
const MAX_LINES = 20_000;

const capture = (chunk, stream) => {
  stream.write(chunk);
  for (const line of String(chunk).split('\n')) {
    if (collected.length < MAX_LINES) collected.push(line);
  }
};

const testRunnerArgs = supportsTestTimeout
  ? ['--test', '--test-timeout=60000', ...nodeFlags, ...testFiles]
  : ['--test', ...nodeFlags, ...testFiles];

const child = spawn(process.execPath, testRunnerArgs, {
  cwd: PROJECT_ROOT,
  stdio: ['inherit', 'pipe', 'pipe'],
});

armIdleTimer();
child.stdout?.on('data', (chunk) => {
  armIdleTimer();
  capture(chunk, process.stdout);
});
child.stderr?.on('data', (chunk) => {
  armIdleTimer();
  capture(chunk, process.stderr);
});

const exitCode = await new Promise((resolvePromise) => {
  child.on('error', (err) => {
    console.error(`✖ Failed to start the test runner: ${err.message}`);
    resolvePromise(1);
  });
  child.on('close', (code, signal) => {
    if (idleTimer) clearTimeout(idleTimer);
    if (signal) {
      console.error(`✖ Test runner killed by signal ${signal}`);
      resolvePromise(1);
      return;
    }
    resolvePromise(code ?? 1);
  });
});

if (exitCode !== 0) {
  // TAP: baris kegagalan berbentuk "<indentasi>not ok <n> - <nama test>".
  const failedTests = collected
    .map((line) => line.match(/^\s*not ok\s+\d+\s*-\s*(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => m[1].trim());

  const summary = collected.filter((line) => /^#\s+(tests|pass|fail|skipped)\b/.test(line));
  const unique = [...new Set(failedTests)].slice(0, 40);

  console.error('\n✖ Ringkasan kegagalan:');
  for (const name of unique.length > 0 ? unique : ['(tidak ada baris "not ok" terdeteksi — periksa output di atas)']) {
    console.error(`   • ${name}`);
  }

  if (IN_GITHUB_ACTIONS) {
    // ::error:: memunculkan annotation pada check run → nama test yang gagal
    // terlihat di UI PR tanpa harus menggali log mentah.
    const escape = (text) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    const platform = `${process.platform}-node-${process.version}`;
    for (const name of unique.slice(0, 20)) {
      console.log(`::error title=Test gagal (${platform})::${escape(name)}`);
    }
    if (unique.length > 20) {
      console.log(`::error title=Test gagal (${platform})::+${unique.length - 20} test gagal lainnya (lihat log job)`);
    }
    if (summary.length > 0) {
      console.log(`::notice title=Ringkasan test (${platform})::${escape(summary.join(' | '))}`);
    }
  }
}

process.exit(exitCode);
