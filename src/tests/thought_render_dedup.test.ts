import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { ChatOptions, LLMProvider } from '../agent/llm.js';
import { setWorkspaceRoot } from '../agent/tools.js';
import { ReasoningPanel, stripAnsi } from '../core/ui.js';
import { ContextMessage, DEFAULT_CONFIG } from '../types.js';

/**
 * Minimal terminal emulator: tracks logical screen lines, honouring \r,
 * \n and \u001b[2K (clear line) while ignoring SGR colour codes. Used to
 * prove a thought paragraph ends up on the final screen exactly once —
 * counting raw bytes would also count the overwritten live partial line.
 */
export function emulateScreen(output: string): string[] {
  const lines: string[] = [''];
  let col = 0;
  let i = 0;
  while (i < output.length) {
    if (output.startsWith('\u001b[2K', i)) {
      lines[lines.length - 1] = '';
      col = 0;
      i += 4;
      continue;
    }
    const esc = /^\u001b\[[0-9;]*[A-Za-z]/.exec(output.slice(i));
    if (esc) {
      i += esc[0].length;
      continue;
    }
    const ch = output[i];
    if (ch === '\r') {
      col = 0;
      i += 1;
      continue;
    }
    if (ch === '\n') {
      lines.push('');
      col = 0;
      i += 1;
      continue;
    }
    let line = lines[lines.length - 1];
    if (col >= line.length) line += ch;
    else line = line.slice(0, col) + ch + line.slice(col + 1);
    lines[lines.length - 1] = line;
    col += 1;
    i += 1;
  }
  return lines;
}

function countOccurrences(lines: string[], needle: string): number {
  return lines.reduce((n, line) => n + (line.includes(needle) ? 1 : 0), 0);
}

/**
 * Tee stdout: forward every write to the real stdout AND record a copy.
 * Never swallow — node:test writes TAP result lines lazily, and a patch
 * that swallows output eats the previous test's result lines.
 */
function teeStdout(): { getOutput: () => string; restore: () => void } {
  const origWrite = process.stdout.write.bind(process.stdout);
  let output = '';
  const patched = function (chunk: unknown, ...args: unknown[]): boolean {
    const text =
      typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk);
    output += text;
    return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args);
  };
  process.stdout.write = patched as typeof process.stdout.write;
  return {
    getOutput: () => output,
    restore: () => {
      process.stdout.write = origWrite as typeof process.stdout.write;
    },
  };
}

class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly isConfigured = true;
  model = 'mock-model';
  lastFinishReason: string | null = 'stop';
  lastReasoning: string | null = null;
  receivedMessages: ContextMessage[][] = [];
  private calls = 0;

  constructor(
    private readonly visible: boolean | null,
    private readonly script: (callIndex: number, options: ChatOptions) => string,
  ) {}

  setModel(model: string): void {
    this.model = model;
  }

  async detectVisibleReasoning(): Promise<boolean | null> {
    return this.visible;
  }

  async chat(messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    this.receivedMessages.push([...messages]);
    const idx = this.calls;
    this.calls += 1;
    return this.script(idx, options ?? {});
  }
}

function makeAgent(provider: LLMProvider): Agent {
  const config = { ...DEFAULT_CONFIG, maxToolIterations: 6 };
  const ctx = new Context(config);
  return new Agent(ctx, provider, config);
}

test('panel satu-baris: paragraf panjang dalam chunk 12 karakter muncul tepat 1x di layar 80 kolom', () => {
  let raw = '';
  const panel = new ReasoningPanel({
    onLive: (line) => {
      raw += line;
    },
    onClear: () => {
      raw += '\r\u001b[2K';
    },
    throttleMs: 0,
    width: () => 80,
  });
  const paragraph = `PARAGRAF-PANJANG-UNIK ${'kata demi kata berpikir panjang '.repeat(12)}`.trim();
  assert.ok(paragraph.length > 300, 'paragraf harus cukup panjang untuk membungkus');
  panel.start();
  for (let i = 0; i < paragraph.length; i += 12) {
    panel.feed(paragraph.slice(i, i + 12));
  }
  panel.finish();
  const screen = emulateScreen(stripAnsi(raw));
  assert.equal(
    countOccurrences(screen, 'PARAGRAF-PANJANG-UNIK'),
    1,
    `Paragraf harus muncul tepat 1x di layar akhir, layar:\n${screen.join('\n')}`,
  );
});

