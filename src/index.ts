#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Agent } from './agent/agent.js';
import { createProvider } from './agent/llm.js';
import { Confirmer, guardedExecute } from './core/approval.js';
import { defaultConfigPath, loadConfig } from './core/config.js';
import { Context } from './core/context.js';
import { SystemLoop } from './core/loop.js';
import { summarizeLog } from './core/summarizer.js';

const USAGE = `Ruko — AI Coding Agent CLI

Usage:
  ruko                      Mulai system loop interaktif
  ruko --exec "<cmd>"       Jalankan satu perintah shell (output di-summarize)
  ruko --exec "<cmd>" --yes Jalankan tanpa konfirmasi approval
  ruko --summarize "<txt>"  Demo Log Summarizer pada teks arbitrer
  ruko --help               Bantuan ini
  ruko --version            Versi

Environment:
  OPENAI_API_KEY   Aktifkan LLM mode (backend OpenAI-compatible)
  OPENAI_BASE_URL  Ganti base URL (mis. http://localhost:11434/v1 untuk Ollama)
  AGENT_MODEL      Model default (default gpt-4o-mini)
  RUKO_CONFIG      Path config (default .ruko/config.json)
  RUKO_YOLO_MODE=1 Bypass persetujuan perintah berisiko`;

function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
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
  const args = process.argv.slice(2);
  const config = loadConfig();

  if (args.includes('-h') || args.includes('--help')) {
    console.log(USAGE);
    return;
  }
  if (args.includes('-v') || args.includes('--version')) {
    console.log(`ruko v${packageVersion()}`);
    return;
  }

  // One-shot shell execution (through the approval gate).
  const execIndex = args.indexOf('--exec');
  if (execIndex !== -1 && args[execIndex + 1]) {
    const command = args[execIndex + 1];
    const confirm: Confirmer | null = args.includes('--yes')
      ? async () => true
      : process.stdin.isTTY
        ? makeTtyConfirmer()
        : null;
    const result = await guardedExecute(
      command,
      { timeoutMs: config.execTimeoutMs, confirm },
      config,
    );
    console.log(result.output || `(no output — exit code ${result.code ?? 'killed'})`);
    console.log(
      `\n[exit code: ${result.code ?? 'killed'} | ${result.durationMs}ms` +
        `${result.truncated ? ' | output truncated' : ''}]`,
    );
    if (result.code != null && result.code !== 0) process.exitCode = result.code;
    return;
  }

  // Log summarizer demo.
  const summarizeIndex = args.indexOf('--summarize');
  if (summarizeIndex !== -1 && args[summarizeIndex + 1]) {
    const result = summarizeLog(args[summarizeIndex + 1], config.maxLogChars);
    console.log(`original length: ${result.originalLength} chars`);
    console.log(`truncated: ${result.truncated}`);
    console.log('---');
    console.log(result.summary);
    return;
  }

  // Interactive mode.
  const ctx = new Context(config);
  const llm = createProvider(config.model);
  const agent = new Agent(ctx, llm, config);
  const loop = new SystemLoop(ctx, agent, config, defaultConfigPath());
  loop.start();
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});