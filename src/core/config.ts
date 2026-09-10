import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AgentConfig,
  DEFAULT_CONFIG,
  ProviderProfile,
  UiMode,
  resolveProfileCredentials,
} from '../types.js';

/**
 * Config file support — settings live in `.ruko/config.json` (or the path in
 * the `RUKO_CONFIG` env var). Missing fields fall back to DEFAULT_CONFIG.
 * The file may contain API keys, so it is written with owner-only perms (600).
 */

export interface RukoConfigFile {
  maxLogChars?: number;
  maxContextChars?: number;
  execTimeoutMs?: number;
  approvalEnabled?: boolean;
  approvalAllowlist?: string[];
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  mode?: UiMode;
  role?: string;
  profiles?: Record<string, ProviderProfile>;
  defaultProfile?: string;
  activeProfile?: string;
}

export function defaultConfigPath(): string {
  return process.env.RUKO_CONFIG ?? join(process.cwd(), '.ruko', 'config.json');
}

/** Loads config: defaults ← config file (credentials not yet resolved). */
export function loadConfig(path = defaultConfigPath()): AgentConfig {
  const base: AgentConfig = { ...DEFAULT_CONFIG };
  if (!existsSync(path)) return base;
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as RukoConfigFile;
    return {
      ...base,
      ...file,
      approvalAllowlist: file.approvalAllowlist ?? base.approvalAllowlist,
      profiles: file.profiles ?? base.profiles,
    };
  } catch (err) {
    console.error(
      `[config] Gagal membaca ${path}: ${err instanceof Error ? err.message : String(err)} — memakai default.`,
    );
    return base;
  }
}

/**
 * Loads the config AND applies the active profile (§2): profile baseUrl/model
 * and its apiKeyEnv/apiKey override the top-level fields when present.
 */
export function loadResolvedConfig(path = defaultConfigPath()): AgentConfig {
  return resolveProfileCredentials(loadConfig(path));
}

/** Persists the full config back to disk (used by /model, /config ...). */
export function saveConfig(config: AgentConfig, path = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}
