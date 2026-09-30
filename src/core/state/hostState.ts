/**
 * hostState.ts — State otoritatif di bidang host (dual-plane state machine).
 *
 * DUA BIDANG (INVARIAN ARSITEKTUR)
 * --------------------------------
 *  1. BIDANG OTORITATIF: `~/.ruko/sessions/<sessionId>/state.json`, mode 0600,
 *     direktori 0700. Tidak berada di dalam workspace, jadi repositori pihak
 *     ketiga tidak bisa membaca, menulis, atau memalsukannya.
 *  2. PROYEKSI BACA: `.ruko/plan.json` di dalam workspace. Murni hasil
 *     pantulan untuk ditampilkan ke pengguna/agen — TIDAK PERNAH menjadi sumber
 *     otorisasi. `readPlanProjection()` sengaja tidak dipakai untuk memutuskan
 *     izin; hanya `loadHostState()` yang berwenang.
 *
 * Fail-safe resume reset: sesi yang di-resume SELALU kembali ke `plan`. Mode
 * `act` beserta scope approval-nya dibuang, sehingga sesi terputus tidak pernah
 * mewarisi hak eksekusi.
 *
 * KEAMANAN PENULISAN
 * ------------------
 * Tulis-ke-sesi-tempel (`state.<pid>.<rand>.tmp`, mode 0600, O_EXCL) +
 * `fsync` + `rename` atomik. Pembaca tidak pernah melihat state setengah jadi.
 * Di Windows, `rename` bisa gagal EPERM/EACCES/EBUSY sementara antivirus atau
 * Windows Search mengindeks berkas — karena itu ada retry backoff eksponensial.
 *
 * PEMROSESAN KEGAGALAN (fail-closed, QA.md §3)
 * ---------------------------------------------
 *  - Berkas tidak ada            → state baru di mode `plan`.
 *  - JSON rusak / bentuk invalid → berkas dikarantina, state baru mode `plan`.
 *  - Error I/O lain (EACCES, dll)→ dilempar, TIDAK ditelan diam-diam. Menelan
 *    error I/O akan membuat Ruko tampak "lupa" pada scope yang ada.
 *
 * Zero runtime dependency — hanya `node:fs`, `node:path`, `node:os`,
 * `node:crypto`.
 */

import * as crypto from 'node:crypto';
import { constants as C } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export type AgentMode = 'plan' | 'act';

/** Kontrak scope yang disetujui pengguna untuk satu rencana. */
export interface ScopeContract {
  planHash: string;
  allowedPaths: string[];
  approvedAt: string;
  correlationId: string;
}

/** Bentuk persis `state.json` di bidang host. */
export interface HostState {
  sessionId: string;
  mode: AgentMode;
  activePlanHash: string | null;
  approvalScope: ScopeContract | null;
  sessionTokenHash: string;
  updatedAt: string;
}

export interface HostStateStoreOptions {
  /**
   * Root direktori state. Default `~/.ruko/sessions`.
   *
   * `baseDir` adalah parameter program, BUKAN variabel lingkungan: variabel
   * lingkungan bisa dipengaruhi lingkungan eksekusi, dan ini jalur yang
   * memegang otorisasi.
   */
  baseDir?: string;
  /** Mode berkas state (default 0600). */
  fileMode?: number;
  /** Mode direktori sesi (default 0700). */
  dirMode?: number;
  /** Paksa perilaku backoff Win32 (default mengikuti `process.platform`). */
  isWindows?: boolean;
  /** Maksimum percobaan rename (default 1 di POSIX, 8 di Win32). */
  maxRenameAttempts?: number;
  /** Seam rename injectable untuk pengujian. Default `fs.rename`. */
  renameFn?: (oldPath: string, newPath: string) => Promise<void>;
  /** Seam penundaan injectable untuk pengujian. */
  sleep?: (ms: number) => Promise<void>;
  /** Pencatat peringatan (default stderr). */
  warn?: (message: string) => void;
}

const DEFAULT_STATE_FILE_MODE = 0o600;
const DEFAULT_SESSION_DIR_MODE = 0o700;
const WIN32_RENAME_ATTEMPTS = 8;
const WIN32_RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Root direktori state untuk proses ini. */
export function hostSessionsDir(baseDir?: string): string {
  return baseDir ?? path.join(os.homedir(), '.ruko', 'sessions');
}

/** Path proyeksi baca di dalam workspace (tidak pernah sumber otorisasi). */
export function planProjectionPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.ruko', 'plan.json');
}

/** Gagalkan sessionId yang bisa keluar dari direktori state (path traversal). */
export function validateSessionId(id: string): void {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) {
    throw new Error(`SESSION_ID_INVALID: Format identifier sesi tidak valid: ${String(id)}`);
  }
}

/** Jeda backoff eksponensial Win32: 10ms, 20ms, 40ms, ... */
export function computeBackoffDelay(attempt: number): number {
  return 10 * (1 << Math.max(0, attempt));
}

/** Buat state awal yang selalu deny-by-default (mode `plan`, tanpa scope). */
export function createInitialState(sessionId: string): HostState {
  validateSessionId(sessionId);
  const rawToken = crypto.randomBytes(32).toString('hex');
  return {
    sessionId,
    mode: 'plan',
    activePlanHash: null,
    approvalScope: null,
    sessionTokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
    updatedAt: new Date().toISOString(),
  };
}

