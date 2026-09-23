#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Agent } from './agent/agent.js';
import { createProvider } from './agent/llm.js';
import { Confirmer, guardedExecute, isHighRiskDangerousCommand } from './core/approval.js';
import { defaultConfigPath, loadResolvedConfig, saveConfig } from './core/config.js';
import { Context } from './core/context.js';
import { SystemLoop } from './core/loop.js';
import { summarizeLog } from './core/summarizer.js';
import { needsSetup, runSetupWizard } from './core/wizard.js';
import { loadDotenv } from './core/dotenv.js';
import { isWorkspaceTrusted, promptWorkspaceTrust } from './core/trust.js';
import { initDefaultSkills } from './core/skills.js';
import {
  colorsEnabled,
  bold,
  cyan,
  dim,
  green,
  yellow,
  red,
  terminalWidth,
  truncateVisible,
  visibleLength,
} from './core/ui.js';

// ─────────────────────────────────────────────────────────────
// CLI Help & Version - Responsive & Color-aware
// ─────────────────────────────────────────────────────────────

function buildUsage(): string {
  const useColor = colorsEnabled();
  const c = {
    title: (s: string) => (useColor ? bold(cyan(s)) : s),
    cmd: (s: string) => (useColor ? green(s) : s),
    dim: (s: string) => (useColor ? dim(s) : s),
    yellow: (s: string) => (useColor ? yellow(s) : s),
    bold: (s: string) => (useColor ? bold(s) : s),
  };

  const w = terminalWidth();
  const isNarrow = w < 80;
  const isVeryNarrow = w < 50;
  const maxWidth = Math.max(20, w - 2);

  const lines: string[] = [];
  lines.push(`${c.title('Ruko')} — AI Coding Agent CLI ${c.dim(`v${packageVersion()}`)}`);
  lines.push('');
  lines.push(c.bold('Usage:'));

  const usageEntries: Array<[string, string]> = [
    ['ruko', 'Mulai system loop interaktif (wizard jika belum ada API key)'],
    ['ruko --exec "<cmd>"', 'Jalankan satu perintah shell (output di-summarize)'],
    ['ruko --exec "<cmd>" --yes', 'Jalankan tanpa konfirmasi approval'],
    ['ruko --summarize "<txt>"', 'Demo Log Summarizer pada teks arbitrer'],
    ['ruko --model "<name>"', 'Override nama model aktif'],
    ['ruko --provider "<name>"', 'Override provider (openai-compatible | anthropic | gemini)'],
    ['ruko --base-url "<url>"', 'Override base URL provider'],
    ['ruko --api-key "<@file|-|key>"', 'Override API key (@file, - stdin, atau literal)'],
    ['ruko --insecure-api-key', 'Izinkan literal API key langsung di argv (tidak disarankan)'],
    ['ruko --env-file "<path>"', 'Muat file env khusus (default .env) [alias: --dotenv]'],
    ['ruko --trust-folder', 'Bypass prompt kepercayaan workspace'],
    ['ruko --yes', 'Bypass approval & trust (YOLO untuk one-shot)'],
    ['ruko --allow-unsafe', 'Bypass approval non-interaktif untuk perintah berisiko tinggi'],
    ['ruko --help', 'Bantuan ini'],
    ['ruko --version', 'Versi'],
  ];

  if (isVeryNarrow) {
    // Very narrow: stacked layout, no alignment, fully truncated
    for (const [cmd, desc] of usageEntries) {
      const cmdLine = truncateVisible(`  ${cmd}`, maxWidth);
      const descLine = truncateVisible(`    ${desc}`, maxWidth);
      lines.push(c.cmd(cmdLine));
      lines.push(c.dim(descLine));
    }
  } else if (isNarrow) {
    // Narrow (50-79 cols): aligned but truncated to fit
    const maxCmdLenRaw = Math.max(...usageEntries.map(([cmd]) => visibleLength(cmd)), 20);
    const maxCmdLen = Math.min(maxCmdLenRaw, Math.floor(maxWidth * 0.5));
    const descAvail = Math.max(10, maxWidth - maxCmdLen - 4);
    for (const [cmd, desc] of usageEntries) {
      const paddedCmd = cmd.padEnd(maxCmdLen + 2);
      const finalDesc = truncateVisible(desc, descAvail);
      const coloredLine = `  ${c.cmd(paddedCmd)}${c.dim(finalDesc)}`;
      lines.push(visibleLength(`  ${paddedCmd}${finalDesc}`) > maxWidth ? truncateVisible(`  ${paddedCmd}${finalDesc}`, maxWidth) : coloredLine);
    }
  } else {
    // Wide (>=80 cols): full descriptions, no truncation for readability
    const maxCmdLen = Math.max(...usageEntries.map(([cmd]) => visibleLength(cmd)), 24);
    for (const [cmd, desc] of usageEntries) {
      const paddedCmd = cmd.padEnd(maxCmdLen + 2);
      lines.push(`  ${c.cmd(paddedCmd)}${c.dim(desc)}`);
    }
  }

  lines.push('');
  const configHeader = 'Konfigurasi (disimpan ke .ruko/config.json — tanpa export manual):';
  lines.push(c.bold(truncateVisible(configHeader, maxWidth)));
  const configEntries: Array<[string, string]> = [
    ['/config setup', 'Wizard API Key / Base URL / Model dari REPL'],
  ];
  for (const [cmd, desc] of configEntries) {
    if (isVeryNarrow) {
      lines.push(c.cmd(truncateVisible(`  ${cmd}`, maxWidth)));
      lines.push(c.dim(truncateVisible(`    ${desc}`, maxWidth)));
    } else {
      const maxCmdLen = 20;
      const descAvail = Math.max(10, maxWidth - maxCmdLen - 4);
      const line = `  ${cmd.padEnd(maxCmdLen + 2)}${truncateVisible(desc, descAvail)}`;
      lines.push(visibleLength(line) > maxWidth ? truncateVisible(line, maxWidth) : `  ${c.cmd(cmd.padEnd(maxCmdLen + 2))}${c.dim(truncateVisible(desc, descAvail))}`);
    }
  }

  lines.push('');
  lines.push(c.bold(truncateVisible('Environment (opsional, config file lebih prioritas):', maxWidth)));
  const envEntries: Array<[string, string]> = [
    ['OPENAI_API_KEY', 'API key backend OpenAI-compatible'],
    ['OPENAI_BASE_URL', 'Ganti base URL (mis. http://localhost:11434/v1 untuk Ollama)'],
    ['ANTHROPIC_API_KEY', 'API key backend Anthropic Claude'],
    ['GEMINI_API_KEY', 'API key backend Google Gemini'],
    ['AGENT_MODEL', 'Model default'],
    ['RUKO_CONFIG', 'Path config (default .ruko/config.json)'],
    ['RUKO_TRUST_FOLDER=1', 'Bypass prompt kepercayaan workspace'],
    ['RUKO_YOLO_MODE=1', 'Bypass persetujuan perintah berisiko'],
    ['NO_COLOR=1', 'Nonaktifkan warna ANSI'],
  ];
  if (isVeryNarrow) {
    for (const [k, d] of envEntries) {
      lines.push(truncateVisible(`  ${k}`, maxWidth));
      lines.push(c.dim(truncateVisible(`    ${d}`, maxWidth)));
    }
  } else {
    const maxEnvLenRaw = Math.max(...envEntries.map(([k]) => k.length), 18);
    const maxEnvLen = isNarrow ? Math.min(maxEnvLenRaw, Math.floor(maxWidth * 0.45)) : maxEnvLenRaw;
    const envDescAvail = Math.max(10, maxWidth - maxEnvLen - 4);
    for (const [k, d] of envEntries) {
      const finalDesc = truncateVisible(d, envDescAvail);
      const line = `  ${k.padEnd(maxEnvLen + 2)}${finalDesc}`;
      if (visibleLength(line) > maxWidth) {
        lines.push(truncateVisible(line, maxWidth));
      } else {
        lines.push(`  ${k.padEnd(maxEnvLen + 2)}${c.dim(finalDesc)}`);
      }
    }
  }

  lines.push('');
  lines.push(c.dim(truncateVisible('Catatan: Flag --env-file konflik dengan Node.js built-in --env-file (Node >=20).', maxWidth)));
  lines.push(c.dim(truncateVisible('  Gunakan --dotenv sebagai alias atau jalankan via bin ruko (bukan node dist/index.js).', maxWidth)));

  return lines.join('\n');
}