test('dedup native + <think> identik: thought 1x dan baris glob tetap tercetak', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-dedup-test-'));
  setWorkspaceRoot(tmp);
  const tee = teeStdout();
  try {
    writeFileSync(join(tmp, 'a.html'), '<h1>a</h1>', 'utf8');
    writeFileSync(join(tmp, 'b.html'), '<h1>b</h1>', 'utf8');
    const native =
      'Native reasoning about listing html files in the project directory now, step by step.';
    const provider = new ScriptedProvider(true, (idx, options) => {
      if (idx === 0) {
        options.onThought?.(native);
        const reply =
          `<think>${native}</think>\n\`\`\`tool\n{"tool": "glob", "pattern": "**/*.html"}\n\`\`\``;
        options.onToken?.(reply);
        return reply;
      }
      options.onToken?.('Selesai, dua file html ditemukan.');
      return 'Selesai, dua file html ditemukan.';
    });
    const agent = makeAgent(provider);
    const result = await agent.handleInstruction('cari file html');
    assert.ok(result.includes('Selesai'), 'turn selesai dengan jawaban akhir');
    const screen = emulateScreen(stripAnsi(tee.getOutput()));
    assert.equal(
      countOccurrences(screen, 'Native reasoning about listing html'),
      1,
      `Thought native + tag identik harus tampil 1x, layar:\n${screen.join('\n')}`,
    );
    assert.ok(
      screen.some((line) => line.includes('find **/*.html')),
      `Baris tool-call glob harus tetap tercetak (tidak terkubur):\n${screen.join('\n')}`,
    );
  } finally {
    tee.restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('konten tag berbeda dari native tetap dirender', async () => {
  const tee = teeStdout();
  try {
    const native = 'NATIVE-ALPHA reasoning about the plan, checking the project layout first.';
    const tag = 'TAG-BETA different analysis: the config file needs a second look here.';
    const provider = new ScriptedProvider(true, (_idx, options) => {
      options.onThought?.(native);
      const reply = `<thought>${tag}</thought>\nJawaban akhir sudah siap.`;
      options.onToken?.(reply);
      return reply;
    });
    const agent = makeAgent(provider);
    const result = await agent.handleInstruction('periksa konfigurasi');
    assert.ok(result.includes('Jawaban akhir sudah siap.'));
    const screen = emulateScreen(stripAnsi(tee.getOutput()));
    assert.equal(countOccurrences(screen, 'NATIVE-ALPHA'), 1, 'thought native tampil 1x');
    assert.equal(countOccurrences(screen, 'TAG-BETA'), 1, 'thought tag yang berbeda tetap tampil 1x');
  } finally {
    tee.restore();
  }
});

test('tanpa native, blok tag dirender seperti dulu', async () => {
  const tee = teeStdout();
  try {
    const tag = 'TAG-GAMMA fallback reasoning: read the readme before answering now.';
    const provider = new ScriptedProvider(false, (_idx, options) => {
      const reply = `<thought>${tag}</thought>\nHalo, ini jawabannya.`;
      options.onToken?.(reply);
      return reply;
    });
    const agent = makeAgent(provider);
    const result = await agent.handleInstruction('sapa saya');
    assert.equal(result, 'Halo, ini jawabannya.');
    const screen = emulateScreen(stripAnsi(tee.getOutput()));
    assert.equal(countOccurrences(screen, 'TAG-GAMMA'), 1, 'thought tag fallback tampil 1x');
  } finally {
    tee.restore();
  }
});
