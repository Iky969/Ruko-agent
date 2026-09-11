import { createInterface } from 'node:readline/promises';
import { dim, whiteBright, bgBlue, green, red, yellow, bold } from './ui.js';
import { missingConfigFields } from '../agent/llm.js';
import { createLineEditor } from './tui.js';

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
 * True when any of apiKey/baseUrl/model is still missing after config-file and
 * env resolution. Ruko has no built-in provider default, so a first launch
 * without all three opens the wizard (§1).
 */
export function needsSetup(cfg: { apiKey?: string; baseUrl?: string; model?: string }): boolean {
  return missingConfigFields(cfg).length > 0;
}

/**
 * Runs the wizard at first launch. On a TTY the raw-mode editor is used so the
 * API key can be masked (§5) and a cancelled line resolves to null. Piped input
 * falls back to node:readline (no masking possible there).
 */
export async function runSetupWizard(probe?: ConnectionProbe): Promise<SetupResult | null> {
  if (process.stdin.isTTY) {
    const editor = createLineEditor();
    try {
      return await promptSetup(
        {
          question: async (q) => (await editor.readLine({ prompt: q })) ?? '',
          readSecret: async (q) => (await editor.readLine({ prompt: q, mask: true })) ?? '',
        },
        probe ? { probe } : {},
      );
    } finally {
      editor.close();
    }
  }
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

/**
 * Input surface the wizard needs. `readSecret` masks typed characters (§5);
 * when the host has no masking support it falls back to `question`.
 */
export interface SetupIo {
  question: (q: string) => Promise<string>;
  readSecret?: (q: string) => Promise<string>;
}

/** The prompts themselves; shared by first-launch, `/login` and `/config setup`. */
export async function promptSetup(
  io: SetupIo,
  options: SetupOptions = {},
): Promise<SetupResult | null> {
  const rl = io;
  const readSecret = io.readSecret ?? io.question;
  console.log('');
  console.log(setupBanner());
  console.log(dim('  Konfigurasi disimpan ke .ruko/config.json (izin 600) — tanpa export manual.'));
  console.log('');

  let apiKey: string;
  try {
    // Masked input: the key never appears in plain text on screen (§5).
    apiKey = (await readSecret(`${green('  API Key: ')}`)).trim();
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
    // Neutral prompts: no example provider is suggested unless the user asks.
    baseUrl = (await rl.question(`${green('  Base URL: ')}`)).trim();
    if (!baseUrl) {
      console.log(dim('  (Base URL wajib diisi — setup dibatalkan.)'));
      return null;
    }
    model = (await rl.question(`${green('  Model Name: ')}`)).trim();
    if (!model) {
      console.log(dim('  (Model wajib diisi — setup dibatalkan.)'));
      return null;
    }
  } catch {
    return null;
  }

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
          const newKey = (await readSecret(`${green('  API Key baru: ')}`)).trim();
          if (newKey) result.apiKey = newKey;
          const newUrl = (await rl.question(`${green(`  Base URL (sekarang: ${result.baseUrl}): `)}`)).trim();
          if (newUrl) result.baseUrl = newUrl;
          const newModel = (await rl.question(`${green(`  Model (sekarang: ${result.model}): `)}`)).trim();
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
