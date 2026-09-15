import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { Buffer } from 'node:buffer';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * File-change undo safety net (feedback §6 "undo sebelum tiap perubahan").
 *
 * Before every write_file / edit_file / patch_file the CLI snapshots the OLD
 * content under `.ruko/undo/` so `/undo` can restore it — works in non-git
 * folders too and needs no git knowledge from the user.
 *
 * Snapshot pair per change:
 *   <id>.content     — old bytes (empty file when the path did not exist)
 *   <id>.meta.json   — { abs, existed }
 * ids are `Date.now()` + a monotonic counter to stay unique within a ms.
 */

export interface UndoSnapshot {
  id: string;
  abs: string;
  /** True when the file existed before the change (undo = restore content). */
  existed: boolean;
}

export function defaultUndoDir(): string {
  return process.env.RUKO_UNDO_DIR ?? join(process.cwd(), '.ruko', 'undo');
}

/** Keep at most this many snapshots (oldest pruned automatically). */
const MAX_SNAPSHOTS = 25;

let seq = 0;

/** Stores the current content of `abs` BEFORE it changes; returns the snapshot. */
export function takeSnapshot(abs: string, dir = defaultUndoDir()): UndoSnapshot {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existed = existsSync(abs) && statSync(abs).isFile();
  const id = `${Date.now()}-${(seq += 1)}`;
  const snapshot: UndoSnapshot = { id, abs, existed };
  const contentPath = join(dir, `${id}.content`);
  const metaPath = join(dir, `${id}.meta.json`);
  writeFileSync(contentPath, existed ? readFileSync(abs) : Buffer.alloc(0), { mode: 0o600 });
  writeFileSync(metaPath, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 });
  prune(dir);
  return snapshot;
}

