import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { bold, cyan, dim, green, yellow } from './ui.js';
import { defaultConfigPath, loadConfig, saveConfig } from './config.js';

export const TRUST_MARKER_FILE = 'trusted';

/**
 * TASK-03: Global trust store path.  Trust records live OUTSIDE any repository
 * so that a malicious clone cannot self-authorise by shipping a pre-made
 * `.ruko/trusted` file or `trustedWorkspace: true` in its config.
 *
 * Location: `~/.ruko/trusted-workspaces.json`
 */
export function globalTrustStorePath(): string {
  return join(homedir(), '.ruko', 'trusted-workspaces.json');
}

/**
 * SHA-256 hash of the canonical (resolved) workspace path.
 * Used as a stable, filesystem-safe identifier inside the global store.
 */
export function hashWorkspacePath(cwd: string): string {
  const canonical = resolve(cwd);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Reads the global trusted-workspaces store.  Returns a map of
 * `{ [pathHash]: { path, trustedAt } }`.
 */
function readGlobalTrustStore(): Record<string, { path: string; trustedAt: string }> {
  const storePath = globalTrustStorePath();
  try {
    if (!existsSync(storePath)) return {};
    const raw = JSON.parse(readFileSync(storePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as Record<string, { path: string; trustedAt: string }>;
  } catch {
    return {};
  }
}

/**
 * Writes the global trusted-workspaces store with owner-only permissions.
 */
function writeGlobalTrustStore(store: Record<string, { path: string; trustedAt: string }>): void {
  const storePath = globalTrustStorePath();
  try {
    mkdirSync(join(homedir(), '.ruko'), { recursive: true, mode: 0o700 });
    writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // Best-effort write
  }
}

/**
 * Checks if the specified workspace directory is trusted.
 *
 * TASK-03 — Trust sources checked in order:
 *   1. `RUKO_TRUST_FOLDER` env var (CI escape hatch).
 *   2. **Global trust store** `~/.ruko/trusted-workspaces.json` (PRIMARY —
 *      lives outside the repo, immune to supply-chain attacks).
 *   3. Legacy: `.ruko/trusted` marker in the workspace (backward compat, with
 *      deprecation warning).
 *   4. Legacy: `.ruko/config.json` `trustedWorkspace === true` (backward compat,
 *      with deprecation warning).
 *
 * When trust is found via a legacy source (3 or 4), the workspace is
 * auto-migrated to the global store and a one-time warning is emitted.
 */
export function isWorkspaceTrusted(
  cwd: string = process.cwd(),
  configPath: string = defaultConfigPath(),
): boolean {
  // Source 1: env var bypass (L1 — documented CI escape hatch)
  if (process.env.RUKO_TRUST_FOLDER === '1' || process.env.RUKO_TRUST_FOLDER === 'true') {
    console.warn(
      '[trust] ⚠ RUKO_TRUST_FOLDER aktif — pemeriksaan kepercayaan folder DILEWATI. ' +
        'Hanya gunakan env var ini di lingkungan yang benar-benar tepercaya (mis. container CI sementara).',
    );
    return true;
  }

  // Source 2: global trust store (TASK-03 — primary, secure)
  const hash = hashWorkspacePath(cwd);
  const store = readGlobalTrustStore();
  if (store[hash]) {
    return true;
  }

  // Source 3: legacy .ruko/trusted marker (backward compat)
  const markerPath = join(cwd, '.ruko', TRUST_MARKER_FILE);
  if (existsSync(markerPath)) {
    console.warn(
      '[trust] ⚠ Trust ditemukan di .ruko/trusted (legacy). ' +
        'Migrasi otomatis ke ~/.ruko/trusted-workspaces.json. ' +
        'File .ruko/trusted di dalam repo bisa berbahaya jika berasal dari clone repo asing.',
    );
    // Auto-migrate to global store
    addToGlobalTrustStore(cwd);
    return true;
  }

  // Source 4: legacy config.json trustedWorkspace (backward compat)
  try {
    const cfg = loadConfig(configPath);
    if (cfg.trustedWorkspace === true) {
      console.warn(
        '[trust] ⚠ Trust ditemukan di config.json trustedWorkspace (legacy). ' +
          'Migrasi otomatis ke ~/.ruko/trusted-workspaces.json.',
      );
      // Auto-migrate to global store
      addToGlobalTrustStore(cwd);
      return true;
    }
  } catch {
    // Config read error, treat as untrusted
  }

  return false;
}

/**
 * Adds a workspace to the global trust store.
 */
function addToGlobalTrustStore(cwd: string): void {
  const hash = hashWorkspacePath(cwd);
  const store = readGlobalTrustStore();
  store[hash] = {
    path: resolve(cwd),
    trustedAt: new Date().toISOString(),
  };
  writeGlobalTrustStore(store);
}

/**
 * TASK-03: Marks the workspace directory as trusted.
 *
 * Primary: writes to the global trust store (~/.ruko/trusted-workspaces.json).
 * Legacy: still writes .ruko/trusted and config for backward compatibility,
 *         but these will be deprecated in a future version.
 */
export function markWorkspaceTrusted(
  cwd: string = process.cwd(),
  configPath: string = defaultConfigPath(),
): void {
  // PRIMARY: global trust store
  addToGlobalTrustStore(cwd);

  // LEGACY: .ruko/trusted marker (backward compat — will be removed)
  const rukoDir = join(cwd, '.ruko');
  try {
    mkdirSync(rukoDir, { recursive: true });
    const markerPath = join(rukoDir, TRUST_MARKER_FILE);
    writeFileSync(
      markerPath,
      JSON.stringify({ trustedAt: new Date().toISOString(), cwd }, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    // Best-effort marker write
  }

  // LEGACY: config.json trustedWorkspace (backward compat)
  try {
    const cfg = loadConfig(configPath);
    cfg.trustedWorkspace = true;
    saveConfig(cfg, configPath);
  } catch {
    // Best-effort config save
  }
}

/**
 * Interactively prompts the user to verify if they trust the current workspace/folder.
 * Returns true if trusted, false otherwise.
 */
export async function promptWorkspaceTrust(
  io: { question: (q: string) => Promise<string> },
  cwd: string = process.cwd(),
  configPath: string = defaultConfigPath(),
): Promise<boolean> {
  console.log('');
  console.log(bold(cyan('  [Keamanan Workspace Ruko]')));
  console.log(dim(`  Folder aktif: ${cwd}`));
  console.log(dim('  Ruko dapat membaca berkas dan menjalankan perintah shell di folder ini.'));
  console.log('');

  try {
    const answer = (
      await io.question(yellow('  Percayai folder? (y/n): '))
    ).trim().toLowerCase();

    if (/^(y|yes|ya)$/i.test(answer)) {
      markWorkspaceTrusted(cwd, configPath);
      console.log(green('  ✓ Folder dipercayai. Memulai Ruko...\n'));
      return true;
    }
  } catch {
    // Ctrl+C / EOF
  }

  return false;
}
