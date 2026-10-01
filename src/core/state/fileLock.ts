/**
 * fileLock.ts — Mutex Konkurensi Native & Deterministic Reclamation
 * (Blueprint v2.0.0 §2.1, QA.md §3, halo.md Gap #3 Fix)
 *
 * Mutex konkurensi native tanpa dependensi eksternal npm.
 * Menggantikan primitif fs.mkdir dengan pembuatan berkas eksklusif kernel
 * atomik via `fs.openSync(lockPath, 'wx', 0o600)` untuk mencegah celah
 * split-brain akibat auto-eviction buta berbasis mtime.
 *
 * Invarian Keamanan (QA.md §3 & halo.md):
 *  1. Atomic File Creation: Primitif `openSync` dengan flag 'wx' (O_CREAT | O_EXCL)
 *     dijamin atomik di tingkat kernel POSIX dan Windows NTFS.
 *  2. Structured Lock Metadata: Berkas lock menyimpan metadata JSON:
 *     `{ pid, nonce, createdAt }` dengan hak akses 0600.
 *  3. Process Liveness Verification (TC-LCK-02 v2): Deteksi stale lock berbasis
 *     keaktifan PID via `process.kill(pid, 0)`. Hanya jika proses sudah mati
 *     (ESRCH) lock boleh dianggap stale dan direklamasi.
 *  4. Anti Auto-Eviction: Jika proses pemegang lock masih hidup, sistem TIDAK
 *     mengeviksi lock secara otomatis meskipun waktu stale terlampaui. Memerlukan
 *     opsi eksplisit `force: true` (--force-unlock) atau konfirmasi interaktif.
 *  5. Fail-Closed Metadata: Kegagalan pembacaan atau parsing metadata lock diperlakukan
 *     sebagai "locked" secara fail-closed, bukan diasumsikan dapat diambil alih.
 *  6. Nonce Ownership Matching: Pelepasan dan reklamasi lock memvalidasi nonce acak unik
 *     untuk mencegah penghapusan lock milik proses lain.
 *
 * ZERO dependency — hanya `node:fs`, `node:fs/promises`, `node:path`, dan `node:crypto`.
 */

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface LockMetadata {
  pid: number;
  nonce: string;
  createdAt: number;
}

export interface LockOptions {
  /** Batas waktu total menunggu lock (ms). Default 5000. */
  timeoutMs?: number;
  /** Jeda antar percobaan ulang (ms). Default 50. */
  retryIntervalMs?: number;
  /** Umur lock yang dipertimbangkan untuk prompt/evaluasi stale (ms). Default 8000. */
  staleTimeoutMs?: number;
  /** Interval pembaruan mtime heartbeat (ms). Default 2000. */
  heartbeatIntervalMs?: number;
  /** Opsi eksplisit untuk memaksa pelepasan lock meskipun proses masih aktif atau metadata korup (--force-unlock). */
  force?: boolean;
  /** Callback interaktif opsional saat lock terdeteksi pada PID yang masih hidup. */
  onStalePrompt?: (meta: LockMetadata) => Promise<boolean> | boolean;
}

/** Grace period minimum sebelum evaluasi stale (ms). */
const MIN_STALE_GRACE_MS = 1000;

/** Batas kegagalan heartbeat berturut-turut sebelum loop dihentikan. */
const MAX_HEARTBEAT_FAILURES = 3;

/** Helper jeda asinkron */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Memeriksa apakah sebuah proses dengan PID tertentu masih aktif.
 * Mengembalikan true jika proses ada/aktif (termasuk jika melempar EPERM).
 * Mengembalikan false jika proses sudah mati (ESRCH) atau PID tidak valid.
 */
export function isPidAlive(pid: number): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err.code === 'ESRCH') {
      return false;
    }
    // EPERM atau error lain menandakan proses ada di sistem
    return true;
  }
}

export class FileLock {
  private lockPath: string;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private released = false;
  private currentNonce: string | null = null;
  private heartbeatFailures = 0;

  constructor(targetFilePath: string) {
    this.lockPath = `${path.resolve(targetFilePath)}.lock`;
  }

  getLockPath(): string {
    return this.lockPath;
  }

