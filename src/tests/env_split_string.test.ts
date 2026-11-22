/**
 * Issue #38 lanjutan — wrapper `env -S` / `env --split-string`.
 *
 * `env -S 'git push origin main'` menyuruh env memecah satu argumen string
 * menjadi argv, sehingga program dan argumen nyata TIDAK terlihat oleh
 * deteksi pola (isi string tidak pernah di-parse sebagai perintah). Bentuk ini
 * harus fail-closed: DANGEROUS dan tidak boleh diingat sebagai "always", tanpa
 * membaca isi string.
 *
 * ZERO dependency — hanya `node:*`.
 */
import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRisk } from '../core/approval.js';
import { SessionApprovalAllowlist, type ApprovalRequest } from '../core/approval/sessionAllowlist.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../types.js';

function cfg(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...DEFAULT_CONFIG, approvalEnabled: true, ...overrides };
}

const SPLIT_CASES = [
  "env -S 'git -C . push origin main'",
  "env -S 'git reset --hard'",
  "env --split-string='git push origin main'",
  "env --split-string 'git reset --hard'",
  "env -S 'touch /tmp/env-a/M'",
  'env -S \'bash -c "touch /tmp/env-a/M"\'',
  "/usr/bin/env -S 'git -C . push origin main'",
  "timeout 5 env -S 'git push origin main'",
  "env -iS 'git push origin main'",
] as const;

const CONTROLS = [
  'env FOO=1 git status',
  'env -i git status',
  'env -u HOME git status',
  'env git status',
] as const;

describe('env -S / --split-string — fail-closed sebagai DANGEROUS', () => {
  for (const command of SPLIT_CASES) {
    test('DANGEROUS: ' + command, () => {
      assert.equal(detectRisk(command, cfg()).risk, 'dangerous', 'harus dangerous: ' + command);
    });
  }
});

describe('env -S / --split-string — tidak boleh diingat sebagai "always"', () => {
  test('exec & start_process menolak "always"', (t) => {
    const ws = mkdtempSync(join(tmpdir(), 'ruko-env-split-'));
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    const allowlist = new SessionApprovalAllowlist();
    for (const command of SPLIT_CASES) {
      for (const kind of ['exec', 'start_process'] as const) {
        const request: ApprovalRequest = { kind, cwd: ws, workspaceRoot: ws, command };
        const display = kind === 'start_process' ? `start_process ${command}` : command;
        assert.equal(allowlist.canRemember(display, request), false,
          kind + ': "' + command + '" tidak boleh ditawarkan sebagai always');
        assert.equal(allowlist.remember(display, request), false,
          kind + ': "' + command + '" tidak boleh tersimpan');
      }
    }
  });
});

describe('env -S / --split-string — kontrol tanpa split-string tetap none', () => {
  for (const command of CONTROLS) {
    test('NONE: ' + command, () => {
      assert.equal(detectRisk(command, cfg()).risk, 'none', 'harus tetap none: ' + command);
    });
  }

  test('exec tidak rememberable, start_process tetap rememberable (kontrak lama)', (t) => {
    const ws = mkdtempSync(join(tmpdir(), 'ruko-env-split-ok-'));
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    const allowlist = new SessionApprovalAllowlist();
    for (const command of CONTROLS) {
      const execRequest: ApprovalRequest = { kind: 'exec', cwd: ws, workspaceRoot: ws, command };
      assert.equal(allowlist.canRemember(command, execRequest), false,
        'exec: perintah none tidak pernah rememberable: ' + command);
      const startRequest: ApprovalRequest = { kind: 'start_process', cwd: ws, workspaceRoot: ws, command };
      assert.equal(allowlist.canRemember('start_process ' + command, startRequest), true,
        'start_process: kontrol aman harus tetap rememberable: ' + command);
    }
  });
});
