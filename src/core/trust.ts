import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bold, cyan, dim, green, yellow } from './ui.js';
import { defaultConfigPath, loadConfig, saveConfig } from './config.js';

export const TRUST_MARKER_FILE = 'trusted';

/**
 * Checks if the specified workspace directory is trusted.
 * A workspace is considered trusted if:
 * 1. RUKO_TRUST_FOLDER env var is set to '1' or 'true'.
 * 2. .ruko/trusted marker file exists in the workspace.
 * 3. .ruko/config.json has trustedWorkspace === true.
 */
export function isWorkspaceTrusted(
  cwd: string = process.cwd(),
  configPath: string = defaultConfigPath(),
): boolean {
  if (process.env.RUKO_TRUST_FOLDER === '1' || process.env.RUKO_TRUST_FOLDER === 'true') {
    return true;
  }
  const markerPath = join(cwd, '.ruko', TRUST_MARKER_FILE);
  if (existsSync(markerPath)) {
    return true;
  }
  try {
    const cfg = loadConfig(configPath);
    if (cfg.trustedWorkspace === true) {
      return true;
    }
  } catch {
    // Config read error, treat as untrusted
  }
  return false;
}

/**
 * Marks the workspace directory as trusted by writing the .ruko/trusted marker
 * and persisting trustedWorkspace: true to config.json.
 */
export function markWorkspaceTrusted(
  cwd: string = process.cwd(),
  configPath: string = defaultConfigPath(),
): void {
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
      await io.question(yellow('  Apakah kamu mempercayai folder ini? (y/n): '))
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