  /**
   * Membaca dan memvalidasi metadata berkas lock saat ini di disk.
   * Mengembalikan null jika berkas tidak ada atau format tidak valid.
   */
  readMetadata(): LockMetadata | null {
    try {
      if (!fs.existsSync(this.lockPath)) return null;
      const raw = fs.readFileSync(this.lockPath, 'utf8');
      const meta = JSON.parse(raw);
      if (typeof meta?.pid === 'number' && typeof meta?.nonce === 'string' && typeof meta?.createdAt === 'number') {
        return meta as LockMetadata;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Memperoleh lock mutex secara atomik. Mengembalikan fungsi `release()`
   * (idempoten) yang menghentikan heartbeat dan menghapus berkas lock.
   * Melempar `LOCK_TIMEOUT` bila lock tidak diperoleh dalam `timeoutMs`.
   */
  async acquire(opts: LockOptions = {}): Promise<() => Promise<void>> {
    const timeoutMs = opts.timeoutMs ?? 5000;
    const retryIntervalMs = opts.retryIntervalMs ?? 50;
    const staleTimeoutMs = Math.max(opts.staleTimeoutMs ?? 8000, MIN_STALE_GRACE_MS);
    const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 2000;
    const force = opts.force ?? false;

    const start = Date.now();
    let attempts = 0;

    // Pastikan direktori induk lockPath tersedia
    const parentDir = path.dirname(this.lockPath);
    if (!fs.existsSync(parentDir)) {
      try {
        fs.mkdirSync(parentDir, { recursive: true });
      } catch {}
    }

    const currentNonce = crypto.randomUUID();

    while (attempts === 0 || Date.now() - start < timeoutMs) {
      attempts++;
      let fd: number | null = null;
      try {
        // 1. Primitif atomik: openSync 'wx' (O_CREAT | O_EXCL)
        // Gagal dengan EEXIST jika berkas sudah ada.
        fd = fs.openSync(this.lockPath, 'wx', 0o600);

        const metadata: LockMetadata = {
          pid: process.pid,
          nonce: currentNonce,
          createdAt: Date.now(),
        };

        fs.writeFileSync(fd, JSON.stringify(metadata));
        fs.closeSync(fd);
        fd = null;

        // Berhasil memperoleh lock!
        this.currentNonce = currentNonce;
        this.released = false;
        this.heartbeatFailures = 0;

        // 2. Aktifkan heartbeat loop
        this.heartbeatTimer = setInterval(() => {
          void this.heartbeatTick();
        }, heartbeatIntervalMs);
        this.heartbeatTimer.unref?.();

        // 3. Handler pelepasan lock (idempoten & verifikasi nonce)
        return async () => {
          this.stopHeartbeat();
          if (this.released) return;
          this.released = true;
          try {
            if (fs.existsSync(this.lockPath)) {
              const raw = fs.readFileSync(this.lockPath, 'utf8');
              const meta = JSON.parse(raw);
              if (meta.nonce === currentNonce) {
                fs.unlinkSync(this.lockPath);
              }
            }
          } catch {
            /* best-effort: lock mungkin sudah dihapus atau direklamasi */
          }
        };
      } catch (err: any) {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch {}
          fd = null;
        }

        const code = err.code;
        if (code !== 'EEXIST' && code !== 'EISDIR') {
          throw err;
        }

        // Tangani jika ada direktori peninggalan versi v1.x/legacy
        try {
          const stat = fs.statSync(this.lockPath);
          if (stat.isDirectory()) {
            if (force) {
              fs.rmSync(this.lockPath, { recursive: true, force: true });
              continue;
            }
            // Tanpa force, direktori legacy dianggap locked
            await wait(retryIntervalMs);
            continue;
          }
        } catch {
          // File terhapus di antara eksekusi
          continue;
        }

        // Baca isi berkas lock eksis
        let rawMeta: string;
        try {
          rawMeta = fs.readFileSync(this.lockPath, 'utf8');
        } catch (readErr: any) {
          if (readErr.code === 'ENOENT') {
            continue;
          }
          await wait(retryIntervalMs);
          continue;
        }

        let meta: LockMetadata | null = null;
        try {
          const parsed = JSON.parse(rawMeta);
          if (
            parsed &&
            typeof parsed.pid === 'number' &&
            typeof parsed.nonce === 'string' &&
            typeof parsed.createdAt === 'number'
          ) {
            meta = parsed as LockMetadata;
          }
        } catch {
          meta = null;
        }

        // Invarian 5 (Fail-closed): jika metadata corrupt/tidak valid
        if (!meta) {
          if (force) {
            try {
              fs.unlinkSync(this.lockPath);
            } catch {}
            continue;
          }
          await wait(retryIntervalMs);
          continue;
        }

        // Invarian 3: Periksa apakah PID pemilik lock masih hidup
        let ownerAlive = true;
        try {
          ownerAlive = isPidAlive(meta.pid);
        } catch {
          ownerAlive = true;
        }

        if (!ownerAlive) {
          // Pemilik lock sudah mati (ESRCH)!
          // Boleh direklamasi otomatis secara aman dengan mencocokkan nonce.
          try {
            const checkRaw = fs.readFileSync(this.lockPath, 'utf8');
            const checkMeta = JSON.parse(checkRaw);
            if (checkMeta.nonce === meta.nonce) {
              fs.unlinkSync(this.lockPath);
            }
          } catch {
            // Sudah dihapus / diubah oleh proses lain
          }
          continue;
        }

        // Pemegang lock MASIH HIDUP!
        // Invarian 4: JANGAN auto-evict hanya karena mtime/waktu sudah lama.
        if (force) {
          try {
            fs.unlinkSync(this.lockPath);
          } catch {}
          continue;
        }

        // Jika onStalePrompt disematkan dan waktu lock melampaui batas stale
        const age = Date.now() - meta.createdAt;
        if (opts.onStalePrompt && age > staleTimeoutMs) {
          try {
            const shouldReclaim = await opts.onStalePrompt(meta);
            if (shouldReclaim) {
              try {
                fs.unlinkSync(this.lockPath);
              } catch {}
              continue;
            }
          } catch {}
        }

        // Tunggu sebelum percobaan ulang
        await wait(retryIntervalMs);
      }
    }

    throw new Error(`LOCK_TIMEOUT: Gagal memperoleh lock pada ${this.lockPath} setelah ${timeoutMs}ms`);
  }

  /** Pembaruan mtime heartbeat berkala */
  private async heartbeatTick(): Promise<void> {
    if (this.released) return;
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
        this.stopHeartbeat();
      }
    }
  }

  private async touch(): Promise<void> {
    const now = new Date();
    await fsPromises.utimes(this.lockPath, now, now).catch(() => {});
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.heartbeatFailures = 0;
  }
}