/** Normalisasi bentuk state: field hilang/rusak diluruskan ke nilai aman. */
function coerceState(raw: unknown): HostState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.sessionId !== 'string' || !SESSION_ID_RE.test(obj.sessionId)) return null;
  if (typeof obj.sessionTokenHash !== 'string' || obj.sessionTokenHash.length === 0) return null;

  const mode: AgentMode = obj.mode === 'act' ? 'act' : 'plan'; // nilai lain → plan
  const scope = obj.approvalScope;
  const approvalScope =
    scope && typeof scope === 'object' && Array.isArray((scope as ScopeContract).allowedPaths)
      ? (scope as ScopeContract)
      : null;

  return {
    sessionId: obj.sessionId,
    mode,
    activePlanHash: typeof obj.activePlanHash === 'string' ? obj.activePlanHash : null,
    approvalScope,
    sessionTokenHash: obj.sessionTokenHash,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
  };
}

/**
 * Tulis state otoritatif secara atomik dengan izin ketat.
 * Selalu men-stamp `updatedAt` dengan waktu penulisan.
 */
export async function saveHostState(state: HostState, options: HostStateStoreOptions = {}): Promise<void> {
  const fileMode = options.fileMode ?? DEFAULT_STATE_FILE_MODE;
  const dirMode = options.dirMode ?? DEFAULT_SESSION_DIR_MODE;
  const isWindows = options.isWindows ?? process.platform === 'win32';
  const sleep = options.sleep ?? defaultSleep;

  validateSessionId(state.sessionId);

  const dir = path.join(hostSessionsDir(options.baseDir), state.sessionId);
  await fs.mkdir(dir, { recursive: true, mode: dirMode });

  const target = path.join(dir, 'state.json');
  const tmp = path.join(dir, `.state.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);

  const toPersist: HostState = { ...state, updatedAt: new Date().toISOString() };

  // O_EXCL: jangan pernah menimpa berkas temp milik proses lain.
  const fd = await fs.open(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL, fileMode);
  try {
    await fd.writeFile(`${JSON.stringify(toPersist, null, 2)}\n`, 'utf8');
    await fd.sync();
  } finally {
    await fd.close();
  }

  // Jaring pengaman: bila proses lebih longgar (mis. umask longgar),
  // pastikan mode berkas benar-benar 0600 sebelum dipromosikan.
  await fs.chmod(tmp, fileMode).catch(() => undefined);

  const maxAttempts = options.maxRenameAttempts ?? (isWindows ? WIN32_RENAME_ATTEMPTS : 1);
  const rename = options.renameFn ?? ((from: string, to: string) => fs.rename(from, to));
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await rename(tmp, target);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!isWindows || !WIN32_RETRYABLE_CODES.has(code ?? '') || attempt === maxAttempts - 1) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
      await sleep(computeBackoffDelay(attempt));
    }
  }
  if (lastErr) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw lastErr;
  }

  state.updatedAt = toPersist.updatedAt;
}

/**
 * Muat state sesi. Sesi yang di-resume SELALU kembali ke mode `plan`
 * dan approval scope-nya dibuang (invarian fail-safe resume).
 */
export async function loadHostState(sessionId: string, options: HostStateStoreOptions = {}): Promise<HostState> {
  const warn = options.warn ?? ((message: string) => console.error(`[ruko:hostState] ${message}`));
  validateSessionId(sessionId);

  const dir = path.join(hostSessionsDir(options.baseDir), sessionId);
  const target = path.join(dir, 'state.json');

  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const fresh = createInitialState(sessionId);
      await saveHostState(fresh, options);
      return fresh;
    }
    // EACCES/EISDIR/dll: melempar. Menelan error ini berarti Ruko "lupa"
    // pada scope yang ada — risk lebih besar daripada error yang terlihat.
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  const coerced = coerceState(parsed);
  if (!coerced) {
    // Fail-closed: karantina berkas rusak, mulai sesi baru di mode `plan`.
    const quarantine = path.join(dir, `state.corrupt.${Date.now()}.json`);
    warn(`State sesi rusak (${sessionId}) dikarantina ke ${path.basename(quarantine)}`);
    await fs.rename(target, quarantine).catch(() => undefined);
    const fresh = createInitialState(sessionId);
    await saveHostState(fresh, options);
    return fresh;
  }

  if (coerced.mode === 'act') {
    coerced.mode = 'plan';
    coerced.approvalScope = null;
    coerced.updatedAt = new Date().toISOString();
    await saveHostState(coerced, options);
  }

  return coerced;
}

/**
 * Tulis proyeksi baca rencana ke dalam workspace.
 *
 * Proyksi ini sengaja ditulis mode 0400 (baca saja): ia tidak pernah jadi sumber
 * otorisasi, dan tidak dapat dipakai agen untuk "memperpanjang" izin.
 */
export async function writePlanProjection(
  workspaceRoot: string,
  state: HostState,
): Promise<string> {
  const target = planProjectionPath(workspaceRoot);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const payload = {
    mode: state.mode,
    activePlanHash: state.activePlanHash,
    allowedPaths: state.approvalScope?.allowedPaths ?? [],
    approvedAt: state.approvalScope?.approvedAt ?? null,
    updatedAt: new Date().toISOString(),
    authority: 'host:~/.ruko/sessions',
  };
  await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o400 });
  await fs.chmod(target, 0o400).catch(() => undefined);
  return target;
}

/** Baca proyeksi. Hanya untuk TAMPILAN — jangan pernah dipakai otorisasi. */
export async function readPlanProjection(workspaceRoot: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(planProjectionPath(workspaceRoot), 'utf8'));
  } catch {
    return null;
  }
}
