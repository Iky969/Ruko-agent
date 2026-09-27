/**
 * tree_kill.test.ts — Unit test `resolveTreeKill()` (argv builder murni) dan
 * `killProcessTree()` (eksekusi + fallback fail-safe).
 *
 * FOKUS:
 *  1. Plan/argv DETERMINISTIK lintas OS — semua platform disimulasikan lewat
 *     argumen (`platform`, `processGroup`, `force`), tanpa membaca
 *     `process.platform`, sehingga hasil tes sama di Linux/Windows/macOS CI.
 *  2. REGRESSION non-win32: perilaku lama harus tidak berubah —
 *     `process.kill(-pid, sinyal)` (process group) dan `child.kill(sinyal)`
 *     untuk child yang bukan pemimpin group (executor/external-tools).
 *  3. Fallback fail-safe: taskkill gagal (spawn error / exit ≠ 0) dan kill group
 *     gagal → `child.kill(sinyal)` dengan `usedFallback: true`.
 *
 * Tidak ada proses Windows nyata yang dijalankan; eksekusi taskkill disuntik
 * lewat `runTaskkill` agar hasilnya deterministik di semua OS.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  TASKKILL_BINARY,
  killProcessTree,
  resolveTreeKill,
  type TreeKillFallbackReason,
  type TreeKillTarget,
} from '../core/treeKill.js';

/** Handle child palsu yang mencatat sinyal yang diterima. */
function makeFakeChild(result = true) {
  const signals: (NodeJS.Signals | number | undefined)[] = [];
  const child: TreeKillTarget & { signals: typeof signals } = {
    signals,
    kill(signal?: NodeJS.Signals | number): boolean {
      signals.push(signal);
      return result;
    },
  };
  return child;
}

/** Handle child palsu yang selalu melempar (mis. ESRCH). */
function makeThrowingChild() {
  const child: TreeKillTarget = {
    kill(): boolean {
      throw new Error('ESRCH');
    },
  };
  return child;
}

