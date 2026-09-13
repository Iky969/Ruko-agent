import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * REPL Input History Persistence (Roadmap #11).
 *
 * Saves command line input history to `<workspace>/.ruko/history` (mode 0600)
 * so that Up/Down arrow navigation persists across terminal restarts.
 */

export const MAX_HISTORY_ENTRIES = 1_000;

export function defaultHistoryPath(workspaceRoot: string = process.cwd()): string {
  return join(workspaceRoot, '.ruko', 'history');
}

/** Loads history lines from file, newest at the end. */
export function loadHistory(filePath: string = defaultHistoryPath()): string[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
      .slice(-MAX_HISTORY_ENTRIES);
  } catch {
    return [];
  }
}

/**
 * Appends a single line to history file with 0600 permissions.
 * Avoids appending identical consecutive entries or masked secrets.
 */
export function appendHistory(
  entry: string,
  filePath: string = defaultHistoryPath(),
  maxEntries = MAX_HISTORY_ENTRIES,
): void {
  const clean = entry.trim();
  if (!clean) return;

  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const existing = loadHistory(filePath);
  // Avoid consecutive duplicates
  if (existing.length > 0 && existing[existing.length - 1] === clean) {
    return;
  }

  existing.push(clean);
  const trimmed = existing.slice(-maxEntries);

  writeFileSync(filePath, `${trimmed.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on filesystems without POSIX permissions
  }
}
