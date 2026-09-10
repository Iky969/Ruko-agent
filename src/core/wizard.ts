import { createInterface } from 'node:readline/promises';
import { dim, whiteBright, bgBlue, green, red, yellow, bold } from './ui.js';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../agent/llm.js';

/**
 * Interactive first-time setup wizard.
 *
 * Asks for API key, base URL and model, then (optionally) LIVE-TESTS the
 * connection before saving, so the user sees "✓ Terhubung ke <model>" or a
 * translated reason with the fix command — not a crash mid-session (§2).
 */

export interface SetupResult {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Probe hook supplied by the caller (builds a provider, tests it). */
export type ConnectionProbe = (r: SetupResult) => Promise<{ ok: boolean; message: string }>;

const BANNER = '  Welcome to Ruko Agent Setup!  ';

export function setupBanner(): string {
  return bgBlue(whiteBright(bold(BANNER)));
}

/**
 * True when no usable API key exists yet in the config file or environment
 * (Base URL and model always have sane defaults, so they never trigger it).
 */
export function needsSetup(apiKey?: string): boolean {
  return !((apiKey ?? '').trim() || (process.env.OPENAI_API_KEY ?? '').trim());
}

/**
 * Runs the wizard against a fresh readline pair (used at first launch).
 * Ctrl+C / EOF aborts setup (returns null) without writing anything.
 */
export async function runSetupWizard(probe?: ConnectionProbe): Promise<SetupResult | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await promptSetup(rl, probe ? { probe } : {});
  } finally {
    rl.close();
  }
}

export interface SetupOptions {
  probe?: ConnectionProbe;
}

/** The prompts themselves; shared by first-launch, `/login` and `/config setup`. */
export async function promptSetup(
  rl: { question: (q: string) => Promise<string> },
  options: SetupOptions = {},
): Promise<SetupResult | null> {
  console.log('');
  console.log(setupBanner());
  console.log(dim('  Konfigurasi disimpan ke .ruko/config.json (izin 600) — tanpa export manual.'));
  console.log('');

  let apiKey: string;
  try {
    apiKey = (await rl.question(`${green('  API Key: ')}`)).trim();
  } catch {
    return null; // Ctrl+C / EOF
  }
  if (!apiKey) {
    console.log(dim('  (API Key kosong — setup dibatalkan.)'));
    return null;
  }

  let baseUrl = '';
  let model = '';
  try {
    baseUrl = (await rl.question(
      `${green(`  Base URL (Default: ${DEFAULT_BASE_URL}): `)}`,
    )).trim();
    model = (await rl.question(
      `${green(`  Model Name (Default: ${DEFAULT_MODEL}): `)}`,
    )).trim();
  } catch {
    return null;
  }

  baseUrl = baseUrl || DEFAULT_BASE_URL;
  model = model || DEFAULT_MODEL;
  const result: SetupResult = { apiKey, baseUrl, model };

  if (options.probe) {
    console.log(dim('  Menguji koneksi...'));
    let retry = true;
    while (retry) {
      const test = await options.probe(result);
      if (test.ok) {
        console.log(green(`  ✓ Terhubung ke ${test.message}`));
        break;
      }
      console.log(red(`  ✗ ${test.message}`));
      let answer = '';
      try {
        answer = (await rl.question(
          yellow('  Simpan walau gagal / [c]oba key lain / [b]atalkan [Simpan/gagal]?: '),
        )).trim().toLowerCase();
      } catch {
        return null;
      }
      if (/^(c|cob|retry|ulang)$/.test(answer)) {
        try {
          const newKey = (await rl.question(`${green('  API Key baru: ')}`)).trim();
          if (newKey) result.apiKey = newKey;
          const newUrl = (await rl.question(`${green(`  Base URL (Default: ${result.baseUrl}): `)}`)).trim();
          if (newUrl) result.baseUrl = newUrl;
          const newModel = (await rl.question(`${green(`  Model (Default: ${result.model}): `)}`)).trim();
          if (newModel) result.model = newModel;
        } catch {
          return null;
        }
        continue;
      }
      if (/^(b|bat|no|tidak)$/.test(answer)) return null;
      break; // save anyway
    }
  }
  return result;
}
