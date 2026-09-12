import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  funAnimations?: boolean;
  profiles?: Record<string, ProviderProfile>;
  defaultProfile?: string;
  activeProfile?: string;
  guardianEnabled?: boolean;
  guardianTimeoutMs?: number;
}

export function defaultConfigPath(): string {
  return process.env.RUKO_CONFIG ?? join(process.cwd(), '.ruko', 'config.json');
}

/**
 * Validates and sanitizes raw JSON parsed from a config file (M1 & H3).
 * Ignores invalid types, clamps numeric ranges, and filters empty allowlist items.
 * Rejects insecure remote HTTP baseUrls to prevent credential exfiltration.
 */
export function sanitizeConfigFile(raw: unknown): Partial<RukoConfigFile> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const clean: Partial<RukoConfigFile> = {};

  if (typeof obj.maxLogChars === 'number' && obj.maxLogChars > 0 && Number.isFinite(obj.maxLogChars)) {
    clean.maxLogChars = Math.min(Math.trunc(obj.maxLogChars), 1_000_000);
  }
  if (typeof obj.maxContextChars === 'number' && obj.maxContextChars > 0 && Number.isFinite(obj.maxContextChars)) {
    clean.maxContextChars = Math.min(Math.trunc(obj.maxContextChars), 10_000_000);
  }
  if (typeof obj.execTimeoutMs === 'number' && obj.execTimeoutMs > 0 && Number.isFinite(obj.execTimeoutMs)) {
    clean.execTimeoutMs = Math.min(Math.trunc(obj.execTimeoutMs), 3_600_000);
  }
  if (typeof obj.approvalEnabled === 'boolean') {
    clean.approvalEnabled = obj.approvalEnabled;
  }
  if (Array.isArray(obj.approvalAllowlist)) {
    clean.approvalAllowlist = obj.approvalAllowlist
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
  }
  if (typeof obj.model === 'string' && obj.model.trim()) {
    clean.model = obj.model.trim();
  }
  if (typeof obj.apiKey === 'string') {
    clean.apiKey = obj.apiKey;
  }
  if (typeof obj.baseUrl === 'string' && obj.baseUrl.trim()) {
    const trimmedUrl = obj.baseUrl.trim();
    try {
      const parsed = new URL(trimmedUrl);
      const isHttp = parsed.protocol === 'http:';
      const isHttps = parsed.protocol === 'https:';
      if (!isHttp && !isHttps) {
        console.warn(`[config] Mengabaikan baseUrl "${trimmedUrl}": protokol harus http atau https.`);
      } else if (isHttp && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        // H3: Insecure remote HTTP transmits API key unencrypted over the wire
        console.warn(`[config] Mengabaikan baseUrl "${trimmedUrl}": HTTP tidak aman untuk host remote (gunakan HTTPS atau localhost).`);
      } else {
        clean.baseUrl = trimmedUrl;
      }
    } catch {
      console.warn(`[config] Mengabaikan baseUrl "${trimmedUrl}": URL tidak valid.`);
    }
  }
  if (obj.mode === 'beginner' || obj.mode === 'pro') {
    clean.mode = obj.mode;
  }
  if (typeof obj.role === 'string' && obj.role.trim()) {
    clean.role = obj.role.trim();
  }
  if (typeof obj.funAnimations === 'boolean') {
    clean.funAnimations = obj.funAnimations;
  }
  if (typeof obj.guardianEnabled === 'boolean') {
    clean.guardianEnabled = obj.guardianEnabled;
  }
  if (typeof obj.guardianTimeoutMs === 'number' && obj.guardianTimeoutMs > 0 && Number.isFinite(obj.guardianTimeoutMs)) {
    clean.guardianTimeoutMs = Math.min(Math.trunc(obj.guardianTimeoutMs), 60_000);
  }
  if (obj.profiles && typeof obj.profiles === 'object' && !Array.isArray(obj.profiles)) {
    clean.profiles = obj.profiles as Record<string, ProviderProfile>;
  }
  if (typeof obj.defaultProfile === 'string' && obj.defaultProfile.trim()) {
    clean.defaultProfile = obj.defaultProfile.trim();
  }
  if (typeof obj.activeProfile === 'string' && obj.activeProfile.trim()) {
    clean.activeProfile = obj.activeProfile.trim();
  }

  return clean;
}

/** Loads config: defaults ← config file (credentials not yet resolved). */
export function loadConfig(path = defaultConfigPath()): AgentConfig {
  const base: AgentConfig = { ...DEFAULT_CONFIG };
  if (!existsSync(path)) return base;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const file = sanitizeConfigFile(parsed);
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
  try {
    chmodSync(path, 0o600); // M2: enforce owner-only permissions on POSIX
  } catch {
    // Best-effort on filesystems without POSIX permissions
  }
}
