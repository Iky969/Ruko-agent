import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ReadStream, WriteStream } from 'node:tty';
import { Agent } from '../agent/agent.js';
import { ChatOptions, LLMProvider } from '../agent/llm.js';
import { defaultProcessManager } from '../agent/processManager.js';
import { setWorkspaceRoot } from '../agent/tools.js';
import { Context } from '../core/context.js';
import { LineEditor } from '../core/tui.js';
import { AgentConfig, ContextMessage, DEFAULT_CONFIG } from '../types.js';

class FakeInput extends EventEmitter {
  isTTY = true;
  rawMode = false;
  setRawMode(mode: boolean): void {
    this.rawMode = mode;
  }
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
  send(keys: string): void {
    this.emit('data', keys);
  }
}

class FakeOutput {
  data = '';
  isTTY = true;
  columns = 80;
  rows = 24;
  write(text: string): boolean {
    this.data += text;
    return true;
  }
}

function makeEditor(): { editor: LineEditor; input: FakeInput; output: FakeOutput } {
  const input = new FakeInput();
  const output = new FakeOutput();
  const editor = new LineEditor(input as unknown as ReadStream, output as unknown as WriteStream);
  return { editor, input, output };
}

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let out = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    out += s;
    return true;
  };
  try {
    const result = await fn();
    return { result, out };
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
}

function inTempWorkspace<T>(fn: (ws: string) => Promise<T> | T): Promise<T> {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-cancel-'));
  setWorkspaceRoot(ws);
  const prev = process.cwd();
  process.chdir(ws);
  return Promise.resolve(fn(ws)).finally(async () => {
    defaultProcessManager.reset();
    setWorkspaceRoot(null);
    process.chdir(prev);
    rmSync(ws, { recursive: true, force: true });
  });
}

const config: AgentConfig = { ...DEFAULT_CONFIG, approvalEnabled: false, funAnimations: false };

/** Streaming provider that yields tokens slowly until aborted */
class SlowStreamingProvider implements LLMProvider {
  readonly name = 'slow-streamer';
  readonly isConfigured = true;
  model = 'test-model';
  aborted = false;

  setModel(model: string): void {
    this.model = model;
  }

  async chat(_messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    options?.onToken?.('Mulai berpikir...');
    return new Promise((resolve, reject) => {
      if (options?.signal?.aborted) {
        this.aborted = true;
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      options?.signal?.addEventListener(
        'abort',
        () => {
          this.aborted = true;
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        },
        { once: true },
      );
    });
  }
}

/** Scripted provider that returns canned tool calls or responses */
class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly isConfigured = true;
  model = 'test-model';
  private replies: string[];
  private index = 0;

  constructor(replies: string[]) {
    this.replies = replies;
  }

  setModel(model: string): void {
    this.model = model;
  }

  async chat(_messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    const reply = this.replies[Math.min(this.index, this.replies.length - 1)];
    this.index += 1;
    options?.onToken?.(reply);
    return reply;
  }
}

test('ESC saat streaming LLM aktif → aborted dan menampilkan feedback pembatalan', async () => {
  await inTempWorkspace(async () => {
    const { editor, input } = makeEditor();
    const provider = new SlowStreamingProvider();
    const ctx = new Context(config);
    const agent = new Agent(ctx, provider, config);

    const ac = new AbortController();

    // Start ambient mode with onInterrupt wired to abort controller (as SystemLoop does)
    editor.startAmbient({
      prompt: '› ',
      onSubmit: () => {},
      onInterrupt: () => {
        ac.abort();
      },
    });

    const turnPromise = agent.handleInstruction('tugas streaming panjang', ac.signal);

    // Kirim tombol ESC (\u001b) saat streaming sedang aktif
    await new Promise((r) => setTimeout(r, 50));
    input.send('\u001b');

    const { result, out } = await captureStdout(() => turnPromise);
    editor.stopAmbient();

    assert.equal(result, '', 'turn aborted must return empty string');
    assert.equal(provider.aborted, true, 'provider received abort signal');
    assert.ok(
      out.includes('Dibatalkan oleh pengguna'),
      'feedback pembatalan jelas ditampilkan ke pengguna',
    );
  });
});

test('ESC saat tool exec durasi lama aktif → aborted', async () => {
  await inTempWorkspace(async () => {
    const { editor, input } = makeEditor();
    const provider = new ScriptedProvider([
      '```tool\n{"tool": "exec", "command": "exec node -e \\"setInterval(() => {}, 1000)\\""}\n```',
      'Selesai.',
    ]);
    const ctx = new Context(config);
    const agent = new Agent(ctx, provider, config);

    const ac = new AbortController();

    editor.startAmbient({
      prompt: '› ',
      onSubmit: () => {},
      onInterrupt: () => {
        ac.abort();
      },
    });

    const turnPromise = agent.handleInstruction('jalankan perintah lama', ac.signal);

    // Beri waktu hingga tool exec mulai berjalan, lalu kirim ESC
    await new Promise((r) => setTimeout(r, 200));
    input.send('\u001b');

    const { result, out } = await captureStdout(() => turnPromise);
    editor.stopAmbient();

    assert.equal(result, '', 'turn aborted must return empty string');
    assert.ok(
      out.includes('Dibatalkan oleh pengguna'),
      'feedback pembatalan ditampilkan di log workflow',
    );
  });
});

test('ESC saat start_process baru saja dipanggil → proses child TETAP hidup, hanya giliran agent yang dibatalkan', async () => {
  await inTempWorkspace(async (ws) => {
    const { editor, input } = makeEditor();
    // Agent memanggil start_process, lalu menunggu (step berikutnya)
    const provider = new ScriptedProvider([
      '```tool\n{"tool": "start_process", "command": "node -e \\"setInterval(() => {}, 1000)\\""}\n```',
      '```tool\n{"tool": "exec", "command": "exec node -e \\"setInterval(() => {}, 1000)\\""}\n```',
    ]);
    const ctx = new Context(config);
    const agent = new Agent(ctx, provider, config);

    const ac = new AbortController();

    editor.startAmbient({
      prompt: '› ',
      onSubmit: () => {},
      onInterrupt: () => {
        ac.abort();
      },
    });

    const turnPromise = agent.handleInstruction('start background dev server', ac.signal);

    // Beri waktu hingga start_process selesai dan masuk ke step berikutnya
    await new Promise((r) => setTimeout(r, 300));
    input.send('\u001b');

    const { result, out } = await captureStdout(() => turnPromise);
    editor.stopAmbient();

    assert.equal(result, '', 'giliran agent dibatalkan');
    assert.ok(out.includes('Dibatalkan oleh pengguna'));

    // Pastikan proses background dari start_process TETAP hidup
    const active = defaultProcessManager.getActiveProcesses();
    assert.equal(active.length, 1, 'proses background harus tetap terdaftar');
    const proc = active[0];
    assert.equal(proc.status, 'running');

    let isAlive = false;
    try {
      process.kill(proc.pid, 0);
      isAlive = true;
    } catch {
      isAlive = false;
    }
    assert.equal(isAlive, true, 'proses child TETAP hidup di sistem operasi');

    // Cleanup background process
    await defaultProcessManager.stopProcess(proc.id);
  });
});
