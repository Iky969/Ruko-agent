/**
 * git_subcommand_class.test.ts — KELAS 1
 *
 * Klasifikasi git dari SUBCOMMAND sebenarnya (bukan regex `git <sub>` pada
 * teks mentah): wrapper launcher, assignment prefix, basename program, dan
 * global flag git (bernilai/tanpa nilai/menempel) harus dilewati lebih dulu.
 *
 * Setiap kasus memeriksa DUA tempat: detectRisk (klasifikasi) dan
 * SessionApprovalAllowlist.canRemember (exec + start_process).
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
  'git -C . reset --hard',
  'git -c user.name=x reset --hard',
  'git -C . clean -f',
  'git clean -fdx',
  'git clean -d -f -x',
  'git send-pack /tmp/a/remote.git HEAD:refs/heads/main',
  'git --attr-source HEAD push origin main',
  'git --foo bar push origin main',
  '/usr/bin/git -C . reset --hard',
  'command git -C . clean -f',
  'timeout -k 5s 10s git -C . reset --hard',
] as const;

describe('KELAS 1 — subcommand git sebenarnya: dangerous + tidak dapat diingat', () => {
  for (const command of DANGEROUS) {
    test('dangerous + canRemember false: ' + command, () => {
      const verdict = detectRisk(command, cfg());
      assert.equal(verdict.risk, 'dangerous', 'detectRisk harus dangerous: ' + command);
      assert.equal(canExec(command), false, 'canRemember(exec) harus false: ' + command);
      assert.equal(canStart(command), false, 'canRemember(start_process) harus false: ' + command);
    });
  }
});

const CONTROLS = [
  'git status',
  'git -c user.name=x status',
  'git log --oneline push',
  'git --no-pager log --oneline push',
] as const;

describe('KELAS 1 — kontrol tetap none (tanpa false positive)', () => {
  for (const command of CONTROLS) {
    test('none + canRemember(exec) false: ' + command, () => {
      assert.equal(detectRisk(command, cfg()).risk, 'none', 'harus none: ' + command);
      assert.equal(canExec(command), false, 'canRemember(exec) harus false: ' + command);
      assert.equal(canStart(command), true, 'canRemember(start_process) harus true (kontrak lama): ' + command);
    });
  }
});
