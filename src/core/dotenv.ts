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
 * Loads environment variables from a .env file into process.env.
 * Returns the parsed dictionary of loaded variables.
 */
export function loadDotenv(options: DotenvOptions = {}): Record<string, string> {
  const filePath = options.path ?? join(process.cwd(), '.env');
  if (!existsSync(filePath)) {
    return {};
  }

  try {
    const content = readFileSync(filePath, 'utf8');
    const parsed = parseEnv(content);
    for (const [key, value] of Object.entries(parsed)) {
      if (options.override || process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    return parsed;
  } catch {
    return {};
  }
}