/** Lists snapshots oldest → newest. */
export function listSnapshots(dir = defaultUndoDir()): UndoSnapshot[] {
  if (!existsSync(dir)) return [];
  const out: UndoSnapshot[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.meta.json')) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, file), 'utf8')) as UndoSnapshot);
    } catch {
      // corrupt meta — skip
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface UndoResult {
  restored: string;
  /** 'restored' = old content written back; 'deleted' = file was new, removed. */
  action: 'restored' | 'deleted';
}

/**
 * Reverts the most recent (not-yet-undone) snapshot. Returns null when the
 * undo journal is empty. Consumes the snapshot pair after applying it.
 */
export function undoLast(dir = defaultUndoDir()): UndoResult | null {
  const snapshots = listSnapshots(dir);
  const last = snapshots[snapshots.length - 1];
  if (!last) return null;
  const contentPath = join(dir, `${last.id}.content`);
  if (last.existed) {
    mkdirSync(dirname(last.abs), { recursive: true });
    writeFileSync(last.abs, existsSync(contentPath) ? readFileSync(contentPath) : Buffer.alloc(0));
  } else {
    rmSync(last.abs, { force: true });
  }
  rmSync(contentPath, { force: true });
  rmSync(join(dir, `${last.id}.meta.json`), { force: true });
  return { restored: last.abs, action: last.existed ? 'restored' : 'deleted' };
}

/** Drops snapshot pairs older than the configured window. */
function prune(dir: string): void {
  const metas = readdirSync(dir).filter((f) => f.endsWith('.meta.json')).sort();
  const excess = metas.length - MAX_SNAPSHOTS;
  if (excess <= 0) return;
  for (const meta of metas.slice(0, excess)) {
    const id = meta.replace(/\.meta\.json$/, '');
    rmSync(join(dir, `${id}.meta.json`), { force: true });
    rmSync(join(dir, `${id}.content`), { force: true });
  }
}

export interface RevertOptions {
  /** Directory where .ruko/undo snapshots are stored. */
  dir?: string;
  /** Workspace root path for git rollback and relative path resolving. */
  workspaceRoot?: string;
  /**
   * Revert strategy:
   * - 'auto': prefer local snapshot, fallback to git checkout if no snapshot exists
   * - 'snapshot': only restore from local snapshot
   * - 'git': directly revert via git checkout
   */
  mode?: 'auto' | 'snapshot' | 'git';
}

export interface RevertResult {
  ok: boolean;
  restored?: string;
  action?: 'restored' | 'deleted' | 'reverted_git';
  source?: 'snapshot' | 'git';
  message?: string;
  error?: string;
}

/**
 * Reverts the most recent snapshot for a specific file path.
 * Returns null if no snapshot exists for that file.
 * Consumes the matched snapshot pair upon restoration.
 */
export function revertFileSnapshot(abs: string, dir = defaultUndoDir()): UndoResult | null {
  const normTarget = resolve(abs);
  const snapshots = listSnapshots(dir);
  let matchIndex = -1;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (resolve(snapshots[i].abs) === normTarget) {
      matchIndex = i;
      break;
    }
  }
  if (matchIndex === -1) return null;
  const target = snapshots[matchIndex];
  const contentPath = join(dir, `${target.id}.content`);
  if (target.existed) {
    mkdirSync(dirname(target.abs), { recursive: true });
    writeFileSync(target.abs, existsSync(contentPath) ? readFileSync(contentPath) : Buffer.alloc(0));
  } else {
    rmSync(target.abs, { force: true });
  }
  rmSync(contentPath, { force: true });
  rmSync(join(dir, `${target.id}.meta.json`), { force: true });
  return { restored: target.abs, action: target.existed ? 'restored' : 'deleted' };
}

/**
 * Reverts changes to a file using git checkout -- <file>.
 */
export function revertFileGit(abs: string, workspaceRoot: string = process.cwd()): { ok: boolean; error?: string } {
  try {
    const rel = relative(workspaceRoot, abs);
    execFileSync('git', ['checkout', '--', rel], {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { ok: true };
  } catch (err: any) {
    const stderr = (err?.stderr ? String(err.stderr) : (err?.message ?? String(err))).trim();
    return { ok: false, error: stderr };
  }
}

/**
 * Reverts changes to a specified file via snapshot or git.
 */
export function revertFile(targetPath: string, options: RevertOptions = {}): RevertResult {
  const dir = options.dir ?? defaultUndoDir();
  const ws = options.workspaceRoot ?? process.cwd();
  const abs = isAbsolute(targetPath) ? targetPath : resolve(ws, targetPath);
  const mode = options.mode ?? 'auto';
  const rel = relative(ws, abs) || targetPath;

  if (mode === 'snapshot' || mode === 'auto') {
    const snapshotRes = revertFileSnapshot(abs, dir);
    if (snapshotRes) {
      return {
        ok: true,
        restored: snapshotRes.restored,
        action: snapshotRes.action,
        source: 'snapshot',
        message:
          snapshotRes.action === 'restored'
            ? `File "${rel}" berhasil dikembalikan ke versi sebelum edit (snapshot undo).`
            : `File baru "${rel}" berhasil dihapus sesuai riwayat snapshot undo.`,
      };
    }
    if (mode === 'snapshot') {
      return {
        ok: false,
        error: `Tidak ada snapshot undo yang ditemukan untuk file "${rel}".`,
      };
    }
  }

  const gitRes = revertFileGit(abs, ws);
  if (gitRes.ok) {
    return {
      ok: true,
      restored: abs,
      action: 'reverted_git',
      source: 'git',
      message: `File "${rel}" berhasil di-revert ke versi git (git checkout -- ${rel}).`,
    };
  }

  return {
    ok: false,
    error:
      mode === 'git'
        ? `Gagal melakukan git checkout pada "${rel}": ${gitRes.error}`
        : `Tidak ada snapshot undo untuk "${rel}" dan git rollback gagal: ${gitRes.error}`,
  };
}

