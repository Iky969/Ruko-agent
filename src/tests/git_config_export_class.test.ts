/**
 * git_config_export_class.test.ts — KELAS 2
 *
 * 2a. `git config` yang MENULIS key di luar allowlist (user.*, color.*)
 *     menginjeksi config yang dieksekusi git (core.fsmonitor, alias.*,
 *     core.sshCommand, ...). Parser subcommand KELAS 1 dipakai agar bentuk
 *     `git -C . config ...` ikut terdeteksi.
 * 2b. Builtin `export` dengan KEY `GIT_*` menyuntikkan config/eksekusi git
 *     untuk perintah berikutnya di segmen yang sama.
 *
 * Setiap kasus memeriksa detectRisk DAN canRemember (exec + start_process).
 */
import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectRisk } from '../core/approval.js';
import { SessionApprovalAllowlist } from '../core/approval/sessionAllowlist.js';
import type { AgentConfig } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

const WS = process.cwd();

function cfg(): AgentConfig {
  return { ...DEFAULT_CONFIG, approvalEnabled: true };
}

function canExec(command: string): boolean {
  return new SessionApprovalAllowlist().canRemember(command, {
    kind: 'exec', cwd: WS, workspaceRoot: WS, command,
  });
}

function canStart(command: string): boolean {
  return new SessionApprovalAllowlist().canRemember(`start_process ${command}`, {
    kind: 'start_process', cwd: WS, workspaceRoot: WS, command,
  });
}

const DANGEROUS = [
  'git config core.fsmonitor "touch /tmp/a/M" && git status',
  'git config alias.p push && git p origin main',
  'git config --replace-all core.sshCommand "touch /tmp/a/M"',
  'git -C . config alias.p push',
  'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0="touch /tmp/a/M" && git status',
  'export FOO=1 GIT_SSH_COMMAND="touch /tmp/a/M" && git fetch ssh://127.0.0.1/tmp/a/remote.git',
  'export FOO=1 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0="touch /tmp/a/M" && git status',
] as const;

describe('KELAS 2 — config tersimpan & export GIT_*: dangerous + tidak dapat diingat', () => {
  for (const command of DANGEROUS) {
    test('dangerous + canRemember false: ' + command, () => {
      assert.equal(detectRisk(command, cfg()).risk, 'dangerous', 'detectRisk harus dangerous: ' + command);
      assert.equal(canExec(command), false, 'canRemember(exec) harus false: ' + command);
      assert.equal(canStart(command), false, 'canRemember(start_process) harus false: ' + command);
    });
  }
});

describe('KELAS 2 — baca config dan export non-GIT tetap none', () => {
  // Nilai kedua: canRemember(start_process). Kontrak lama hanya dapat mengingat
  // perintah tanpa kutip/operator, jadi bentuk ber-kutip tetap false (unchanged).
  const noneControls: Array<[string, boolean]> = [
    ['git config user.name "John Doe"', false],
    ['git config user.name John', true],
    ['git config --get core.fsmonitor', true],
    ['git config --list', true],
    ['echo x && git status', false],
    ['export FOO=bar && git status', false],
    ['export FOO=bar BAR=baz && git status', false],
    ['export FOO=bar', true],
    ['export FOO=1 BAR=2', true],
  ];

  for (const [command, startRememberable] of noneControls) {
    test('none + canRemember(exec) false: ' + command, () => {
      assert.equal(detectRisk(command, cfg()).risk, 'none', 'harus none: ' + command);
      assert.equal(canExec(command), false, 'canRemember(exec) harus false: ' + command);
      assert.equal(canStart(command), startRememberable, 'canRemember(start_process): ' + command);
    });
  }
});
