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
 * Checks if a hostname belongs to localhost, loopback, mDNS, RFC 1918 private
 * LAN IP, IPv6 ULA, IPv6 link-local, or an IPv4-mapped IPv6 form of any of
 * those (H6).
 *
 * Fails closed: anything that *looks* like a local/internal address counts as
 * private, because a false positive here only means an HTTP base URL gets
 * rejected (or must be explicitly confirmed), while a false negative would let
 * an SSRF target through.
 */
export function isPrivateOrLocalHost(hostname: string): boolean {
  if (!hostname) return false;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h === '::') return true;
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home')) return true;

  // H6: unwrap IPv4-mapped IPv6 (::ffff:10.0.0.1 and ::ffff:a00:1) and
  // evaluate the embedded IPv4 address instead of the wrapper notation.
  let check = h;
  const mappedDotted = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedDotted) {
    check = mappedDotted[1];
  } else {
    const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const high = parseInt(mappedHex[1], 16);
      const low = parseInt(mappedHex[2], 16);
      check = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    }
  }

  // RFC 1918 private IPv4 + loopback + link-local (cloud metadata 169.254.169.254):
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(check)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(check)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(check)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(check)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(check)) return true;

  // H6: IPv6 Unique Local Address fc00::/7 (fc00:: – fdff::)
  //     IPv6 link-local unicast fe80::/10 (fe80:: – febf::)
  // The colon is required so ordinary hostnames such as "fcorp.com" or
  // "fd.example.com" are not mistaken for IPv6 literals.
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]{0,2}:/.test(h)) return true;

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
    const candidate = raw.includes('://') ? raw : `https://${raw}`;
    // M3: reject any authority that carries userinfo (`http://user@host`).
    // `http://user@anthropic.com@evil.com` resolves to `evil.com` in the URL
    // parser but to `anthropic.com` in other consumers (proxies, logs, older
    // runtimes), so a URL with an `@` in its authority is never a trustworthy
    // domain match.
    const authority = candidate.slice(candidate.indexOf('://') + 3).split(/[/?#]/)[0];
    if (authority.includes('@')) return false;
    const url = new URL(candidate);
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    const target = targetDomain.toLowerCase();
    return host === target || host.endsWith(`.${target}`);
  } catch {
    return false;
  }
}

/** H5: strings shorter than this cannot be a real credential — left untouched. */
const MIN_REDACTABLE_KEY_LENGTH = 10;
/** H5: keys shorter than this reveal no characters at all. */
const SHORT_KEY_THRESHOLD = 40;

/**
 * Masks API key patterns for secure logging/display (H5).
 *
 * Masking rules (a short key must not be identifiable from logs):
 *   - < 10 chars   → returned as-is (too short to be a credential; keeps short
 *                    non-secret strings such as "short" readable)
 *   - 10–39 chars  → "[REDACTED]"  (no key character is revealed)
 *   - 40+ chars    → "[REDACTED...xxxx]" (last 4 chars only, for key rotation)
 *
 * Free-form text (error messages, stack traces) is preserved as-is, but any
 * embedded `sk-…` / `key-…` token is masked with the same rules.
 */
