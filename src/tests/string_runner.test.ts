/**
 * Kelas "string-runner" — program yang menjalankan perintah dari sebuah
 * string atau dari stdin: shell `-c`, `script`/`flock`/`su -c`, pipe ke
 * shell, dan `xargs`.
 *
 * Isi string tidak pernah di-parse (tidak ada parser semantik di sini);
 * bentuk pemanggilan inilah yang fail-closed: DANGEROUS dan tidak boleh
 * diingat sebagai "always".
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

const RUNNER_CASES = [
  "bash -c 'echo hi'",
  "sh -c 'echo hi'",
  "bash -lc 'echo hi'",
  "timeout 5 bash -c 'echo hi'",
  "nohup sh -c 'echo hi'",
  '/bin/bash -c "g\'\'it -C . push origin main"',
  "bash -c 'g\\it -C . push origin main'",
  "script -qc 'echo hi' /dev/null",
  "flock /tmp/x.lock -c 'echo hi'",
  "su -c 'echo hi'",
  "echo 'echo hi' | sh",
  "echo 'echo hi' | /bin/sh",
  "echo 'echo hi' | env sh",
  "echo 'echo hi' | sh -e",
  'echo main | xargs -I{} git -C . push origin {}',
  'xargs touch',
] as const;

const CONTROLS = [
  'git status',
  'env FOO=1 git status',
  'ls -la',
  'cat README.md',
  'grep -c x README.md',
] as const;

describe('string-runner — fail-closed sebagai DANGEROUS', () => {
  for (const command of RUNNER_CASES) {
    test('DANGEROUS: ' + command, () => {
      assert.equal(detectRisk(command, cfg()).risk, 'dangerous', 'harus dangerous: ' + command);
    });
  }
});

describe('string-runner — tidak boleh diingat sebagai "always"', () => {
  test('exec & start_process menolak "always"', (t) => {
    const ws = mkdtempSync(join(tmpdir(), 'ruko-str-'));
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    const allowlist = new SessionApprovalAllowlist();
    for (const command of RUNNER_CASES) {
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

describe('string-runner — kontrol tetap none dan start_process rememberable', () => {
  for (const command of CONTROLS) {
    test('NONE: ' + command, () => {
      assert.equal(detectRisk(command, cfg()).risk, 'none', 'harus tetap none: ' + command);
    });
  }

  test('exec tidak rememberable, start_process tetap rememberable (kontrak lama)', (t) => {
    const ws = mkdtempSync(join(tmpdir(), 'ruko-str-ok-'));
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
