import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AgentConfig, DEFAULT_CONFIG } from '../types.js';

/**
 * Config file support — settings live in `.ruko/config.json` (or the path in
 * the `RUKO_CONFIG` env var). Missing fields fall back to DEFAULT_CONFIG.
 */

export interface RukoConfigFile {
  maxLogChars?: number;
  maxContextChars?: number;
  execTimeoutMs?: number;
  approvalEnabled?: boolean;
  approvalAllowlist?: string[];
  model?: string;
}

export function defaultConfigPath(): string {
  return process.env.RUKO_CONFIG ?? join(process.cwd(), '.ruko', 'config.json');
}

/** Loads config: defaults ← config file. */
export function loadConfig(path = defaultConfigPath()): AgentConfig {
  const base: AgentConfig = { ...DEFAULT_CONFIG };
  if (!existsSync(path)) return base;
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as RukoConfigFile;
    return {
      ...base,
      ...file,
      approvalAllowlist: file.approvalAllowlist ?? base.approvalAllowlist,
    };
  } catch (err) {
    console.error(
      `[config] Gagal membaca ${path}: ${err instanceof Error ? err.message : String(err)} — memakai default.`,
    );
    return base;
  }
}

/** Persists the full config back to disk (used by /model, /config ...). */
export function saveConfig(config: AgentConfig, path = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}