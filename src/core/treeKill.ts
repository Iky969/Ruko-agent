/**
 * treeKill.ts — Kill proses TREE lintas platform (fix zombie grandchild Windows).
 *
 * MASALAH:
 *  - `src/agent/processManager.ts` men-spawn proses dengan `detached: true`, jadi
 *    `child.kill()` hanya membunuh proses shell (`cmd.exe /d /s /c ...`) sementara
 *    proses sebenarnya (grandchild: node/npm/dsb.) tetap hidup dan menjadi zombie.
 *  - POSIX sudah aman dengan `process.kill(-pid, sinyal)` → membunuh seluruh
 *    process group (child detached = group leader).
 *  - Windows tidak mengenal `kill(-pid)`; satu-satunya cara membunuh tree adalah
 *    `taskkill /PID <pid> /T /F`.
 *
 * DESAIN:
 *  - `resolveTreeKill()` PURE: hanya argumen → rencana (plan). Tidak membaca
 *    `process.platform`, tidak memanggil `process.kill`, tidak spawn apa pun,
 *    sehingga hasilnya deterministik lintas OS dan dapat diuji di CI Linux.
 *  - `killProcessTree()` mengeksekusi plan, dengan fallback fail-safe ke
 *    `child.kill('SIGKILL')` bila jalur utama gagal (spawn error / exit code ≠ 0 /
 *    kill group melempar). Jalur utama TIDAK diperlemah: pada non-win32 dengan
 *    `processGroup: true`, perilakunya tetap `process.kill(-pid, sinyal)`.
 *  - Zero runtime dependency — hanya built-in `node:child_process`.
 */
import { spawn } from 'node:child_process';

/** Jalur kill yang dipilih untuk sebuah PID. */
export type TreeKillMode =
  /** POSIX: `process.kill(-pid, sinyal)` → membunuh seluruh process group. */
  | 'process-group'
  /** Windows: `taskkill /PID <pid> /T /F` → membunuh seluruh pohon proses. */
  | 'taskkill'
  /** Hanya handle child (bukan group leader) / PID tidak valid. */
  | 'child';

/** Alasan fallback fail-safe dipakai (observability + test). */
export type TreeKillFallbackReason =
  | 'invalid-pid'
  | 'group-kill-failed'
  | 'taskkill-spawn-error'
  | 'taskkill-exit-nonzero'
  | 'child-kill-threw';

export interface TreeKillPlan {
  mode: TreeKillMode;
  /** Sinyal untuk mode `process-group` dan `child`. `taskkill` selalu /F. */
  signal: NodeJS.Signals;
  /** Binary yang dieksekusi untuk mode `taskkill`. */
  binary?: string;
  /** Argumen final untuk mode `taskkill` (sudah lengkap, tanpa shell). */
  args?: string[];
  /** Penjelasan singkat kenapa mode ini dipilih. */
  reason: string;
}

export interface TreeKillOptions {
  /** `true` → paksa (SIGKILL / taskkill /F). Default `false` (graceful). */
  force?: boolean;
  /** Platform yang disimulasikan; default `process.platform`. Injektabel untuk test. */
  platform?: NodeJS.Platform;
  /**
   * `false` bila child TIDAK di-spawn dengan `detached: true` sehingga bukan
   * pemimpin process group (mis. `execFile`/`spawn` biasa di executor.ts dan
   * external-tools.ts). Default `true` (processManager memakai `detached: true`).
   */
  processGroup?: boolean;
}

