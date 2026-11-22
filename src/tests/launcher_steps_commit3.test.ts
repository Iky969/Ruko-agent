/**
 * Issue #38 lanjutan — COMMIT 3: pengupas wrapper (sessionAllowlist).
 *
 * Dua celah pada `effectiveCommand()`:
 *  - batas MAX_LAUNCHER_STEPS habis sementara token berikutnya MASIH assignment
 *    (`A=1 … I=9 git push …`) → program efektif dianggap `I=9`, guard git-push
 *    tidak melihat `git push`;
 *  - flag wrapper yang tidak dikenal (mis. `timeout -Z 5`) dilewati diam-diam
 *    sehingga program efektif salah tebak.
 * Keduanya harus fail-closed: `canRemember: false`. Kontrol aman (`nohup npm
 * test`) tetap boleh diingat.
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

describe('COMMIT 3 — batas langkah wrapper / assignment habis → fail-closed', () => {
  test('push yang disembunyikan di balik 9 assignment tidak bisa diingat', (t) => {
    const ws = mkdtempSync(join(tmpdir(), 'ruko-launcher-'));
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    const allowlist = new SessionApprovalAllowlist();

    const denied = [
      'A=1 B=2 C=3 D=4 E=5 F=6 G=7 H=8 I=9 git push origin main',
      'A=1 B=2 C=3 D=4 E=5 F=6 G=7 H=8 I=9 git -C . push origin main',
      'timeout -k 5s 10s git push origin main',
      'timeout -k 5s 10s git -C . push origin main',
    ] as const;
    for (const command of denied) {
      for (const kind of ['start_process', 'exec'] as const) {
        const request: ApprovalRequest = { kind, cwd: ws, workspaceRoot: ws, command };
        const display = kind === 'start_process' ? `start_process ${command}` : command;
        assert.equal(allowlist.canRemember(display, request), false,
          `${kind}: "${command}" tidak boleh ditawarkan sebagai always`);
        assert.equal(allowlist.remember(display, request), false,
          `${kind}: "${command}" tidak boleh tersimpan`);
      }
    }

    // Varian gabungan wajib juga ber-verdict dangerous.
    assert.equal(detectRisk('A=1 B=2 C=3 D=4 E=5 F=6 G=7 H=8 I=9 git -C . push origin main', cfg()).risk, 'dangerous');
    assert.equal(detectRisk('timeout -k 5s 10s git -C . push origin main', cfg()).risk, 'dangerous');
  });

  test('flag wrapper tidak dikenal → fail-closed', (t) => {
    const ws = mkdtempSync(join(tmpdir(), 'ruko-launcher-flag-'));
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    const allowlist = new SessionApprovalAllowlist();

    const denied = [
      'timeout -Z 5 git status',
      'timeout --bogus 5 git status',
      'env --bogus git status',
      'nohup -Z git status',
      'nice --bogus 5 git status',
    ] as const;
    for (const command of denied) {
      const request: ApprovalRequest = { kind: 'start_process', cwd: ws, workspaceRoot: ws, command };
      assert.equal(allowlist.canRemember(`start_process ${command}`, request), false,
        `"${command}" tidak boleh ditawarkan sebagai always`);
      assert.equal(allowlist.remember(`start_process ${command}`, request), false,
        `"${command}" tidak boleh tersimpan`);
    }
  });

  test('kontrol: wrapper/flag yang dikenal tetap rememberable', (t) => {
    const ws = mkdtempSync(join(tmpdir(), 'ruko-launcher-ok-'));
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    const allowlist = new SessionApprovalAllowlist();

    const allowed = [
      'nohup npm test',
      'nohup git status',
      'timeout 5 git status',
      'timeout -k 5s 10s git status',
      'env git status',
      'stdbuf -oL git status',
      'nice -n 5 git status',
      'A=1 git status',
    ] as const;
    for (const command of allowed) {
      const request: ApprovalRequest = { kind: 'start_process', cwd: ws, workspaceRoot: ws, command };
      assert.equal(allowlist.canRemember(`start_process ${command}`, request), true,
        `kontrol positif: "${command}" harus tetap rememberable`);
      assert.equal(allowlist.remember(`start_process ${command}`, request), true, command);
    }
  });
});