function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ─────────────────────────────────────────────────────────────
// Robust CLI Argument Parser with Validation
// ─────────────────────────────────────────────────────────────

interface ParsedArgs {
  help: boolean;
  version: boolean;
  exec?: string;
  summarize?: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  envFile?: string;
  yes: boolean;
  trustFolder: boolean;
  allowUnsafe: boolean;
  insecureApiKey: boolean;
  errors: string[];
  unknownFlags: string[];
}

const KNOWN_FLAGS_WITH_VALUE = new Set([
  '--exec',
  '--summarize',
  '--model',
  '--provider',
  '--base-url',
  '--api-key',
  '--env-file',
  '--dotenv', // alias for --env-file to avoid Node.js conflict
]);

const KNOWN_BOOLEAN_FLAGS = new Set(['--yes', '--trust-folder', '--allow-unsafe', '--insecure-api-key', '--help', '--version', '-h', '-v']);

const ALL_KNOWN_FLAGS = new Set([...KNOWN_FLAGS_WITH_VALUE, ...KNOWN_BOOLEAN_FLAGS]);

function parseCliArgs(rawArgs: string[]): ParsedArgs {
  const result: ParsedArgs = {
    help: false,
    version: false,
    yes: false,
    trustFolder: false,
    allowUnsafe: false,
    insecureApiKey: false,
    errors: [],
    unknownFlags: [],
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    // Help / Version - immediate
    if (arg === '-h' || arg === '--help') {
      result.help = true;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      result.version = true;
      continue;
    }

    if (arg === '--yes') {
      result.yes = true;
      continue;
    }
    if (arg === '--trust-folder') {
      result.trustFolder = true;
      continue;
    }
    if (arg === '--allow-unsafe') {
      result.allowUnsafe = true;
      continue;
    }
    if (arg === '--insecure-api-key') {
      result.insecureApiKey = true;
      continue;
    }

    // Flags requiring values
    if (KNOWN_FLAGS_WITH_VALUE.has(arg)) {
      const next = rawArgs[i + 1];
      // Missing value cases:
      // - next is undefined (flag at end)
      // - next starts with -- (next is another flag)
      // - next is empty string
      if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
        const flagName = arg === '--dotenv' ? '--env-file/--dotenv' : arg;
        result.errors.push(
          `Flag ${flagName} memerlukan nilai. Contoh: ${arg} "<value>"`,
        );
        continue;
      }
      if (next === '') {
        const flagName = arg === '--dotenv' ? '--env-file/--dotenv' : arg;
        result.errors.push(
          `Flag ${flagName} tidak boleh kosong. Contoh: ${arg} "<value>"`,
        );
        i++; // consume empty value to avoid double error as unknown flag
        continue;
      }
      const value = next;
      i++; // consume value

      switch (arg) {
        case '--exec':
          if (value.trim() === '') {
            result.errors.push('Flag --exec tidak boleh kosong. Contoh: --exec "ls -la"');
          } else {
            result.exec = value;
          }
          break;
        case '--summarize':
          result.summarize = value;
          break;
        case '--model':
          if (value.trim() === '') {
            result.errors.push('Flag --model tidak boleh kosong.');
          } else {
            result.model = value;
          }
          break;
        case '--provider':
          result.provider = value;
          break;
        case '--base-url':
          result.baseUrl = value;
          break;
        case '--api-key':
          result.apiKey = value;
          break;
        case '--env-file':
        case '--dotenv':
          result.envFile = value;
          break;
      }
      continue;
    }

    // Unknown flag detection
    if (arg.startsWith('--') || (arg.startsWith('-') && arg.length > 1)) {
      // Allow single dash values? No, treat as unknown if not known
      if (!ALL_KNOWN_FLAGS.has(arg)) {
        result.unknownFlags.push(arg);
      }
      continue;
    }

    // Positional args - currently not supported, treat as unknown
    if (!arg.startsWith('-')) {
      result.unknownFlags.push(arg);
    }
  }

  return result;
}

