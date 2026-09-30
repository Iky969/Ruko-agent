/**
 * fileLock.ts — Mutex lintas proses tanpa dependensi npm.
 *
 * Mengganti pola `proper-lockfile` hanya dengan primitif `node:fs`:
 *  - `fs.mkdir()` bersifat ATOMIK di kernel POSIX/NTFS (dibatasi O_EXCL di
 *    baliknya), sehingga tepat satu proses bisa memegang lock direktori.
 *  - `mtime` direktori lock diperbarui periodik (heartbeat) sebagai bukti
 *    pemilik masih hidup; lock yang heartbeat-nya mati dianggap basi.
 *
 * DETEKSI LOCK BASI (STALE)
 * -------------------------
 * Proses bisa mati mendadak (SIGKILL, crash kernel, power loss) tanpa sempat
 * melepas lock. Lock seperti itu dievakuasi paksa bila usia mtime-nya melewati
 * `staleTimeoutMs`.
 *
 * HARDENING QA.md §1.3
 * --------------------
 *  1. Silent heartbeat stoppage — kegagalan `fs.utimes` (disk penuh, mount
 *     read-only, permission drop) dulu hanya mematikan timer tanpa jejak.
 *     Sekarang: (a) dicatat sebagai kegagalan, (b) peringatan ke stderr,
 *     (c) setelah `maxHeartbeatFailures` kegagalan berturut-turut lock
 *     DINYATAKAN ditinggalkan — heartbeat dihentikan dan direktori lock
 *     dibuang, supaya proses lain tidak terkunci selamanya. Ini fail-safe:
 *     kita mengorbankan eksklusivitas daripada membekukan state global.
 *  2. Clock skew (NTP) — `Date.now() - mtimeMs` bisa negatif bila jam
 *     pemilik lock lebih maju. Perhitungan memakai nilai absolut plus grace
 *     period agar drift kecil tidak salah menghakimi lock yang masih hidup,
 *     sementara jam yang benar-benar tersesat jauh tidak membekukan lock.
 *
 * Zero runtime dependency — hanya `node:fs/promises` dan `node:path`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface LockOptions {
  /** Batas total menunggu lock (ms). Default 5000. */
  timeoutMs?: number;
  /** Jeda antar percobaan (ms). Default 50. */
  retryIntervalMs?: number;
  /** Usia maksimum lock tanpa heartbeat sebelum dianggap basi (ms). Default 8000. */
  staleTimeoutMs?: number;
  /** Interval heartbeat (ms). Default 2000. */
  heartbeatIntervalMs?: number;
  /** Toleransi clock skew negatif (ms). Default 2000. */
  clockSkewGraceMs?: number;
  /** Jumlah kegagalan heartbeat berturut-turut sebelum lock ditinggalkan. Default 3. */
  maxHeartbeatFailures?: number;
  /** Heartbeat tidak boleh menahan event loop tetap hidup. Default true. */
  unrefHeartbeat?: boolean;
  /** Pencatat peringatan internal (default menulis ke stderr). */
  warn?: (message: string) => void;
}

export const DEFAULT_LOCK_OPTIONS = {
  timeoutMs: 5_000,
  retryIntervalMs: 50,
  staleTimeoutMs: 8_000,
  heartbeatIntervalMs: 2_000,
  clockSkewGraceMs: 2_000,
  maxHeartbeatFailures: 3,
  unrefHeartbeat: true,
} as const;

/** Fungsi pelepas lock yang dikembalikan setelah `acquire()` berhasil. */
export type ReleaseLock = () => Promise<void>;

export class LockTimeoutError extends Error {
  readonly code = 'LOCK_TIMEOUT';
  constructor(
    readonly lockPath: string,
    readonly timeoutMs: number,
  ) {
    super(`LOCK_TIMEOUT: Gagal memperoleh lock pada ${lockPath} setelah ${timeoutMs}ms`);
    this.name = 'LockTimeoutError';
  }
}

/** Status internal lock — untuk self-check, audit, dan pengujian. */
export interface LockStatus {
  held: boolean;
  /** True bila heartbeat gagal berulang dan lock sudah ditinggalkan. */
  abandoned: boolean;
  /** Berapa kali `utimes` gagal sejak lock diperoleh. */
  heartbeatFailures: number;
}

export class FileLock {
  private readonly lockPath: string;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private state: LockStatus = { held: false, abandoned: false, heartbeatFailures: 0 };
  private readonly options: Required<Omit<LockOptions, 'warn'>> & { warn: (message: string) => void };

  constructor(
    targetFilePath: string,
    options: LockOptions = {},
  ) {
    this.lockPath = `${path.resolve(targetFilePath)}.lock`;
    this.options = {
      ...DEFAULT_LOCK_OPTIONS,
      ...options,
      warn: options.warn ?? ((message: string) => console.error(`[ruko:fileLock] ${message}`)),
    };
  }

