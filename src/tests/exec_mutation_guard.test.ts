/**
 * WP-03 (v2.1.0) — Unifikasi Pemeriksaan Eksekusi Shell & Mutasi Workspace
 *
 * DoD: "Perintah echo \"x\" > file dan sed -i terdeteksi sebagai mutasi;
 *        /exec printenv terblokir."
 *
 * Fail-closed: efek sistem berkas yang tidak bisa dianalisis dengan pasti
 * (redirect tanpa target, in-place writer tanpa target) diperlakukan sebagai
 * mutasi berisiko.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../core/context.js';
import { DEFAULT_CONFIG } from '../types.js';
import { detectWorkspaceMutationInExec, safeExecPrecheck } from '../agent/tools.js';

function withWorkspace<T>(fn: (ws: string) => Promise<T> | T): Promise<T> {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-exec-mut-'));
  return Promise.resolve(fn(ws)).finally(() => rmSync(ws, { recursive: true, force: true }));
}

test('WP-03: redirect berisi teks (`echo "x" > file`) terdeteksi sebagai mutasi workspace', () => {
  return withWorkspace((ws) => {
    const res = detectWorkspaceMutationInExec('echo "x" > out.txt', ws);
    assert.equal(res.blocked, true);
    assert.deepEqual(res.targets, ['out.txt']);
    assert.match(res.message ?? '', /write_file/);

    const append = detectWorkspaceMutationInExec('printf halo >> catatan/log.txt', ws);
    assert.equal(append.blocked, true);
    assert.deepEqual(append.targets, ['catatan/log.txt']);
  });
});

test('WP-03: utilitas penulis berkas (sed -i, tee, dd, awk -i, patch) terdeteksi', () => {
  return withWorkspace((ws) => {
    const cases: Array<[string, string]> = [
      ["sed -i 's/lama/baru/' src/config.ts", 'src/config.ts'],
      ['tee src/log.txt', 'src/log.txt'],
      ['dd if=/dev/zero of=src/blob.bin bs=1M count=1', 'src/blob.bin'],
      ["awk -i inplace '{print}' src/data.txt", 'src/data.txt'],
      ['patch -p1 src/app.diff', 'src/app.diff'],
    ];
    for (const [cmd, target] of cases) {
      const res = detectWorkspaceMutationInExec(cmd, ws);
      assert.equal(res.blocked, true, `harus terdeteksi: ${cmd}`);
      assert.ok(res.targets?.includes(target), `target ${target} harus terdeteksi: ${cmd}`);
    }
  });
});

test('WP-03: redirect ke luar workspace & duplikasi file descriptor tetap diizinkan', () => {
  return withWorkspace((ws) => {
    assert.equal(detectWorkspaceMutationInExec('npm test > /tmp/ruko-out.log', ws).blocked, false);
    assert.equal(detectWorkspaceMutationInExec('node build.js 2>&1', ws).blocked, false);
    assert.equal(detectWorkspaceMutationInExec('node build.js >> /dev/null', ws).blocked, false);
    // `>` di dalam string literal BUKAN operator pengalihan
    assert.equal(detectWorkspaceMutationInExec('echo "a > b"', ws).blocked, false);
    assert.equal(detectWorkspaceMutationInExec('grep "->" src/index.ts', ws).blocked, false);
  });
});

test('WP-03: command read-only biasa tidak diblokir', () => {
  return withWorkspace((ws) => {
    for (const cmd of ['ls -la', 'npm test', 'git status', 'cat package.json', 'node --version']) {
      assert.equal(detectWorkspaceMutationInExec(cmd, ws).blocked, false, `harus lolos: ${cmd}`);
    }
  });
});

test('WP-03: safeExecPrecheck adalah pintu masuk tunggal — printenv diblokir', () => {
  return withWorkspace((ws) => {
    const env = safeExecPrecheck('printenv', ws);
    assert.equal(env.blocked, true);
    assert.match(env.message ?? '', /environment variable sensitif/i);

    const mutation = safeExecPrecheck('sed -i s/a/b/ src/x.ts', ws);
    assert.equal(mutation.blocked, true);
    assert.deepEqual(mutation.targets, ['src/x.ts']);

    assert.equal(safeExecPrecheck('echo hi', ws).blocked, false);
  });
});

test('WP-03: slash command /exec memakai precheck yang sama — `printenv` tidak dijalankan', async () => {
  const { handleCommand } = await import('../agent/commands.js');
  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(' '));
  };

  const env: any = {
    ctx,
    config,
    llm: { name: 'test', model: 'test-model', isConfigured: false, setModel() {}, setCredentials() {} },
    confirm: async () => true,
    updateConfig: () => {},
    handle: { stop() {}, getSessionId: () => null, setSessionId() {} },
  };

  try {
    await handleCommand('/exec printenv', env);
    const out = logged.join('\n');
    assert.match(out, /ditolak/i, 'printenv harus ditolak oleh /exec');
    assert.equal(out.includes('PATH='), false, 'environment tidak boleh tercetak');
    assert.equal(out.includes('[exit code'), false, 'perintah tidak boleh benar-benar dijalankan');
  } finally {
    console.log = originalLog;
  }
});