function printErrorsAndExit(errors: string[], unknownFlags: string[]): never {
  const useColor = colorsEnabled();
  const err = (s: string) => (useColor ? red(s) : s);
  const dimFn = (s: string) => (useColor ? dim(s) : s);

  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`${err('Error:')} ${e}`);
    }
  }
  if (unknownFlags.length > 0) {
    console.error(
      `${err('Error:')} Flag tidak dikenal: ${unknownFlags.join(', ')}`,
    );
    console.error(dimFn('Gunakan --help untuk daftar flag yang tersedia.'));
  }
  console.error('');
  console.error(buildUsage());
  process.exit(2);
}

/** Approval prompt for one-shot --exec runs (TTY only). */
function makeTtyConfirmer(): Confirmer {
  return async (command, reason) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(
        `⚠ Perintah berisiko (${reason})\n  ${command}\n  Jalankan? [y/N] `,
      );
      return /^(y|yes|ya)$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const parsed = parseCliArgs(rawArgs);

  // Handle validation errors first (missing values, unknown flags)
  if (parsed.errors.length > 0 || parsed.unknownFlags.length > 0) {
    printErrorsAndExit(parsed.errors, parsed.unknownFlags);
  }

  // Security gate: Block raw literal API keys passed via CLI argv to prevent leak in ps aux / /proc
  if (parsed.apiKey && !parsed.apiKey.startsWith('@') && parsed.apiKey !== '-') {
    if (!parsed.insecureApiKey && process.env.RUKO_INSECURE_API_KEY !== '1') {
      console.error(red(
        '\n⛔ KEAMANAN: Memberikan kunci API mentah langsung via argumen CLI diblokir untuk mencegah\n' +
        '  kebocoran kredensial di process table (ps aux), /proc, dan riwayat bash/zsh history.\n'
      ));
      console.error(yellow('Pilihan yang aman:'));
      console.error('  1. Gunakan Environment Variable: RUKO_API_KEY="sk-..." ruko ...');
      console.error('  2. Baca dari file terproteksi:    ruko --api-key @/path/to/secret.key');
      console.error('  3. Baca dari stdin:              echo "$KEY" | ruko --api-key -');
      console.error('  4. Wizard interaktif:            ruko (konfigurasi disimpan aman izin 0600)');
      console.error(dim('\nJika Anda benar-benar memerlukan flag literal ini, sertakan: --insecure-api-key\n'));
      process.exit(1);
    }
  }

  // Help / Version
  if (parsed.help) {
    console.log(buildUsage());
    return;
  }
  if (parsed.version) {
    console.log(`ruko v${packageVersion()}`);
    return;
  }

  // Load environment variables from .env or custom path
  // Handle --env-file / --dotenv with graceful error handling
  if (parsed.envFile) {
    if (!existsSync(parsed.envFile)) {
      const useColor = colorsEnabled();
      const warn = (s: string) => (useColor ? yellow(s) : s);
      console.error(
        warn(
          `⚠ File env tidak ditemukan: ${parsed.envFile} — melanjutkan dengan env default.`,
        ),
      );
      // Still try to load default .env as fallback
      loadDotenv({ path: undefined });
    } else {
      const loaded = loadDotenv({ path: parsed.envFile });
      if (Object.keys(loaded).length === 0) {
        const useColor = colorsEnabled();
        const warn = (s: string) => (useColor ? dim(s) : s);
        console.log(warn(`(File env ${parsed.envFile} kosong atau tidak valid)`));
      }
    }
  } else {
    loadDotenv({ path: undefined });
  }

  const config = loadResolvedConfig();

  // Apply CLI flag overrides to config with validation
  if (parsed.model) config.model = parsed.model;
  if (parsed.provider) config.provider = parsed.provider;
  if (parsed.baseUrl) config.baseUrl = parsed.baseUrl;
  if (parsed.apiKey) {
    if (parsed.apiKey.startsWith('@')) {
      const keyFile = parsed.apiKey.slice(1);
      try {
        config.apiKey = readFileSync(keyFile, 'utf8').trim();
      } catch (e) {
        console.error(red(`Error membaca file API key "${keyFile}": ${(e as Error).message}`));
        process.exit(1);
      }
    } else if (parsed.apiKey === '-') {
      try {
        config.apiKey = readFileSync(0, 'utf8').trim();
      } catch (e) {
        console.error(red(`Error membaca API key dari stdin: ${(e as Error).message}`));
        process.exit(1);
      }
    } else {
      config.apiKey = parsed.apiKey;
      console.warn(yellow(
        '⚠ PERINGATAN KEAMANAN (--insecure-api-key): Kunci API diekspos di argv/process table (ps aux) dan shell history.\n' +
        '  Disarankan menggunakan env var RUKO_API_KEY atau flag aman: --api-key @/path/to/key.txt atau --api-key -'
      ));
    }
  }

  // Workspace / Folder trust verification
  const configPath = defaultConfigPath();
  const bypassTrust =
    parsed.trustFolder ||
    process.env.RUKO_TRUST_FOLDER === '1' ||
    process.env.RUKO_TRUST_FOLDER === 'true';

  if (process.stdin.isTTY && !bypassTrust && !isWorkspaceTrusted(process.cwd(), configPath)) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const trusted = await promptWorkspaceTrust(rl, process.cwd(), configPath);
      if (!trusted) {
        console.log('  ⚠ Akses dibatalkan: Folder ini tidak dipercayai demi keamanan.');
        return;
      }
    } finally {
      rl.close();
    }
  }

  // One-shot shell execution (through the approval gate)
  if (parsed.exec !== undefined) {
    const command = parsed.exec;
    const isYolo = parsed.yes || process.env.RUKO_YOLO_MODE === '1' || process.env.RUKO_YOLO_MODE === 'true';
    if (isYolo) {
      console.log('┌─────────────────────────────────────────────┐');
      console.log('│  ⚠ UNSAFE MODE: Persetujuan otomatis aktif  │');
      console.log('│  Semua command akan dieksekusi tanpa konfirmasi. │');
      console.log('└─────────────────────────────────────────────┘');
    }

    // High-risk safety enforcement in non-interactive mode (Tugas 12)
    if (!process.stdin.isTTY) {
      const highRisk = isHighRiskDangerousCommand(command);
      const allowUnsafe = parsed.allowUnsafe || process.env.RUKO_ALLOW_UNSAFE === '1' || process.env.RUKO_ALLOW_UNSAFE === 'true';
      if (highRisk.isHighRisk && !allowUnsafe) {
        console.error(red(`\n⛔ EKSEKUSI DITOLAK: Perintah berisiko tinggi terdeteksi dalam mode non-interaktif (${highRisk.reason}).`));
        console.error(yellow('  Untuk mengeksekusi perintah ini secara otomatis tanpa prompt interaktif, sertakan flag eksplisit: --allow-unsafe'));
        console.error(dim(`  Contoh: ruko --exec "${command}" --yes --allow-unsafe\n`));
        process.exit(1);
      }
    }

    const confirm: Confirmer | null = isYolo
      ? async () => true
      : process.stdin.isTTY
        ? makeTtyConfirmer()
        : null;

    // SIGINT handling for one-shot mode: clean exit without stack trace
    let interrupted = false;
    const sigintHandler = () => {
      if (!interrupted) {
        interrupted = true;
        process.stdout.write('\n^C\n');
        process.exit(130);
      }
    };
    process.once('SIGINT', sigintHandler);

    const llm = createProvider(config);
    try {
      const abortController = new AbortController();
      process.once('SIGINT', () => abortController.abort());

      const result = await guardedExecute(
        command,
        {
          timeoutMs: config.execTimeoutMs,
          confirm,
          llmProvider: llm,
          signal: abortController.signal,
        },
        config,
      );
      process.off('SIGINT', sigintHandler);
      console.log(result.output || `(no output — exit code ${result.code ?? 'killed'})`);
      console.log(
        `\n[exit code: ${result.code ?? 'killed'} | ${result.durationMs}ms` +
          `${result.truncated ? ' | output truncated' : ''}]`,
      );
      if (result.code != null && result.code !== 0) process.exitCode = result.code;
    } catch (err) {
      process.off('SIGINT', sigintHandler);
      // No raw stack trace - clean error message
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error saat eksekusi: ${msg}`);
      process.exitCode = 1;
    }
    return;
  }

  // Log summarizer demo
  if (parsed.summarize !== undefined) {
    const result = summarizeLog(parsed.summarize, config.maxLogChars);
    console.log(`original length: ${result.originalLength} chars`);
    console.log(`truncated: ${result.truncated}`);
    console.log('---');
    console.log(result.summary);
    return;
  }

  // Interactive mode
  if (process.stdin.isTTY && needsSetup(config)) {
    const setup = await runSetupWizard(async (r) => {
      let pType: string | undefined = r.provider;
      if (!pType) {
        const rb = r.baseUrl.toLowerCase();
        const ml = r.model.toLowerCase();
        if (rb.includes('anthropic.com') || ml.startsWith('claude-')) {
          pType = 'anthropic';
        } else if (rb.includes('googleapis.com') || (!rb && ml.startsWith('gemini-'))) {
          pType = 'gemini';
        } else {
          pType = 'openai-compatible';
        }
      }
      const testProvider = createProvider({ apiKey: r.apiKey, baseUrl: r.baseUrl, model: r.model, provider: pType });
      if (testProvider.testConnection) {
        return testProvider.testConnection();
      }
      return { ok: true, message: r.model };
    });
    if (setup) {
      Object.assign(config, setup);
      saveConfig(config, configPath);
      console.log('✔ Konfigurasi disimpan ke .ruko/config.json — LLM mode aktif.');
    }
  }

  initDefaultSkills();
  const ctx = new Context(config);
  const llm = createProvider(config);
  const agent = new Agent(ctx, llm, config);
  const loop = new SystemLoop(ctx, agent, config, configPath);
  loop.start();
}

// ─────────────────────────────────────────────────────────────
// Global Error Handling — hardened (Tugas 10)
// ─────────────────────────────────────────────────────────────

/** Returns true when debug output is enabled via environment. */
function isDebugMode(): boolean {
  return !!(process.env.DEBUG || process.env.RUKO_DEBUG);
}

/**
 * Emergency cleanup before forced exit: restores terminal raw mode if TTY
 * is currently in raw mode, preventing a broken terminal after a crash.
 */
function emergencyCleanup(): void {
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
  } catch {
    // Best-effort — cleanup itself must never throw
  }
}

/**
 * Formats a fatal error message with optional stack trace (when DEBUG is on)
 * and a diagnostic reference for troubleshooting.
 */
function formatFatalError(label: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lines: string[] = [`${label}: ${msg}`];

  if (isDebugMode() && err instanceof Error && err.stack) {
    lines.push(err.stack);
  }

  // Diagnostic identifier — unique per crash for easier log correlation
  const diagId = `RUKO-${Date.now().toString(36).toUpperCase()}`;
  lines.push('');
  lines.push(`[${diagId}] Jika masalah berlanjut, jalankan ulang dengan RUKO_DEBUG=1 untuk detail lengkap,`);
  lines.push(`  atau laporkan di: https://github.com/Iky969/Ruko-agent/issues`);

  return lines.join('\n');
}

// Global resilience: prevent unhandled rejections from showing raw stack traces
process.on('unhandledRejection', (reason) => {
  console.error(formatFatalError('Unhandled error', reason));
  // Don't exit immediately - let main catch handle it, but log cleanly
});

process.on('uncaughtException', (err) => {
  emergencyCleanup();
  console.error(formatFatalError('Fatal', err));
  process.exit(1);
});

main().catch((err) => {
  emergencyCleanup();
  console.error(formatFatalError('Fatal', err));
  process.exit(1);
});
