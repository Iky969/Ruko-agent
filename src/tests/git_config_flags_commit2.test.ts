/**
 * Issue #38 lanjutan — COMMIT 2: `-c` dan `--config-env` (spasi dan tempel).
 *
 * `git -c <key>=<value>` dan `git --config-env <key>=<ENV>` menyuntikkan config
 * ke perintah git apa pun (mis. `core.fsmonitor` menjalankan program). Bentuk
 * tempel `-c<key>=<value>` juga diterima git versi lain, jadi klasifikasi tidak
 * boleh bergantung pada penolakan versi git lokal. Hanya key `user.*` dan
 * `color.*` (case-insensitive) yang tetap `none`; subcommand harus tetap
 * diperiksa setelah key allowlist (`git -c user.name=x push` = push).
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

describe('COMMIT 2 — -c / --config-env dengan key non-allowlist adalah DANGEROUS', () => {
  const dangerous = [
    'git -c core.fsmonitor="touch /tmp/M" status',
    'git -ccore.fsmonitor=/tmp/M status',
    'git -calias.p=push p origin main',
    'git -ccolor.ui=never status',
    'git -cuser.name=x status',
    'git --config-env=core.fsmonitor=EV status',
    'git --config-env core.fsmonitor=EV status',
    'git --config-env=core.fsmonitor=EV log -1',
    'git -c core.hooksPath=/tmp/hooks log -1',
    'nohup git -c core.fsmonitor=/tmp/M status',
  ] as const;

  for (const command of dangerous) {
    test('DANGEROUS: ' + command, () => {
      assert.equal(detectRisk(command, cfg()).risk, 'dangerous', 'harus dangerous: ' + command);
    });
  }

  test('DANGEROUS: -c user.name=x push origin main (key allowlist tetap periksa subcommand)', () => {
    const verdict = detectRisk('git -c user.name=x push origin main', cfg());
    assert.equal(verdict.risk, 'dangerous');
    assert.equal(verdict.reason, 'git push (mengubah remote repository)');
  });
});

describe('COMMIT 2 — kontrol tetap NONE', () => {
  const stillNone = [
    'git -c user.name=x status',
    'git -c color.ui=never log -1',
    'git -c user.name="John Doe" status',
    'git -C . status',
  ] as const;

  for (const command of stillNone) {
    test('NONE: ' + command, () => {
      assert.equal(detectRisk(command, cfg()).risk, 'none', 'harus none: ' + command);
    });
  }
});

describe('COMMIT 2 — -c / --config-env tidak boleh diingat sebagai "always"', () => {
  test('key berbahaya dan bentuk tempel ditolak; key allowlist non-push tetap boleh', (t) => {
    const ws = mkdtempSync(join(tmpdir(), 'ruko-gitconfig-'));
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    const allowlist = new SessionApprovalAllowlist();

    const denied = [
      'git -c core.fsmonitor=/tmp/M status',
      'git -ccore.fsmonitor=/tmp/M status',
      'git -ccolor.ui=never status',
      'git -calias.p=push p origin main',
      'git --config-env=core.fsmonitor=EV status',
      'git --config-env core.fsmonitor=EV status',
      'git -c user.name=x push origin main',
    ] as const;
    for (const command of denied) {
      for (const kind of ['exec', 'start_process'] as const) {
        const request: ApprovalRequest = { kind, cwd: ws, workspaceRoot: ws, command };
        const display = kind === 'start_process' ? `start_process ${command}` : command;
        assert.equal(allowlist.canRemember(display, request), false,
          `${kind}: "${command}" tidak boleh ditawarkan sebagai always`);
        assert.equal(allowlist.remember(display, request), false,
          `${kind}: "${command}" tidak boleh tersimpan`);
      }
    }

    for (const command of ['git -c user.name=x status', 'git -c color.ui=never log -1'] as const) {
      const request: ApprovalRequest = { kind: 'start_process', cwd: ws, workspaceRoot: ws, command };
      const display = `start_process ${command}`;
      assert.equal(allowlist.canRemember(display, request), true, `kontrol positif: ${command}`);
      assert.equal(allowlist.remember(display, request), true, command);
    }
  });
});
