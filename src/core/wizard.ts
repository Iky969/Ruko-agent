import { createInterface } from 'node:readline/promises';
import { dim, whiteBright, bgBlue, green, red, yellow, bold } from './ui.js';
import { missingConfigFields } from '../agent/llm.js';
import { isHostnameOrSubdomain } from './config.js';
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
  provider?: string;
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
export async function runSetupWizard(probe?: ConnectionProbe, options: SetupOptions = {}): Promise<SetupResult | null> {
  const setupOpts: SetupOptions = { probe, askProvider: true, ...options };
  if (process.stdin.isTTY) {
    const editor = createLineEditor();
    try {
      return await promptSetup(
        {
          question: async (q) => (await editor.readLine({ prompt: q })) ?? '',
          readSecret: async (q) => (await editor.readLine({ prompt: q, mask: true })) ?? '',
        },
        setupOpts,
      );
    } finally {
      editor.close();
    }
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await promptSetup(rl, setupOpts);
  } finally {
    rl.close();
  }
}

export interface SetupOptions {
  probe?: ConnectionProbe;
  /** When true, explicitly prompts the user to select provider type (openai-compatible, anthropic, gemini). */
  askProvider?: boolean;
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

  const cleanInput = (s: string) => s.trim().replace(/^["'`]+|["'`]+$/g, '').trim();

  let apiKey: string;
  try {
    // Masked input: the key never appears in plain text on screen (§5).
    apiKey = cleanInput(await readSecret(`${green('  API Key: ')}`));
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
    baseUrl = cleanInput(await rl.question(`${green('  Base URL: ')}`));
    if (!baseUrl) {
      console.log(dim('  (Base URL wajib diisi — setup dibatalkan.)'));
      return null;
    }

    if (/^http:\/\//i.test(baseUrl)) {
      console.log(yellow(`\n  ⚠ Peringatan: Protokol HTTP (cleartext) terdeteksi untuk "${baseUrl}".`));
      const trust = (
        await rl.question(yellow('  Percayai URL ini? (y/n): '))
      )
        .trim()
        .toLowerCase();
      if (!/^(y|yes|ya)$/i.test(trust)) {
        console.log(dim('  (Protokol/URL HTTP tidak disetujui — setup dibatalkan.)'));
        return null;
      }
    }

    model = cleanInput(await rl.question(`${green('  Model Name: ')}`));
    if (!model) {
      console.log(dim('  (Model wajib diisi — setup dibatalkan.)'));
      return null;
    }

    let provider: string | undefined;
    if (options.askProvider) {
      const defaultProvider = (
        isHostnameOrSubdomain(baseUrl, 'anthropic.com') || model.toLowerCase().startsWith('claude-')
          ? 'anthropic'
          : isHostnameOrSubdomain(baseUrl, 'googleapis.com') || model.toLowerCase().startsWith('gemini-')
            ? 'gemini'
            : 'openai-compatible'
      );
      try {
        console.log(dim('  Pilih tipe provider:'));
        console.log(dim('    1) openai-compatible (Ollama, LM Studio, vLLM, OpenAI, Groq, dll.)'));
        console.log(dim('    2) anthropic (Anthropic Claude API)'));
        console.log(dim('    3) gemini (Google Gemini API)'));
        const pChoice = cleanInput(await rl.question(`${green(`  Provider [1/2/3 atau nama] (default: ${defaultProvider}): `)}`));
        const pLower = pChoice.toLowerCase();
        if (pChoice === '2' || pLower === 'anthropic' || pLower === 'claude') {
          provider = 'anthropic';
        } else if (pChoice === '3' || pLower === 'gemini' || pLower === 'google') {
          provider = 'gemini';
        } else if (pChoice === '1' || pLower === 'openai-compatible' || pLower === 'openai' || pLower === 'ollama') {
          provider = 'openai-compatible';
        } else if (!pChoice || pLower === 's' || pLower === 'simpan') {
          provider = defaultProvider;
        } else if (/^[a-zA-Z0-9_-]+$/.test(pChoice) && (pLower.includes('openai') || pLower.includes('anthropic') || pLower.includes('gemini'))) {
          provider = pChoice;
        } else {
          provider = defaultProvider;
        }
      } catch {
        provider = defaultProvider;
      }
    }

    const result: SetupResult = { apiKey, baseUrl, model, ...(provider ? { provider } : {}) };

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
            const newKey = cleanInput(await readSecret(`${green('  API Key baru: ')}`));
            if (newKey) result.apiKey = newKey;
            const newUrl = cleanInput(await rl.question(`${green(`  Base URL (sekarang: ${result.baseUrl}): `)}`));
            if (newUrl) {
              if (/^http:\/\//i.test(newUrl)) {
                console.log(yellow(`\n  ⚠ Peringatan: Protokol HTTP (cleartext) terdeteksi untuk "${newUrl}".`));
                const trust = (
                  await rl.question(yellow('  Percayai URL ini? (y/n): '))
                )
                  .trim()
                  .toLowerCase();
                if (!/^(y|yes|ya)$/i.test(trust)) {
                  console.log(dim('  (Protokol/URL HTTP tidak disetujui — setup dibatalkan.)'));
                  return null;
                }
              }
              result.baseUrl = newUrl;
            }
            const newModel = cleanInput(await rl.question(`${green(`  Model (sekarang: ${result.model}): `)}`));
            if (newModel) result.model = newModel;
            if (options.askProvider) {
              const newProv = cleanInput(await rl.question(`${green(`  Provider (sekarang: ${result.provider ?? 'openai-compatible'}): `)}`));
              if (newProv) {
                if (newProv === '2' || newProv.toLowerCase() === 'anthropic') result.provider = 'anthropic';
                else if (newProv === '3' || newProv.toLowerCase() === 'gemini') result.provider = 'gemini';
                else if (newProv === '1' || newProv.toLowerCase() === 'openai-compatible') result.provider = 'openai-compatible';
                else result.provider = newProv;
              }
            }
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
  } catch {
    return null;
  }
}
