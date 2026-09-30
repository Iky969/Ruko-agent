/**
 * hostState.ts — F1-T3 (Fase 1, Blueprint v2.0.0)
 *
 * State kanonis host terisolasi: state otoritatif runtime (mode,
 * activePlanHash, approvalScope, sessionTokenHash) disimpan EKSKLUSIF di
 * luar jangkauan workspace, pada `~/.ruko/sessions/<sessionId>/state.json`
 * dengan hak akses 0600. Berkas `.ruko/plan.json` di dalam workspace murni
 * merupakan proyeksi baca (read-only projection) — tidak pernah ditulis di sini.
 *
 * Invarian (PROGRESS2.md / blueprint):
 *  1. Dual-Plane State — otoritatif di host, proyeksi read-only di workspace.
 *  2. Fail-Safe Resume Reset — memuat ulang sesi yang pernah 'act' SELALU
 *     mendarat kembali di mode 'plan' dengan approvalScope dibatalkan.
 *
 * Hardening Win32 (temuan CI Windows PR #22): rename tmp→target rentan gagal
 * dengan EPERM/EACCES/EBUSY karena antivirus/indexer yang memegang handle
 * berkas sesaat — ditangani retry backoff eksponensial.
 *
 * ZERO dependency — hanya `node:*`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { constants as C } from 'node:fs';

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
 * backoff eksponensial khusus Windows (EPERM/EACCES/EBUSY dari AV/indexer).
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
}

/**
 * Memuat state sesi. Invarian Fail-Safe Resume Reset: state yang tersimpan
 * dalam mode 'act' direset mekanis ke 'plan' (approvalScope dibatalkan) setiap
 * kali dibaca kembali — resume tanpa pengecualian. Bila state tidak ada/rusak,
 * state baru dibuat dalam mode 'plan' (fail-closed).
 */
export async function loadHostState(sessionId: string, opts: { resume?: boolean } = { resume: true }): Promise<HostState> {
  validateSessionId(sessionId);
  const target = path.join(hostDir(), sessionId, 'state.json');
  try {
    const raw = await fs.readFile(target, 'utf8');
    const state = JSON.parse(raw) as HostState;
    if (opts.resume !== false && state.mode === 'act') {
      state.mode = 'plan';
      state.approvalScope = null;
    }
    return state;
  } catch {
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
}
