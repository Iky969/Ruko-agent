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
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  mode?: UiMode;
  role?: string;
  funAnimations?: boolean;
  profiles?: Record<string, ProviderProfile>;
  defaultProfile?: string;
  activeProfile?: string;
  maxOutputTokens?: number;
  guardianEnabled?: boolean;
  guardianTimeoutMs?: number;
  trustedWorkspace?: boolean;
  maxToolIterations?: number;
}

export function defaultConfigPath(): string {
  return process.env.RUKO_CONFIG ?? join(process.cwd(), '.ruko', 'config.json');
}

/**
 * Checks if a hostname belongs to localhost, loopback, mDNS, or RFC 1918 private LAN IP.
 */
export function isPrivateOrLocalHost(hostname: string): boolean {
  if (!hostname) return false;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home')) return true;
  // RFC 1918 private IPv4:
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Checks if a given URL or hostname string strictly matches a target domain or is a subdomain of it.
 * Prevents CodeQL incomplete URL substring sanitization (e.g. matching attacker-anthropic.com or evil.com/anthropic.com).
 */
export function isHostnameOrSubdomain(urlString: string | null | undefined, targetDomain: string): boolean {
  if (!urlString || !targetDomain) return false;
  try {
    const raw = urlString.trim().replace(/^["'`]+|["'`]+$/g, '');
    if (!raw) return false;
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const host = url.hostname.toLowerCase();
    const target = targetDomain.toLowerCase();
    return host === target || host.endsWith(`.${target}`);
  } catch {
    return false;
  }
}

/**
 * Masks API key patterns for secure logging/display.
 * Shows first 3 chars and last 4 chars, masks middle.
 */
export function redactApiKey(text: string | null | undefined): string {
  if (!text) return '';
  if (typeof text !== 'string') return '';
  if (text.length < 10) return text;

  if (text.startsWith('sk-') || text.startsWith('key-') || /^[A-Za-z0-9\-_]{20,}$/.test(text)) {
    return `${text.substring(0, 3)}***${text.slice(-4)}`;
  }

  // Redact inline keys inside messages or stack traces
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/g, (m) => `${m.substring(0, 3)}***${m.slice(-4)}`)
    .replace(/\b(key-[A-Za-z0-9_-]{6,})\b/g, (m) => `${m.substring(0, 3)}***${m.slice(-4)}`);
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
  if (typeof obj.provider === 'string' && obj.provider.trim()) {
    clean.provider = obj.provider.trim();
  }
  if (typeof obj.maxOutputTokens === 'number' && obj.maxOutputTokens > 0 && Number.isFinite(obj.maxOutputTokens)) {
    clean.maxOutputTokens = Math.min(Math.trunc(obj.maxOutputTokens), 1_000_000);
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
      } else if (isHttp && !isPrivateOrLocalHost(parsed.hostname)) {
        // H3: Insecure remote HTTP transmits API key unencrypted over the wire
        console.warn(`[config] Mengabaikan baseUrl "${trimmedUrl}": HTTP tidak aman untuk host remote (gunakan HTTPS, localhost, atau jaringan lokal).`);
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
  if (typeof obj.trustedWorkspace === 'boolean') {
    clean.trustedWorkspace = obj.trustedWorkspace;
  }
  if (typeof obj.maxToolIterations === 'number' && obj.maxToolIterations > 0 && Number.isFinite(obj.maxToolIterations)) {
    clean.maxToolIterations = Math.min(Math.trunc(obj.maxToolIterations), 1_000);
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