export function redactApiKey(text: string | null | undefined): string {
  if (!text) return '';
  if (typeof text !== 'string') return '';

  const maskKey = (key: string): string =>
    key.length < SHORT_KEY_THRESHOLD ? '[REDACTED]' : `[REDACTED...${key.slice(-4)}]`;

  // A single bare token (no spaces/punctuation) is treated as the key itself.
  const isBareToken = /^[A-Za-z0-9_-]+$/.test(text);
  if (isBareToken) {
    if (text.length < MIN_REDACTABLE_KEY_LENGTH) return text;
    const looksLikeKey = text.startsWith('sk-') || text.startsWith('key-') || /^[A-Za-z0-9_-]{20,}$/.test(text);
    if (!looksLikeKey) return text;
    return maskKey(text);
  }

  // Redact inline keys inside messages or stack traces
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/g, (m) => maskKey(m))
    .replace(/\b(key-[A-Za-z0-9_-]{6,})\b/g, (m) => maskKey(m));
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
    // M2: trim, and drop empty/whitespace-only values instead of storing them —
    // a blank apiKey used to be kept verbatim and produced confusing auth
    // errors far away from the config file.
    const trimmedApiKey = obj.apiKey.trim();
    if (trimmedApiKey) {
      clean.apiKey = trimmedApiKey;
    } else {
      console.warn('[config] Mengabaikan apiKey kosong/whitespace di berkas config.');
    }
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
    const rawProfiles = obj.profiles as Record<string, unknown>;
    const sanitizedProfiles: Record<string, ProviderProfile> = {};
    for (const [alias, rawProfile] of Object.entries(rawProfiles)) {
      if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) continue;
      const p = rawProfile as Record<string, unknown>;
      const sp: ProviderProfile = {};

      // Sanitize provider
      if (typeof p.provider === 'string' && p.provider.trim()) {
        sp.provider = p.provider.trim();
      }
      // Sanitize model
      if (typeof p.model === 'string' && p.model.trim()) {
        sp.model = p.model.trim();
      }
      // Sanitize baseUrl — identical validation to the top-level baseUrl (TASK-01)
      if (typeof p.baseUrl === 'string' && p.baseUrl.trim()) {
        const trimmedUrl = p.baseUrl.trim();
        try {
          const parsed = new URL(trimmedUrl);
          const isHttp = parsed.protocol === 'http:';
          const isHttps = parsed.protocol === 'https:';
          if (!isHttp && !isHttps) {
            console.warn(`[config] Mengabaikan baseUrl profil "${alias}": protokol harus http atau https.`);
          } else if (isHttp && !isPrivateOrLocalHost(parsed.hostname)) {
            console.warn(`[config] Mengabaikan baseUrl profil "${alias}" ("${trimmedUrl}"): HTTP tidak aman untuk host remote (gunakan HTTPS, localhost, atau jaringan lokal).`);
          } else {
            sp.baseUrl = trimmedUrl;
          }
        } catch {
          console.warn(`[config] Mengabaikan baseUrl profil "${alias}" ("${trimmedUrl}"): URL tidak valid.`);
        }
      }
      // Sanitize apiKey (trim, drop empty)
      if (typeof p.apiKey === 'string') {
        const trimmedKey = p.apiKey.trim();
        if (trimmedKey) {
          sp.apiKey = trimmedKey;
        }
      }
      // Sanitize apiKeyEnv — whitelist only known LLM provider env vars (TASK-02)
      if (typeof p.apiKeyEnv === 'string' && p.apiKeyEnv.trim()) {
        const envName = p.apiKeyEnv.trim();
        if (ALLOWED_API_KEY_ENV_VARS.has(envName)) {
          sp.apiKeyEnv = envName;
        } else {
          console.warn(`[config] Mengabaikan apiKeyEnv profil "${alias}" ("${envName}"): hanya env var LLM resmi yang diizinkan (${[...ALLOWED_API_KEY_ENV_VARS].join(', ')}).`);
        }
      }

      // Only add profile if it has at least one meaningful field
      if (sp.provider || sp.model || sp.baseUrl || sp.apiKey || sp.apiKeyEnv) {
        sanitizedProfiles[alias] = sp;
      }
    }
    if (Object.keys(sanitizedProfiles).length > 0) {
      clean.profiles = sanitizedProfiles;
    }
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

/**
 * Env vars that can supply a provider key without ever writing it to disk.
 * Kept in sync with the names listed in the CLI help (buildUsage).
 */
const API_KEY_ENV_VARS = ['RUKO_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'] as const;

/**
 * TASK-02 whitelist: env var names allowed in profile `apiKeyEnv` fields.
 * Prevents malicious repos from exfiltrating arbitrary env vars (e.g.
 * GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY) by crafting a profile in
 * `.ruko/config.json`.  Only recognised LLM-provider key names are accepted.
 */
export const ALLOWED_API_KEY_ENV_VARS = new Set([
  'RUKO_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
]);

/** True when at least one API key env var supplies a non-empty value. */
function hasApiKeyFromEnv(): boolean {
  return API_KEY_ENV_VARS.some((name) => (process.env[name] ?? '').trim().length > 0);
}

/**
 * H4: true when the config FILE itself carries a plaintext credential — either
 * the top-level `apiKey` or a profile with a literal `apiKey` whose `apiKeyEnv`
 * is not satisfied by the current environment.
 */
function configFileHasPlaintextKey(file: Partial<RukoConfigFile>): boolean {
  if (typeof file.apiKey === 'string' && file.apiKey.trim().length > 0) return true;
  const profiles = file.profiles;
  if (profiles && typeof profiles === 'object') {
    for (const profile of Object.values(profiles)) {
      if (!profile || typeof profile !== 'object') continue;
      const literal = typeof profile.apiKey === 'string' ? profile.apiKey.trim() : '';
      const envName = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv.trim() : '';
      const envSatisfied = envName ? (process.env[envName] ?? '').trim().length > 0 : false;
      if (literal && !envSatisfied) return true;
    }
  }
  return false;
}

/** Loads config: defaults ← config file (credentials not yet resolved). */
export function loadConfig(path = defaultConfigPath()): AgentConfig {
  const base: AgentConfig = { ...DEFAULT_CONFIG };
  if (!existsSync(path)) return base;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const file = sanitizeConfigFile(parsed);
    // H4: plaintext credential detected in the config file. This warning is an
    // AWARENESS mitigation only — it is NOT at-rest encryption and does not
    // protect the key from backups, VCS commits, or container image layers.
    if (configFileHasPlaintextKey(file) && !hasApiKeyFromEnv()) {
      // NOTE: env var names listed as a static string (not derived from
      // API_KEY_ENV_VARS) so CodeQL does not flag this warning as clear-text
      // logging of sensitive information — we only print the *names*, never
      // the values.
      console.warn(
        `[config] ⚠ API key tersimpan PLAINTEXT di ${path} (izin 0600). ` +
          'Ini hanya mitigasi awareness, bukan enkripsi at-rest: backup, commit VCS, atau container image build tetap bisa membocorkannya. ' +
          'Disarankan pakai env var (RUKO_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY) dan hapus field "apiKey" dari file config.',
      );
    }
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
