/**
 * Issue #38 lanjutan — COMMIT 1: env GIT_* (inline dan diwarisi).
 *
 * `GIT_CONFIG_COUNT/KEY_n/VALUE_n`, `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF`, dan
 * kawan-kawannya dibaca git SEBELUM perintah dijalankan (config injection,
 * eksekusi ssh/diff driver, pager/editor). Assignment inline harus berhenti
 * sebagai DANGEROUS dan tidak boleh ditawarkan sebagai "always"; env yang
 * diwariskan lewat `execute()` harus dibuang sebelum child dibuat.
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
import { execute } from '../core/executor.js';
import { DEFAULT_CONFIG, type AgentConfig } from '../types.js';

function cfg(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...DEFAULT_CONFIG, approvalEnabled: true, ...overrides };
}

/**
 * Probe env portabel: jalankan node yang sama secara langsung (`-e`) dan tulis
 * `process.env` sebagai JSON ke stdout. Tidak memakai `$VAR`/`printf` shell,
 * jadi hasilnya sama di POSIX dan di Windows — cmd.exe TIDAK mengekspansi
 * `$VAR`, sehingga probe shell lama membaca nilai mentah tanpa ekspansi.
 */
function envProbeCommand(): string {
  return `"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.env))"`;
}

/** Parse output probe; gagal dengan output mentah bila stdout bukan JSON. */
function parseEnvProbe(stdout: string): NodeJS.ProcessEnv {
  try {
    return JSON.parse(stdout.trim()) as NodeJS.ProcessEnv;
  } catch {
    assert.fail('output probe env bukan JSON: ' + stdout);
  }
}

describe('COMMIT 1 — assignment env GIT_* inline adalah DANGEROUS', () => {
  const dangerous = [
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0="touch /tmp/M" git status',
    'A=1 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0="touch /tmp/M" git status',
    'env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0="touch /tmp/M" git status',
    'GIT_SSH_COMMAND="touch /tmp/M" git fetch ssh://127.0.0.1/repo',
    'env GIT_SSH_COMMAND="touch /tmp/M" git fetch ssh://127.0.0.1/repo',
    'A=1 GIT_SSH_COMMAND="touch /tmp/M" git fetch ssh://127.0.0.1/repo',
    'GIT_EXTERNAL_DIFF="touch /tmp/M" git diff',
    'nohup GIT_EXTERNAL_DIFF="touch /tmp/M" git diff',
  ] as const;

  for (const command of dangerous) {
    test('DANGEROUS: ' + command, () => {
      assert.equal(detectRisk(command, cfg()).risk, 'dangerous', 'harus dangerous: ' + command);
    });
  }

  test('kontrol: assignment non-GIT_* tidak menaikkan verdict', () => {
    assert.equal(detectRisk('A=1 git status', cfg()).risk, 'none');
    assert.equal(detectRisk('git status', cfg()).risk, 'none');
  });
});

describe('COMMIT 1 — GIT_* inline di TENGAH rantai segmen tetap DANGEROUS', () => {
  const dangerous = [
    'echo x && GIT_SSH_COMMAND="touch /tmp/ruko-b/M" git fetch origin',
    'echo x ; GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0="touch /tmp/ruko-b/M" git status',
    'echo x | GIT_EXTERNAL_DIFF=foo git diff',
  ] as const;

  for (const command of dangerous) {
    test('DANGEROUS: ' + command, () => {
      assert.equal(detectRisk(command, cfg()).risk, 'dangerous', 'harus dangerous: ' + command);
    });
  }

  test('kontrol: rantai tanpa GIT_* tetap none', () => {
    assert.equal(detectRisk('echo x && git status', cfg()).risk, 'none');
  });
});

describe('COMMIT 1 — assignment env GIT_* tidak boleh diingat sebagai "always"', () => {
  const denied = [
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0="touch /tmp/M" git status',
    'A=1 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0="touch /tmp/M" git status',
    'env GIT_SSH_COMMAND="touch /tmp/M" git status',
    'GIT_SSH_COMMAND="ssh -i key" git status',
    'GIT_EXTERNAL_DIFF=touch git diff',
    'nohup GIT_EXTERNAL_DIFF=touch git diff',
  ] as const;

  test('exec & start_process menolak "always"', (t) => {
    const ws = mkdtempSync(join(tmpdir(), 'ruko-env-git-'));
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    const allowlist = new SessionApprovalAllowlist();
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
  });

  test('kontrol: assignment biasa tetap rememberable', (t) => {
    const ws = mkdtempSync(join(tmpdir(), 'ruko-env-git-ok-'));
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    const allowlist = new SessionApprovalAllowlist();
    const command = 'A=1 git status';
    const request: ApprovalRequest = { kind: 'start_process', cwd: ws, workspaceRoot: ws, command };
    assert.equal(allowlist.canRemember(`start_process ${command}`, request), true);
  });
});

describe('COMMIT 1 — executor membuang env GIT_* berbahaya (prefix-aware)', () => {
  const injected: NodeJS.ProcessEnv = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'SENTINEL_CONFIG_VALUE',
    GIT_CONFIG_PARAMETERS: 'SENTINEL_CONFIG_PARAMS',
    GIT_SSH_COMMAND: 'SENTINEL_SSH',
    GIT_SSH_VARIANT: 'SENTINEL_SSH_VARIANT',
    GIT_ASKPASS: 'SENTINEL_ASKPASS',
    GIT_EXTERNAL_DIFF: 'SENTINEL_EXTERNAL_DIFF',
    GIT_PAGER: 'SENTINEL_PAGER',
    GIT_EDITOR: 'SENTINEL_EDITOR',
    GIT_SEQUENCE_EDITOR: 'SENTINEL_SEQUENCE_EDITOR',
    GIT_EXEC_PATH: 'SENTINEL_EXEC_PATH',
    GIT_TEMPLATE_DIR: 'SENTINEL_TEMPLATE_DIR',
    GIT_DIR: 'SENTINEL_GIT_DIR',
    GIT_WORK_TREE: 'SENTINEL_WORK_TREE',
    GIT_INDEX_FILE: 'SENTINEL_INDEX_FILE',
    GIT_NAMESPACE: 'SENTINEL_NAMESPACE',
    RUKO_KEEP_ME: 'KEEP',
  };

  test('env eksplisit: semua nilai sentinel hilang, env biasa tetap', async () => {
    const r = await execute(envProbeCommand(), { env: injected, summarize: false });
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes('SENTINEL'), 'nilai GIT_* berbahaya masih sampai ke child: ' + r.stdout);
    const childEnv = parseEnvProbe(r.stdout);
    assert.equal(childEnv.RUKO_KEEP_ME, 'KEEP', 'env biasa harus tetap diwariskan: ' + r.stdout);
  });

  test('env warisan process.env juga dibuang', async (t) => {
    const prev = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = 'SENTINEL_INHERITED';
    t.after(() => {
      if (prev === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = prev;
    });
    const r = await execute(envProbeCommand(), { summarize: false });
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes('SENTINEL_INHERITED'), 'env warisan bocor: ' + r.stdout);
  });
});
