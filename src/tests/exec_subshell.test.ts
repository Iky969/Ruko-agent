/**
 * WP-03 (v2.1.0) — Pembongkaran Subshell Interpreter `-c`
 *
 * DoD: `bash -c "printenv"` ditolak.
 *
 * Argumen di dalam tanda kutip untuk `bash -c`, `sh -c`, `zsh -c`, dan
 * `dash -c` wajib dibongkar SEBELUM dilempar ke pemeriksaan environment
 * sensitif dan filter berkas sensitif.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectSensitiveFileAccessInExec,
  isSensitiveEnvCommand,
  safeExecPrecheck,
} from '../agent/tools.js';

function withWorkspace<T>(fn: (ws: string) => Promise<T> | T): Promise<T> {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-exec-sub-'));
  return Promise.resolve(fn(ws)).finally(() => rmSync(ws, { recursive: true, force: true }));
}

test('WP-03: bash -c "printenv" dan varian interpreter lain ditolak', () => {
  const denied = [
    'bash -c "printenv"',
    "bash -c 'printenv'",
    'sh -c "env"',
    'zsh -c "printenv RUKO_API_KEY"',
    'dash -c "printenv"',
    'bash -lc "printenv"',
  ];
  for (const cmd of denied) {
    assert.equal(isSensitiveEnvCommand(cmd), true, `harus ditolak: ${cmd}`);
  }
});

test('WP-03: isi berkas sensitif di dalam -c juga terdeteksi', () => {
  return withWorkspace((ws) => {
    assert.equal(detectSensitiveFileAccessInExec('bash -c "cat .ruko/config.json"', ws).blocked, true);
    assert.equal(detectSensitiveFileAccessInExec('sh -c "cat .env"', ws).blocked, true);
  });
});

test('WP-03: safeExecPrecheck menolak bash -c printenv tetapi meloloskan -c bening', () => {
  return withWorkspace((ws) => {
    const blocked = safeExecPrecheck('bash -c "printenv"', ws);
    assert.equal(blocked.blocked, true);

    assert.equal(safeExecPrecheck('bash -c "echo halo"', ws).blocked, false);
    assert.equal(safeExecPrecheck('sh -c "ls -la"', ws).blocked, false);
  });
});

test('WP-03: subshell $(...) dan pipe ke interpreter tetap dianalisis', () => {
  return withWorkspace((ws) => {
    assert.equal(isSensitiveEnvCommand('echo "$(printenv)"'), true);
    assert.equal(isSensitiveEnvCommand('X=$(printenv RUKO_API_KEY); echo $X'), true);
    assert.equal(detectSensitiveFileAccessInExec('bash -c "$(cat .ruko/config.json)"', ws).blocked, true);
  });
});
