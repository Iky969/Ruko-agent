/**
 * fileLock.ts — F1-T2 (Fase 1, Blueprint v2.0.0)
 *
 * Mutex konkurensi native tanpa dependensi npm: mengadopsi pola kerja
 * `proper-lockfile` secara murni menggunakan primitif atomik `fs.mkdir`
 * (atomik di tingkat kernel POSIX dan NTFS) dipadukan dengan pembaruan
 * periodik mtime sebagai detak jantung (heartbeat) untuk mendeteksi stale
 * lock akibat SIGKILL atau process crash.
 *
 * Hardening dari temuan QA.md §1.3:
 *  - Heartbeat gagal tidak berhenti senyap: setiap kegagalan `utimes`
 *    dicatat ke stderr dan ditoleransi maksimal 3 kali berturut-turut
 *    sebelum heartbeat dihentikan.
 *  - Clock skew NTP: selisih umur lock dihitung berbasis nilai absolut
 *    dengan batas toleransi (grace period) minimum sebelum eviksi stale.
 *
 * ZERO dependency — hanya `node:fs/promises` dan `node:path`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface LockOptions {
  /** Batas waktu total menunggu lock (ms). Default 5000. */
  timeoutMs?: number;
  /** Jeda antar percobaan ulang (ms). Default 50. */
  retryIntervalMs?: number;
  /** Umur lock tanpa heartbeat dianggap mati (ms). Default 8000. */
  staleTimeoutMs?: number;
  /** Interval pembaruan mtime heartbeat (ms). Default 2000. */
  heartbeatIntervalMs?: number;
}

/** Grace period minimum sebelum sebuah lock boleh dieviksi sebagai stale (ms). */
const MIN_STALE_GRACE_MS = 1000;

/** Batas kegagalan heartbeat berturut-turut sebelum loop dihentikan (QA.md §1.3). */
const MAX_HEARTBEAT_FAILURES = 3;

export class FileLock {
  private lockPath: string;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private released = false;

  constructor(targetFilePath: string) {
    this.lockPath = `${path.resolve(targetFilePath)}.lock`;
  }

  /**
   * Memperoleh lock. Mengembalikan fungsi `release()` (idempoten) yang
   * menghentikan heartbeat dan menghapus direktori lock.
   * Melempar `LOCK_TIMEOUT` bila lock tidak diperoleh dalam `timeoutMs`.
   */
  async acquire(opts: LockOptions = {}): Promise<() => Promise<void>> {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const retryIntervalMs = opts.retryIntervalMs ?? 50;
    const staleTimeoutMs = Math.max(opts.staleTimeoutMs ?? 8000, MIN_STALE_GRACE_MS);
    const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 2000;

    const start = Date.now();
    let attempts = 0;

    while (attempts === 0 || Date.now() - start < timeoutMs) {
      attempts++;
      try {
        // fs.mkdir bersifat atomik di tingkat kernel POSIX dan NTFS:
        // hanya SATU proses yang berhasil membuat direktori ini.
        await fs.mkdir(this.lockPath);

        // Perbarui mtime awal sebagai bukti kepemilikan
        await this.touch();

        // Aktifkan heartbeat loop (unref: timer tidak menahan proses hidup)
        this.released = false;
        this.heartbeatTimer = setInterval(() => {
          void this.heartbeatTick();
        }, heartbeatIntervalMs);
        this.heartbeatTimer.unref?.();

        // Handler pelepasan lock
        return async () => {
          this.stopHeartbeat();
          if (this.released) return;
          this.released = true;
          try {
            await fs.rmdir(this.lockPath);
          } catch {
            /* best-effort: lock mungkin sudah dieviksi sebagai stale */
          }
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw err;

        // Periksa stale lock via evaluasi mtime heartbeat
        try {
          const stat = await fs.stat(this.lockPath);
          // QA.md §1.3: gunakan selisih absolut + grace period minimum agar
          // clock skew NTP tidak mengeviksi lock hidup secara prematur.
          const age = Math.abs(Date.now() - stat.mtimeMs);
          if (age > staleTimeoutMs) {
            // Pemilik kunci sebelumnya dianggap mati (crash/SIGKILL)
            await fs.rmdir(this.lockPath).catch(() => {});
            continue;
          }
        } catch {
          // Direktori lock terhapus di antara eksekusi, coba kembali
          continue;
        }

        await new Promise((r) => setTimeout(r, retryIntervalMs));
      }
    }

    throw new Error(`LOCK_TIMEOUT: Gagal memperoleh lock pada ${this.lockPath} setelah ${timeoutMs}ms`);
  }

  /** Satu detak heartbeat: perbarui mtime, dengan toleransi kegagalan (QA.md §1.3). */
  private heartbeatFailures = 0;
  private async heartbeatTick(): Promise<void> {
    try {
      await this.touch();
      this.heartbeatFailures = 0;
    } catch (err) {
      this.heartbeatFailures++;
      process.stderr.write(
        `[Ruko][fileLock] Heartbeat gagal (${this.heartbeatFailures}/${MAX_HEARTBEAT_FAILURES}): ` +
          `${(err as Error)?.message ?? err}\n`,
      );
      if (this.heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
        // Hentikan loop — lock tetap dipegang; bila proses mati, pemilik lain
        // akan mengeviksinya lewat jalur stale-lock normal.
        this.stopHeartbeat();
      }
    }
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
    this.heartbeatFailures = 0;
  }
}
