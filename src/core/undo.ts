import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

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
  mkdirSync(dir, { recursive: true });
  const existed = existsSync(abs) && statSync(abs).isFile();
  const id = `${Date.now()}-${(seq += 1)}`;
  const snapshot: UndoSnapshot = { id, abs, existed };
  writeFileSync(join(dir, `${id}.content`), existed ? readFileSync(abs) : Buffer.alloc(0));
  writeFileSync(join(dir, `${id}.meta.json`), `${JSON.stringify(snapshot)}\n`, 'utf8');
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