  /** Jalur direktori lock yang dikelola modul ini. */
  get path(): string {
    return this.lockPath;
  }

  /** Status terkini (salinan, aman dibaca pemanggil). */
  get status(): LockStatus {
    return { ...this.state };
  }

  /**
   * Ambil lock. Fungsi pelepas yang dikembalikan WAJIB dipanggil (idealnya di
   * blok `finally`) supaya heartbeat berhenti dan direktori lock dihapus.
   */
  async acquire(opts: LockOptions = {}): Promise<ReleaseLock> {
    const o = { ...this.options, ...opts } as typeof this.options;
    const start = Date.now();

    // `do..while`: percobaan pertama selalu dijalankan walau timeoutMs = 0.
    do {
      try {
        // ATOMIK: dua proses tidak mungkin sama-sama berhasil membuat direktori.
        await fs.mkdir(this.lockPath);
        await this.touch();

        this.state = { held: true, abandoned: false, heartbeatFailures: 0 };
        this.startHeartbeat(o);

        let released = false;
        return async () => {
          if (released) return; // idempoten: `finally` ganda tetap aman
          released = true;
          this.stopHeartbeat();
          this.state = {
            held: false,
            abandoned: this.state.abandoned,
            heartbeatFailures: this.state.heartbeatFailures,
          };
          try {
            await fs.rm(this.lockPath, { recursive: true, force: true });
          } catch (err) {
            o.warn(`Gagal melepas lock ${this.lockPath}: ${String(err)}`);
          }
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw err;

        // Lock sudah ada: apakah sudah basi?
        try {
          const stat = await fs.stat(this.lockPath);
          const age = this.computeAgeMs(stat.mtimeMs, o.clockSkewGraceMs);
          if (age > o.staleTimeoutMs) {
            o.warn(`Lock basi (${Math.round(age)}ms) dievakuasi paksa: ${this.lockPath}`);
            await fs.rm(this.lockPath, { recursive: true, force: true }).catch(() => {});
            continue; // langsung coba ambil alih
          }
        } catch {
          // Lock hilang di antara iterasi (pemilik melepas) — coba lagi.
          continue;
        }

        const waited = Date.now() - start;
        if (waited >= o.timeoutMs) break;
        await delay(Math.max(1, Math.min(o.retryIntervalMs, o.timeoutMs - waited)));
      }
    } while (Date.now() - start < o.timeoutMs);

    throw new LockTimeoutError(this.lockPath, o.timeoutMs);
  }

  /**
   * Coba ambil lock tanpa menunggu; `null` bila sedang dipegang proses lain.
   * Berguna untuk jalur fail-fast (mis. pemeriksaan idempoten).
   */
  async tryAcquire(opts: LockOptions = {}): Promise<ReleaseLock | null> {
    try {
      return await this.acquire({ ...opts, timeoutMs: 0 });
    } catch (err) {
      if (err instanceof LockTimeoutError) return null;
      throw err;
    }
  }

  /**
   * Selisih usia lock dengan toleransi clock skew.
   *
   * `mtime` di masa depan (jam pemilik lock lebih maju) menghasilkan nilai
   * negatif. Skew sekecil itu TIDAK dianggap basi; skew yang jauh melampaui
   * grace period diperlakukan sebagai basi agar lock yatim dari mesin yang
   * jamnya salah tidak membekukan workstation selamanya.
   */
  computeAgeMs(mtimeMs: number, graceMs: number): number {
    const delta = Date.now() - mtimeMs;
    if (delta >= 0) return delta;
    return -delta > graceMs ? Number.POSITIVE_INFINITY : 0;
  }

  private startHeartbeat(o: typeof this.options): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.touch().then(
        () => {
          this.state.heartbeatFailures = 0;
        },
        (err: unknown) => {
          this.state.heartbeatFailures += 1;
          const failures = this.state.heartbeatFailures;
          o.warn(`Heartbeat lock gagal (${failures}/${o.maxHeartbeatFailures}): ${this.lockPath} — ${String(err)}`);
          if (failures >= o.maxHeartbeatFailures) {
            // Fail-safe: lock tidak lagi bisa dibuktikan hidup, jadi lepas agar
            // proses lain tidak terkunci permanen.
            this.state.abandoned = true;
            o.warn(`Lock ditinggalkan setelah ${failures} kegagalan heartbeat: ${this.lockPath}`);
            this.stopHeartbeat();
            void fs.rm(this.lockPath, { recursive: true, force: true }).catch(() => {});
          }
        },
      );
    }, o.heartbeatIntervalMs);

    // Heartbeat tidak boleh membuat proses Ruko menggantung waktu keluar.
    if (o.unrefHeartbeat) this.heartbeatTimer.unref?.();
  }

  private async touch(): Promise<void> {
    const now = new Date();
    await fs.utimes(this.lockPath, now, now);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