/** Pencatat sysKill (pengganti process.kill). */
function makeSysKill(options: { throws?: boolean } = {}) {
  const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const sysKill = (pid: number, signal: NodeJS.Signals): void => {
    calls.push({ pid, signal });
    if (options.throws) throw new Error('ESRCH');
  };
  return { sysKill, calls };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // Proses zombie (sudah mati tapi belum di-reap) tetap menjawab kill(pid, 0).
  // Di container PID 1 belum tentu me-reap orphan, jadi state dicek eksplisit.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    const state = stat.slice(end + 2, end + 3);
    if (state === 'Z' || state === 'X') return false;
  } catch {
    // bukan Linux / procfs tidak tersedia → anggap hidup
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// A. resolveTreeKill — argv builder murni & deterministik lintas OS
// ─────────────────────────────────────────────────────────────────────────────

test('resolveTreeKill: Windows → taskkill /PID <pid> /T /F (argv final, tanpa shell)', () => {
  const plan = resolveTreeKill(4321, { platform: 'win32' });
  assert.equal(plan.mode, 'taskkill');
  assert.equal(plan.binary, TASKKILL_BINARY);
  assert.deepEqual(plan.args, ['/PID', '4321', '/T', '/F']);
  // PID harus elemen arg terpisah (bukan digabung ke string shell) agar tidak
  // ada injeksi metakarakter; taskkill dipanggil tanpa shell.
  assert.equal(plan.args?.[0], '/PID');
  assert.equal(plan.args?.[1], '4321');
});

test('resolveTreeKill: Windows — force tidak mengubah argv (/F selalu dipakai)', () => {
  const graceful = resolveTreeKill(99, { platform: 'win32', force: false });
  const forced = resolveTreeKill(99, { platform: 'win32', force: true });
  assert.deepEqual(graceful.args, forced.args);
  assert.deepEqual(graceful.args, ['/PID', '99', '/T', '/F']);
  assert.equal(graceful.binary, forced.binary);
  // /T wajib ada: tanpa /T, grandchild tidak ikut mati.
  assert.ok(forced.args?.includes('/T'));
});

test('resolveTreeKill: argv taskkill bebas metakarakter shell & stabil 100x', () => {
  const first = resolveTreeKill(1234, { platform: 'win32' });
  const rendered = (first.args ?? []).join(' ');
  for (const meta of ['&', '|', ';', '>', '<', '$', '`']) {
    assert.ok(!rendered.includes(meta), `argv tidak boleh memuat ${meta}`);
  }
  for (let i = 0; i < 100; i++) {
    assert.deepEqual(resolveTreeKill(1234, { platform: 'win32' }), first);
  }
});

test('REGRESSION non-win32: default → process-group + SIGTERM (kill(-pid))', () => {
  for (const platform of ['linux', 'darwin', 'freebsd', 'openbsd'] as NodeJS.Platform[]) {
    const plan = resolveTreeKill(777, { platform });
    assert.equal(plan.mode, 'process-group', `platform ${platform} harus process-group`);
    assert.equal(plan.signal, 'SIGTERM');
    assert.equal(plan.binary, undefined, 'non-win32 tidak boleh memakai binary taskkill');
    assert.equal(plan.args, undefined);
  }
});

test('REGRESSION non-win32: force → process-group + SIGKILL', () => {
  for (const platform of ['linux', 'darwin'] as NodeJS.Platform[]) {
    const plan = resolveTreeKill(777, { platform, force: true });
    assert.equal(plan.mode, 'process-group');
    assert.equal(plan.signal, 'SIGKILL');
  }
});

test('REGRESSION non-win32 tanpa process group (executor/external-tools): sinyal ke child', () => {
  const graceful = resolveTreeKill(555, { platform: 'linux', processGroup: false, force: false });
  assert.equal(graceful.mode, 'child');
  assert.equal(graceful.signal, 'SIGTERM');
  const forced = resolveTreeKill(555, { platform: 'linux', processGroup: false, force: true });
  assert.equal(forced.mode, 'child');
  assert.equal(forced.signal, 'SIGKILL');
});

test('resolveTreeKill: PID tidak valid → fail-safe SIGKILL ke handle child', () => {
  for (const bad of [0, -1, -1234, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const plan = resolveTreeKill(bad, { platform: 'linux' });
    assert.equal(plan.mode, 'child', `PID ${bad} harus jatuh ke mode child`);
    assert.equal(plan.signal, 'SIGKILL');
    // Windows pun: taskkill dengan PID tak valid tidak ada gunanya.
    assert.equal(resolveTreeKill(bad, { platform: 'win32' }).mode, 'child');
  }
});

test('resolveTreeKill: murni — hasil tidak berubah oleh pemanggilan berulang, default mengikuti process.platform', () => {
  const planA = resolveTreeKill(4242, { platform: 'linux' });
  const planB = resolveTreeKill(4242, { platform: 'linux' });
  assert.deepEqual(planA, planB);
  assert.equal(planA.reason, planB.reason);

  const defaultPlan = resolveTreeKill(4242);
  if (process.platform === 'win32') {
    assert.equal(defaultPlan.mode, 'taskkill');
  } else {
    assert.equal(defaultPlan.mode, 'process-group');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// B. killProcessTree — regression non-win32 (perilaku lama tidak boleh berubah)
// ─────────────────────────────────────────────────────────────────────────────

test('REGRESSION non-win32: killProcessTree memakai kill(-pid) dan TIDAK menyentuh handle child', async () => {
  const child = makeFakeChild();
  const { sysKill, calls } = makeSysKill();

  const outcome = await killProcessTree(3210, {
    platform: 'linux',
    child,
    sysKill,
    runTaskkill: async () => {
      throw new Error('taskkill tidak boleh dipanggil di non-win32');
    },
  });

  assert.equal(outcome.mode, 'process-group');
  assert.equal(outcome.signal, 'SIGTERM');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.usedFallback, false);
  assert.deepEqual(calls, [{ pid: -3210, signal: 'SIGTERM' }]);
  assert.deepEqual(child.signals, [], 'handle child tidak boleh dipakai saat kill group sukses');
});

test('REGRESSION non-win32: force → kill(-pid, SIGKILL)', async () => {
  const { sysKill, calls } = makeSysKill();
  const outcome = await killProcessTree(3210, { platform: 'darwin', force: true, sysKill });

  assert.equal(outcome.mode, 'process-group');
  assert.equal(outcome.signal, 'SIGKILL');
  assert.deepEqual(calls, [{ pid: -3210, signal: 'SIGKILL' }]);
});

test('non-win32: kill group gagal → fallback child.kill(sinyal yang sama, bukan SIGKILL paksa)', async () => {
  const child = makeFakeChild();
  const { sysKill } = makeSysKill({ throws: true });
  const reasons: TreeKillFallbackReason[] = [];

  const outcome = await killProcessTree(888, {
    platform: 'linux',
    child,
    sysKill,
    onFallback: (r) => reasons.push(r),
  });

  // Identik dengan perilaku lama: kill(-pid, SIGTERM) gagal → child.kill('SIGTERM').
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(outcome.usedFallback, true);
  assert.equal(outcome.fallbackReason, 'group-kill-failed');
  assert.equal(outcome.mode, 'child');
  assert.equal(outcome.signal, 'SIGTERM');
  assert.deepEqual(reasons, ['group-kill-failed']);
});

test('non-win32: fallback memakai SIGKILL ketika tahap force', async () => {
  const child = makeFakeChild();
  const { sysKill } = makeSysKill({ throws: true });
  const outcome = await killProcessTree(888, {
    platform: 'linux',
    force: true,
    child,
    sysKill,
  });
  assert.deepEqual(child.signals, ['SIGKILL']);
  assert.equal(outcome.signal, 'SIGKILL');
  assert.equal(outcome.usedFallback, true);
});

test('killProcessTree: kill group gagal & child.kill melempar → ok=false, tidak crash', async () => {
  const { sysKill } = makeSysKill({ throws: true });
  const outcome = await killProcessTree(889, {
    platform: 'linux',
    child: makeThrowingChild(),
    sysKill,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.usedFallback, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// C. killProcessTree — jalur Windows (taskkill) via runner yang disuntik
// ─────────────────────────────────────────────────────────────────────────────

test('Windows: taskkill sukses (exit 0) → ok, tanpa fallback, child tidak disentuh', async () => {
  const child = makeFakeChild();
  const { sysKill, calls } = makeSysKill();
  const invocations: Array<{ binary: string; args: string[] }> = [];

  const outcome = await killProcessTree(1234, {
    platform: 'win32',
    child,
    sysKill,
    runTaskkill: async (binary, args) => {
      invocations.push({ binary, args });
      return 0;
    },
  });

  assert.equal(outcome.mode, 'taskkill');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.usedFallback, false);
  assert.deepEqual(invocations, [{ binary: 'taskkill', args: ['/PID', '1234', '/T', '/F'] }]);
  assert.deepEqual(calls, [], 'sysKill tidak dipakai di Windows');
  assert.deepEqual(child.signals, [], 'fallback tidak jalan saat taskkill sukses');
});

test('Windows: taskkill exit ≠ 0 → fallback child.kill(SIGKILL)', async () => {
  const child = makeFakeChild();
  const reasons: TreeKillFallbackReason[] = [];
  const outcome = await killProcessTree(4321, {
    platform: 'win32',
    child,
    runTaskkill: async () => 1,
    onFallback: (r) => reasons.push(r),
  });

  assert.deepEqual(child.signals, ['SIGKILL']);
  assert.equal(outcome.usedFallback, true);
  assert.equal(outcome.fallbackReason, 'taskkill-exit-nonzero');
  assert.equal(outcome.mode, 'child');
  assert.deepEqual(reasons, ['taskkill-exit-nonzero']);
});

test('Windows: taskkill gagal di-spawn (ENOENT) → fallback fail-safe', async () => {
  const child = makeFakeChild();
  const outcome = await killProcessTree(4321, {
    platform: 'win32',
    child,
    runTaskkill: async () => {
      const err: NodeJS.ErrnoException = new Error('spawn taskkill ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });

  assert.deepEqual(child.signals, ['SIGKILL']);
  assert.equal(outcome.usedFallback, true);
  assert.equal(outcome.fallbackReason, 'taskkill-spawn-error');
});

test('Windows tanpa handle child: fallback mengirim sinyal langsung ke PID', async () => {
  const { sysKill, calls } = makeSysKill();
  const outcome = await killProcessTree(4321, {
    platform: 'win32',
    child: null,
    sysKill,
    runTaskkill: async () => 128,
  });

  assert.deepEqual(calls, [{ pid: 4321, signal: 'SIGKILL' }]);
  assert.equal(outcome.usedFallback, true);
  assert.equal(outcome.ok, true);
});

test('Windows: default runTaskkill dijalankan lewat spawn (binary taskkill, stdio ignored)', async () => {
  // Sanity check bahwa default runner benar-benar men-spawn dan mengembalikan
  // exit code non-zero di Linux (taskkill tidak ada) tanpa melempar keluar.
  if (process.platform === 'win32') return; // perilaku nyata Windows diuji manual
  const child = makeFakeChild();
  const outcome = await killProcessTree(4242, { platform: 'win32', child });
  assert.equal(outcome.usedFallback, true);
  assert.ok(
    outcome.fallbackReason === 'taskkill-spawn-error' || outcome.fallbackReason === 'taskkill-exit-nonzero',
    `fallbackReason tak terduga: ${outcome.fallbackReason}`,
  );
  assert.deepEqual(child.signals, ['SIGKILL']);
});

// ─────────────────────────────────────────────────────────────────────────────
// D. killProcessTree — mode 'child' sebagai jalur utama (bukan fallback)
// ─────────────────────────────────────────────────────────────────────────────

test('REGRESSION external-tools: non-group graceful → child.kill(SIGTERM), sysKill tidak dipakai', async () => {
  const child = makeFakeChild();
  const { sysKill, calls } = makeSysKill();
  const outcome = await killProcessTree(654, {
    platform: 'linux',
    processGroup: false,
    force: false,
    child,
    sysKill,
  });

  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.deepEqual(calls, []);
  assert.equal(outcome.mode, 'child');
  assert.equal(outcome.usedFallback, false);
  assert.equal(outcome.ok, true);
});

test('non-group tanpa handle child: sinyal dikirim langsung ke PID', async () => {
  const { sysKill, calls } = makeSysKill();
  const outcome = await killProcessTree(654, {
    platform: 'linux',
    processGroup: false,
    child: null,
    sysKill,
  });
  assert.deepEqual(calls, [{ pid: 654, signal: 'SIGTERM' }]);
  assert.equal(outcome.usedFallback, false);
});

test('non-group saat child.kill melempar → fallback ok=false', async () => {
  const outcome = await killProcessTree(654, {
    platform: 'linux',
    processGroup: false,
    child: makeThrowingChild(),
  });
  assert.equal(outcome.usedFallback, true);
  assert.equal(outcome.fallbackReason, 'child-kill-threw');
  assert.equal(outcome.ok, false);
});

test('PID tidak valid → fallback invalid-pid (tidak menyentuh taskkill)', async () => {
  let taskkillCalled = false;
  const outcome = await killProcessTree(0, {
    platform: 'win32',
    runTaskkill: async () => {
      taskkillCalled = true;
      return 0;
    },
  });
  assert.equal(taskkillCalled, false);
  assert.equal(outcome.usedFallback, true);
  assert.equal(outcome.fallbackReason, 'invalid-pid');
});

test('GUARD KEAMANAN: PID ≤ 0 tidak pernah dikirim ke process.kill (kill(0) = seluruh group)', async () => {
  // `process.kill(0, …)` berarti seluruh process group PEMANGGIL dan
  // `kill(-n, …)` berarti process group lain — PID tak valid harus di-no-op.
  for (const badPid of [0, -1, -3210, 2.5, Number.NaN]) {
    const { sysKill, calls } = makeSysKill();

    const withoutHandle = await killProcessTree(badPid, { platform: 'linux', sysKill });
    assert.deepEqual(calls, [], `sysKill tidak boleh dipanggil untuk PID ${badPid}`);
    assert.equal(withoutHandle.ok, false);
    assert.equal(withoutHandle.usedFallback, true);

    // Fallback yang dijalankan karena handle child melempar juga tidak boleh
    // mengirim sinyal ke PID tak valid.
    const { sysKill: sysKill2, calls: calls2 } = makeSysKill();
    const withThrowingChild = await killProcessTree(badPid, {
      platform: 'linux',
      sysKill: sysKill2,
      child: makeThrowingChild(),
    });
    assert.deepEqual(calls2, [], 'fallback tidak boleh memanggil sysKill untuk PID tak valid');
    assert.equal(withThrowingChild.ok, false);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Integrasi POSIX nyata: grandchild ikut mati lewat process group
// ─────────────────────────────────────────────────────────────────────────────

test('POSIX: killProcessTree membunuh grandchild lewat process group (bukan hanya child)', async () => {
  if (process.platform === 'win32') return; // dijalankan di Linux/darwin saja

  const child = spawn('/bin/sh', ['-c', 'sleep 30 & echo $! ; wait'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  try {
    let buffer = '';
    const grandchildPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout menunggu PID grandchild')), 5000);
      child.stdout?.on('data', (chunk) => {
        buffer += String(chunk);
        const match = buffer.trim().match(/^(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
    });

    assert.ok(isAlive(grandchildPid), 'grandchild harus hidup sebelum kill');

    const outcome = await killProcessTree(child.pid ?? -1, { force: true });
    assert.equal(outcome.mode, 'process-group');
    assert.equal(outcome.usedFallback, false);

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isAlive(grandchildPid)) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(isAlive(grandchildPid), false, 'grandchild harus ikut mati (process group dibunuh)');
  } finally {
    // Jaring pengaman: jangan tinggalkan proses menggantung kalau test gagal.
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* sudah mati */
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* sudah mati */
    }
  }
});

test('POSIX: PID yang tidak ada → fallback fail-safe, tidak crash', async () => {
  if (process.platform === 'win32') return;
  const outcome = await killProcessTree(Number.MAX_SAFE_INTEGER, { force: true });
  assert.equal(outcome.usedFallback, true);
  assert.equal(outcome.ok, false); // tidak ada handle child & PID tidak bisa dibunuh
  assert.equal(outcome.fallbackReason, 'group-kill-failed');
});