/** Handle minimal yang cukup untuk fallback (ChildProcess memenuhi ini). */
export interface TreeKillTarget {
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface TreeKillRunOptions extends TreeKillOptions {
  /** Handle child untuk fallback fail-safe. */
  child?: TreeKillTarget | null;
  /** Pengganti `process.kill` (injektabel untuk test). */
  sysKill?: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * Pengganti eksekusi taskkill; mengembalikan exit code.
   * Wajib reject bila proses taskkill gagal di-spawn (mis. ENOENT).
   */
  runTaskkill?: (binary: string, args: string[]) => Promise<number | null>;
  /** Callback observability saat fallback fail-safe dipakai. */
  onFallback?: (reason: TreeKillFallbackReason) => void;
}

export interface TreeKillOutcome {
  /** Mode yang benar-benar dipakai (mode `child` juga berarti fallback). */
  mode: TreeKillMode;
  signal: NodeJS.Signals;
  /** `true` bila perintah kill terkirim tanpa error. */
  ok: boolean;
  /** `true` bila jalur utama gagal dan fallback fail-safe dipakai. */
  usedFallback: boolean;
  fallbackReason?: TreeKillFallbackReason;
  /** Plan awal dari `resolveTreeKill()` (untuk audit/test). */
  plan: TreeKillPlan;
}

/** Nama binary taskkill bawaan Windows. */
export const TASKKILL_BINARY = 'taskkill';

/**
 * Benarkah `pid` aman dikirim ke `process.kill()`?
 *
 * GUARD KEAMANAN: PID ≤ 0 dan PID non-integer TIDAK PERNAH boleh dikirim.
 * Pada POSIX `process.kill(0, sinyal)` berarti "seluruh process group pemanggil"
 * dan `kill(-n, …)` berarti process group lain — jadi PID yang tidak valid bisa
 * membunuh proses Ruko sendiri beserta seluruh process group-nya.
 */
function isKillablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

/**
 * PURE: menentukan strategi kill untuk `pid` tanpa efek samping apa pun.
 *
 * - PID tidak valid (bukan integer positif) → mode `child` + SIGKILL (fail-safe).
 * - win32 → `taskkill /PID <pid> /T /F` (`force` tidak mengubah argv: proses
 *   konsol Windows tidak merespons terminator "graceful", dan `/T` tanpa `/F`
 *   akan gagal dengan exit code ≠ 0).
 * - non-win32 + `processGroup: true` → `kill(-pid)` dengan SIGTERM/SIGKILL.
 * - non-win32 + `processGroup: false` → sinyal ke handle child saja
 *   (perilaku lama executor/external-tools, tidak berubah).
 */
export function resolveTreeKill(pid: number, options: TreeKillOptions = {}): TreeKillPlan {
  const force = options.force ?? false;
  const platform = options.platform ?? process.platform;
  const processGroup = options.processGroup ?? true;
  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';

  if (!isKillablePid(pid)) {
    return {
      mode: 'child',
      signal: 'SIGKILL',
      reason: 'PID tidak valid → fallback fail-safe ke handle child',
    };
  }

  if (platform === 'win32') {
    return {
      mode: 'taskkill',
      signal: 'SIGKILL',
      binary: TASKKILL_BINARY,
      args: ['/PID', String(pid), '/T', '/F'],
      reason: 'Windows: taskkill /T /F membunuh grandchild, kill(-pid) tidak berlaku',
    };
  }

  if (!processGroup) {
    return {
      mode: 'child',
      signal,
      reason: 'child bukan pemimpin process group (bukan detached) → sinyal ke handle child',
    };
  }

  return {
    mode: 'process-group',
    signal,
    reason: 'POSIX: kill(-pid) membunuh seluruh process group (child detached)',
  };
}

/** Eksekusi default taskkill (dipakai produksi; diganti di test). */
function defaultRunTaskkill(binary: string, args: string[]): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, args, { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    // `error` (ENOENT/EACCES) → reject agar pemanggil memakai fallback.
    child.once('error', (err) => reject(err));
    child.once('close', (code) => resolve(code));
  });
}

/**
 * Mengeksekusi strategi dari `resolveTreeKill()` untuk `pid`.
 *
 * Sinkron sampai titik spawn: bagian sebelum `await` pertama berjalan seketika,
 * sehingga aman dipanggil (fire-and-forget) dari handler sinkron seperti
 * `process.on('exit')` pada jalur `process-group`.
 *
 * Tidak pernah reject — semua kegagalan dikembalikan sebagai outcome dengan
 * `usedFallback: true`.
 */
export async function killProcessTree(
  pid: number,
  options: TreeKillRunOptions = {},
): Promise<TreeKillOutcome> {
  const plan = resolveTreeKill(pid, options);
  const child = options.child ?? null;
  const sysKill =
    options.sysKill ?? ((target: number, signal: NodeJS.Signals) => process.kill(target, signal));
  const runTaskkill = options.runTaskkill ?? defaultRunTaskkill;

  /**
   * Fail-safe terakhir: bunuh handle child (atau PID langsung bila tak ada handle).
   *
   * `signal` default SIGKILL. Untuk kegagalan kill process group, pemanggil
   * mengirim `plan.signal` (SIGTERM saat graceful) agar cabang non-win32 tetap
   * bit-identik dengan perilaku lama: `kill(-pid, SIGTERM)` gagal → `child.kill('SIGTERM')`.
   */
  const fallback = (reason: TreeKillFallbackReason, signal: NodeJS.Signals = 'SIGKILL'): TreeKillOutcome => {
    options.onFallback?.(reason);
    let ok = false;
    if (child) {
      try {
        ok = child.kill(signal) === true;
      } catch {
        ok = false;
      }
    } else if (isKillablePid(pid)) {
      try {
        sysKill(pid, signal);
        ok = true;
      } catch {
        ok = false;
      }
    }
    return { mode: 'child', signal, ok, usedFallback: true, fallbackReason: reason, plan };
  };

  if (plan.mode === 'taskkill') {
    try {
      const exitCode = await runTaskkill(plan.binary ?? TASKKILL_BINARY, plan.args ?? []);
      if (exitCode === 0) {
        return { mode: 'taskkill', signal: plan.signal, ok: true, usedFallback: false, plan };
      }
      return fallback('taskkill-exit-nonzero');
    } catch {
      return fallback('taskkill-spawn-error');
    }
  }

  if (plan.mode === 'process-group') {
    try {
      sysKill(-pid, plan.signal);
      return { mode: 'process-group', signal: plan.signal, ok: true, usedFallback: false, plan };
    } catch {
      return fallback('group-kill-failed', plan.signal);
    }
  }

  // mode 'child' — jalur utama; kecuali PID tidak valid (fail-safe, dilaporkan).
  if (!isKillablePid(pid)) {
    return fallback('invalid-pid');
  }
  if (!child) {
    try {
      sysKill(pid, plan.signal);
      return { mode: 'child', signal: plan.signal, ok: true, usedFallback: false, plan };
    } catch {
      return fallback('child-kill-threw');
    }
  }
  try {
    const ok = child.kill(plan.signal) === true;
    return { mode: 'child', signal: plan.signal, ok, usedFallback: false, plan };
  } catch {
    return fallback('child-kill-threw');
  }
}
