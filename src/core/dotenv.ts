import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Zero-dependency .env file parser and loader.
 *
 * Supports:
 * - KEY=VALUE syntax
 * - Quoted values ('...', "...") with escaped newlines and quotes
 * - Inline and standalone comments (# ...)
 * - Empty lines and whitespace trimming
 * - Non-overriding default (preserves existing process.env unless requested)
 */

/** Parses a .env formatted string into key-value pairs. */
export function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  let currentKey: string | null = null;
  let currentValue = '';
  let inMultiLineQuote: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];

    if (inMultiLineQuote) {
      const quoteChar = inMultiLineQuote;
      const endQuoteIndex = rawLine.indexOf(quoteChar);
      if (endQuoteIndex !== -1) {
        currentValue += '\n' + rawLine.slice(0, endQuoteIndex);
        if (currentKey) {
          result[currentKey] = currentValue;
        }
        currentKey = null;
        currentValue = '';
        inMultiLineQuote = null;
      } else {
        currentValue += '\n' + rawLine;
      }
      continue;
    }

    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = rawLine.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = rawLine.slice(0, eqIndex).trim();
    if (!key || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      continue;
    }

    let val = rawLine.slice(eqIndex + 1).trim();

    // Check for quoted value
    if (val.startsWith('"') || val.startsWith("'")) {
      const quoteChar = val[0];
      if (val.length > 1 && val.endsWith(quoteChar) && !val.endsWith('\\' + quoteChar)) {
        // Single line quote
        val = val.slice(1, -1);
        if (quoteChar === '"') {
          val = val.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"');
        }
        result[key] = val;
      } else {
        // Multiline quote begins
        inMultiLineQuote = quoteChar;
        currentKey = key;
        currentValue = val.slice(1);
      }
    } else {
      // Unquoted value: strip trailing comment if present
      const hashIndex = val.indexOf(' #');
      if (hashIndex !== -1) {
        val = val.slice(0, hashIndex).trim();
      }
      result[key] = val;
    }
  }

  return result;
}

export interface DotenvOptions {
  /** Path to the .env file (default: `<cwd>/.env`). */
  path?: string;
  /** Whether to overwrite existing process.env variables (default: false). */
  override?: boolean;
}

/**
 * Denylist variabel lingkungan berbahaya dari berkas .env workspace (repo asing).
 * (CVSS 9.1 — ADIT.md §1.2, UCUP.md §1.2)
 *
 * Mencegah RCE instan via Node/loader hooks, pembajakan traffic LLM via proxy,
 * dan pembajakan endpoint LLM via *_BASE_URL.
 */
export const DANGEROUS_WORKSPACE_ENV_VARS = new Set([
  // RCE & Process / Loader Injection
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_V8_COVERAGE',
  'NODE_PATH',
  'NODE_DEBUG',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'PYTHONPATH',
  'PERL5LIB',
  'RUBYLIB',
  // Interpreter startup / option injection (issue #31)
  'PYTHONSTARTUP',
  'PYTHONWARNINGS',
  'PERL5OPT',
  'RUBYOPT',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',

  // Network & Proxy Hijacking (kredensial / API Key exfiltration)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'SOCKS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'socks_proxy',
  'no_proxy',

  // Shell execution / Startup hooks
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'CDPATH',
  'IFS',
  'BASH_RCFILE',
  'ZDOTDIR',
  'SHELL',
]);

/**
 * Memeriksa apakah nama variabel env termasuk berbahaya jika dimuat dari .env workspace.
 * Memblokir seluruh variabel di denylist serta semua varian *_BASE_URL dan *_API_BASE.
 */
export function isDangerousWorkspaceEnvVar(key: string): boolean {
  const upper = key.toUpperCase();
  // WP-01 (v2.1.0): prefix RUKO_* DITOLAK MUTLAK dari .env workspace —
  // flag internal (RUKO_TRUST_FOLDER, RUKO_YOLO_MODE, RUKO_HOST_STATE_DIR, dst.)
  // hanya boleh datang dari proses/terminal pengguna, bukan dari repo asing.
  // Tidak ada pengecualian testing (mis. RUKO_TEST_*): test runner wajib
  // menyetel variabel pengujian langsung di memori proses.
  if (upper.startsWith('RUKO_')) {
    return true;
  }
  if (DANGEROUS_WORKSPACE_ENV_VARS.has(key) || DANGEROUS_WORKSPACE_ENV_VARS.has(upper)) {
    return true;
  }
  if (upper.startsWith('DYLD_') || upper.startsWith('LD_')) {
    return true;
  }
  if (upper.endsWith('_BASE_URL') || upper.endsWith('_API_BASE')) {
    return true;
  }
  return false;
}

/**
 * Loads environment variables from a .env file into process.env.
 * Sanitizes entries against DANGEROUS_WORKSPACE_ENV_VARS to prevent RCE,
 * proxy redirection, and base URL hijacking from untrusted repositories.
 * Returns the parsed dictionary of safe loaded variables.
 */
export function loadDotenv(options: DotenvOptions = {}): Record<string, string> {
  const filePath = options.path ?? join(process.cwd(), '.env');
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const content = readFileSync(filePath, 'utf8');
    const parsed = parseEnv(content);
    const safeLoaded: Record<string, string> = {};

    for (const [key, value] of Object.entries(parsed)) {
      if (isDangerousWorkspaceEnvVar(key)) {
        // Blokir mutlak variabel berbahaya agar tidak mencemari process.env
        continue;
      }
      safeLoaded[key] = value;
      if (options.override || process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    return safeLoaded;
  } catch {
    return {};
  }
}

