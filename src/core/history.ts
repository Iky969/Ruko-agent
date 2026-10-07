import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * REPL Input History Persistence (Roadmap #11).
 *
 * Saves command line input history to `<workspace>/.ruko/history` (mode 0600)
 * so that Up/Down arrow navigation persists across terminal restarts.
 */

export const MAX_HISTORY_ENTRIES = 1_000;

/**
 * WP-02 (v2.1.0): pola kredensial yang TIDAK boleh tersimpan apa adanya di
 * riwayat perintah (`.ruko/history`). Riwayat adalah berkas plaintext berumur
 * panjang, jadi nilai setelah kata kunci kredensial selalu di-redaksi sebelum
 * ditulis (mis. `export API_KEY=sk-...` → `export API_KEY=[REDACTED]`).
 */
export const SECRET_HISTORY_PATTERN =
  /(api[_-]?key|token|secret|password|bearer)\s*[:=]|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i;

const SECRET_VALUE_RE = /((?:api[_-]?key|token|secret|password|bearer)\s*[:=]\s*)([^\s"'`]+)/gi;

/** Header/token gaya `Bearer <nilai>` (dipisah spasi, bukan `:` / `=`). */
const BEARER_VALUE_RE = /\b(bearer)\s+([A-Za-z0-9._~+/=-]{8,})/gi;

/** Mengganti nilai kredensial pada satu baris riwayat dengan `[REDACTED]`. */
export function redactHistoryEntry(entry: string): string {
  let out = entry.replace(SECRET_VALUE_RE, '$1[REDACTED]');
  // Nilai berkutip: KEY="secret value" → KEY="[REDACTED]"
  out = out.replace(
    /((?:api[_-]?key|token|secret|password|bearer)\s*[:=]\s*)("[^"]*"|'[^']*'|`[^`]*`)/gi,
    '$1[REDACTED]',
  );
  // Bentuk header tanpa pemisah `:` / `=`: `Bearer ghp_xxx` → `Bearer [REDACTED]`
  out = out.replace(BEARER_VALUE_RE, '$1 [REDACTED]');
  return out;
}

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
  const raw = entry.trim();
  if (!raw) return;

  // WP-02: redaksi kredensial sebelum baris masuk ke `.ruko/history`.
  const clean = SECRET_HISTORY_PATTERN.test(raw) ? redactHistoryEntry(raw) : raw;
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
