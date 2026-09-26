/**
 * Live bottom activity tray (feedback §4 — "Anti-Nyampah / In-Place Update").
 *
 * The tray owns the STATE of everything currently running (tool calls,
 * delegated subagents, background processes). It is deliberately I/O free:
 *
 *  - the LineEditor draws `renderRows()` INSIDE its managed live region, so
 *    the rows are repainted in place with `ESC[2K` + cursor repositioning on
 *    every frame and erased when the region is torn down — never appended to
 *    scrollback with `console.log()` (the bug this exists to kill);
 *  - the permanent history line for a finished action is printed ONCE by the
 *    workflow tree (`├── …`, see `formatActionLogLine`), so the tray never
 *    duplicates it.
 *
 * Zero third-party dependencies: node:events + ANSI only.
 */

import { EventEmitter } from 'node:events';
import { dim, formatDuration, terminalWidth, truncateVisible, visibleLength } from './ui.js';

/** One running item shown in the bottom tray. */
export interface Activity {
  id: string;
  /** Short human label, e.g. `npm test` or `Subagent (read_file) halo.md`. */
  label: string;
  /** Leading glyph, e.g. `🟢`, `🟣`. */
  icon: string;
  /** Group tag so a producer (tools / background processes) can resync its own set. */
  group: string;
  /** Epoch ms the item started — the tray renders `now - startedAt`. */
  startedAt: number;
}

export interface ActivityStartOptions {
  icon?: string;
  group?: string;
  startedAt?: number;
}

export interface ActivityTrayOptions {
  /** Injectable clock (tests). */
  now?: () => number;
  /** Rows shown before the `-- N more` overflow hint (default 2). */
  maxRows?: number;
}

/** `45s`, `23s`, `1m 4s` — short elapsed label for the tray rows. */
export function formatTrayDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${Math.floor(sec)}s`;
  return formatDuration(ms);
}

/** `🟢 npm test                        45s` — duration right-aligned, never wrapping. */
export function formatActivityRow(activity: Activity, nowMs: number, width: number): string {
  const duration = formatTrayDuration(Math.max(0, nowMs - activity.startedAt));
  const w = Math.max(12, width);
  const left = `${activity.icon} ${activity.label}`;
  const text = truncateVisible(left, Math.max(4, w - visibleLength(duration) - 1));
  const gap = Math.max(1, w - visibleLength(text) - visibleLength(duration));
  return `${text}${' '.repeat(gap)}${dim(duration)}`;
}

/**
 * Tracks running activities and renders the bottom tray rows.
 *
 * Emits `change` whenever the visible set (or a label) actually changes, so a
 * renderer can repaint immediately instead of waiting for the next tick.
 */
export class ActivityTray extends EventEmitter {
  private readonly items = new Map<string, Activity>();
  private readonly now: () => number;
  private readonly maxRows: number;
  /** Ctrl+O toggle: show every row instead of `maxRows` + overflow hint. */
  expanded = false;

  constructor(options: ActivityTrayOptions = {}) {
    super();
    this.now = options.now ?? (() => Date.now());
    this.maxRows = Math.max(1, options.maxRows ?? 2);
  }

  /** Registers a running activity (no-op when the id is already present). */
  start(id: string, label: string, options: ActivityStartOptions = {}): Activity {
    const existing = this.items.get(id);
    if (existing) {
      this.update(id, { label });
      return this.items.get(id)!;
    }
    const activity: Activity = {
      id,
      label,
      icon: options.icon ?? '🟢',
      group: options.group ?? 'tool',
      startedAt: options.startedAt ?? this.now(),
    };
    this.items.set(id, activity);
    this.emit('change');
    return activity;
  }

  /** Updates a running activity's label/icon in place. */
  update(id: string, patch: Partial<Pick<Activity, 'label' | 'icon'>>): void {
    const activity = this.items.get(id);
    if (!activity) return;
    let changed = false;
    if (patch.label !== undefined && patch.label !== activity.label) {
      activity.label = patch.label;
      changed = true;
    }
    if (patch.icon !== undefined && patch.icon !== activity.icon) {
      activity.icon = patch.icon;
      changed = true;
    }
    if (changed) this.emit('change');
  }

  /** Drops a finished activity. Returns true when something was removed. */
  finish(id: string): boolean {
    const removed = this.items.delete(id);
    if (removed) this.emit('change');
    return removed;
  }

  /**
   * Replaces every activity of one group (e.g. background processes) with the
   * given set. Existing ids keep their original `startedAt`, so the elapsed
   * timer of a long-running process survives the resync.
   */
  syncGroup(
    group: string,
    entries: Array<{ id: string; label: string; icon?: string; startedAt?: number }>,
  ): void {
    const wanted = new Map(entries.map((e) => [e.id, e]));
    let changed = false;
    for (const [id, activity] of [...this.items]) {
      if (activity.group === group && !wanted.has(id)) {
        this.items.delete(id);
        changed = true;
      }
    }
    for (const entry of entries) {
      const existing = this.items.get(entry.id);
      if (existing) {
        if (entry.label !== existing.label) {
          existing.label = entry.label;
          changed = true;
        }
        continue;
      }
      this.items.set(entry.id, {
        id: entry.id,
        label: entry.label,
        icon: entry.icon ?? '🟢',
        group,
        startedAt: entry.startedAt ?? this.now(),
      });
      changed = true;
    }
    if (changed) this.emit('change');
  }

  get(id: string): Activity | undefined {
    return this.items.get(id);
  }

  /** Running activities, oldest first (stable order for in-place rows). */
  list(): Activity[] {
    return [...this.items.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  size(): number {
    return this.items.size;
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.emit('change');
  }

  toggleExpanded(): boolean {
    this.expanded = !this.expanded;
    this.emit('change');
    return this.expanded;
  }

  /**
   * Tray rows, ready to be drawn in place below the input line:
   *
   *   🟣 Subagent (read_file) halo.md    23s
   *   🟢 npm test                        45s
   *   -- 2 more, ctrl+o to expand
   *
   * Returns `[]` when nothing is running (the tray occupies no rows at all).
   */
  renderRows(
    options: { width?: number; now?: number; maxRows?: number; expanded?: boolean } = {},
  ): string[] {
    const items = this.list();
    if (items.length === 0) return [];
    const width = Math.max(12, (options.width ?? terminalWidth()) - 1);
    const now = options.now ?? this.now();
    const maxRows = Math.max(1, options.maxRows ?? this.maxRows);
    const expanded = options.expanded ?? this.expanded;
    const visible = expanded ? items : items.slice(0, maxRows);
    const rows = visible.map((a) => formatActivityRow(a, now, width));
    const hidden = items.length - visible.length;
    // Fase 5: hint `-- N more, ctrl+o to expand` HANYA muncul bila ada >= 2
    // task aktif (satu task tunggal tidak pernah menampilkan hint) — handler
    // Ctrl+O existing tetap dipakai untuk expand/collapse.
    if (hidden > 0 && items.length >= 2) rows.push(dim(`-- ${hidden} more, ctrl+o to expand`));
    return rows;
  }
}
