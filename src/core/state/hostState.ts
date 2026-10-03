/**
 * hostState.ts — F1-T3 (Fase 1, Blueprint v2.0.0)
 *
 * State kanonis host terisolasi: state otoritatif runtime (mode,
 * activePlanHash, approvalScope, sessionTokenHash) disimpan EKSKLUSIF di
 * luar jangkauan workspace, pada `~/.ruko/sessions/<sessionId>/state.json`
 * dengan hak akses 0600. Berkas `.ruko/plan.json` di dalam workspace murni
 * merupakan proyeksi baca (read-only projection) — tidak pernah ditulis di sini.
 *
 * Invarian (PROGRESS2.md / blueprint / QA.md §4):
 *  1. Dual-Plane State — otoritatif di host, proyeksi read-only di workspace.
 *  2. Fail-Safe Resume Reset — memuat ulang sesi yang pernah 'act' SELALU
 *     mendarat kembali di mode 'plan' dengan approvalScope dibatalkan.
 *  3. Fail-Closed Corrupted State Halt (Gap #3, TC-STA-01) — jika berkas state
 *     korup (truncated payload dari crash/ENOSPC, JSON rusak, struktur cacat,
 *     atau error IO non-ENOENT), sistem melempar CorruptedStateError dan
 *     menghentikan eksekusi, BUKAN diam-diam membuat state baru.
 *  4. Atomic Write & Directory Fsync Portability (TC-STA-02) — penulisan atomik
 *     tmp 0600 → fsync → rename, disertai best-effort directory fsync pada POSIX
 *     dengan graceful fallback untuk fs tanpa dukungan dir fsync (OverlayFS/WSL).
 *
 * Hardening Win32 (temuan CI Windows PR #22): rename tmp→target rentan gagal
 * dengan EPERM/EACCES/EBUSY karena antivirus/indexer yang memegang handle
 * berkas sesaat — ditangani retry backoff eksponensial.
 *
 * ZERO dependency — hanya `node:*`.
 */

import fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { constants as C } from 'node:fs';

/**
 * Kesalahan fatal ketika berkas host state korup, terpotong, atau mengalami
 * desinkronisasi. Menghentikan eksekusi secara fail-closed alih-alih me-reset
 * state diam-diam.
 */
export class CorruptedStateError extends Error {
  readonly code = 'CORRUPTED_STATE';
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CorruptedStateError';
  }
}

export interface ScopeContract {
  planHash: string;
  allowedPaths: string[];
  approvedAt: string;
  correlationId: string;
}

export interface HostState {
  sessionId: string;
  mode: 'plan' | 'act';
  activePlanHash: string | null;
  approvalScope: ScopeContract | null;
  sessionTokenHash: string;
  updatedAt: string;
}

const IS_WIN = process.platform === 'win32';
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Direktori state host: ~/.ruko/sessions (dapat dioverride untuk test). */
function hostDir(): string {
  return process.env.RUKO_HOST_STATE_DIR
    ? path.resolve(process.env.RUKO_HOST_STATE_DIR)
    : path.join(os.homedir(), '.ruko', 'sessions');
}

export function validateSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(`SESSION_ID_INVALID: Format identifier sesi tidak valid: ${id}`);
  }
}

/**
 * Menyimpan state secara atomik (tmp 0600 → fsync → rename) dengan retry
 * backoff eksponensial khusus Windows (EPERM/EACCES/EBUSY dari AV/indexer)
 * serta directory fsync best-effort pada platform POSIX (TC-STA-02).
 */
export async function saveHostState(state: HostState): Promise<void> {
  validateSessionId(state.sessionId);
  const dir = path.join(hostDir(), state.sessionId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const target = path.join(dir, 'state.json');
  const tmp = path.join(dir, `.state.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  state.updatedAt = new Date().toISOString();

  const fd = await fs.open(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL, 0o600);
  try {
    await fd.writeFile(JSON.stringify(state, null, 2), 'utf8');
    await fd.sync();
  } finally {
    await fd.close();
  }

  const maxAttempts = IS_WIN ? 8 : 1;
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await fs.rename(tmp, target);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const code = (e as NodeJS.ErrnoException).code;
      if (!IS_WIN || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw e;
      await new Promise((r) => setTimeout(r, 10 * (1 << i)));
    }
  }
  if (lastErr) throw lastErr;

  // Directory fsync best-effort untuk ketahanan POSIX & kompatibilitas WSL/OverlayFS (TC-STA-02)
  if (process.platform !== 'win32') {
    try {
      const dirFd = await fs.open(dir, C.O_RDONLY);
      try {
        await dirFd.sync();
      } finally {
        await dirFd.close();
      }
    } catch (err: any) {
      if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EPERM', 'EACCES'].includes(err?.code)) {
        throw err;
      }
    }
  }
}

/**
 * Memuat state sesi.
 *
 * Invarian Fail-Safe Resume Reset: state yang tersimpan dalam mode 'act'
 * direset mekanis ke 'plan' (approvalScope dibatalkan) setiap kali dibaca
 * kembali saat resume tanpa pengecualian.
 *
 * Invarian Fail-Closed Corrupted State (Gap #3, TC-STA-01):
 * - Jika berkas state belum ada (ENOENT), sesi baru diinisialisasi dalam mode 'plan'.
 * - Jika berkas state ada tetapi korup (JSON rusak, payload terpotong ENOSPC,
 *   struktur cacat, atau error IO non-ENOENT), sistem melempar CorruptedStateError
 *   dan menghentikan eksekusi secara eksplisit alih-alih membuat state baru secara diam-diam.
 */
export async function loadHostState(sessionId: string, opts: { resume?: boolean } = { resume: true }): Promise<HostState> {
  validateSessionId(sessionId);
  const target = path.join(hostDir(), sessionId, 'state.json');
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const newState: HostState = {
        sessionId,
        mode: 'plan',
        activePlanHash: null,
        approvalScope: null,
        sessionTokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
        updatedAt: new Date().toISOString(),
      };
      await saveHostState(newState);
      return newState;
    }
    throw new CorruptedStateError(
      `Gagal membaca berkas state sesi '${sessionId}' (${err?.code || 'IO_ERROR'}): ${err?.message || err}`,
      err,
    );
  }

  let state: HostState;
  try {
    state = JSON.parse(raw) as HostState;
  } catch (parseErr) {
    throw new CorruptedStateError(
      `State sesi '${sessionId}' korup atau terpotong (truncated payload): ${parseErr instanceof Error ? parseErr.message : parseErr}. Eksekusi dihentikan secara fail-closed.`,
      parseErr,
    );
  }

  if (
    !state ||
    typeof state !== 'object' ||
    typeof state.sessionId !== 'string' ||
    state.sessionId !== sessionId ||
    !['plan', 'act'].includes(state.mode) ||
    typeof state.sessionTokenHash !== 'string'
  ) {
    throw new CorruptedStateError(
      `Integritas struktur state sesi '${sessionId}' tidak valid (skema HostState cacat atau sessionId tidak cocok). Eksekusi dihentikan secara fail-closed.`,
    );
  }

  if (opts.resume !== false && state.mode === 'act') {
    state.mode = 'plan';
    state.approvalScope = null;
    await saveHostState(state);
  }
  return state;
}
