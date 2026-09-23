import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThinkingTicker, createSpinner, buildStatusPanel, stripAnsi, visibleLength } from '../core/ui.js';
import { listCommands, buildHelpText } from '../agent/commands.js';
import { createProvider, backoffDelay } from '../agent/llm.js';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { DEFAULT_CONFIG, ContextMessage } from '../types.js';

// ============================================================================
// 1. Ephemeral Thinking Ticker & Zero Reasoning Leak Tests
// ============================================================================

test('ThinkingTicker renders in-place dynamic ticker and clamps to terminal width', () => {
  const rendered: string[] = [];
  const ticker = new ThinkingTicker({
    onRender: (line) => rendered.push(line),
    width: () => 40,
  });

  ticker.start();
  assert.equal(rendered.length, 1);
  assert.ok(rendered[0].includes('• Thinking...'), 'initial thinking state shown');

  ticker.feed('First thought chunk ');
  assert.ok(rendered.length >= 2);
  const latest = stripAnsi(rendered[rendered.length - 1]);
  assert.ok(latest.startsWith('\r'), 'in-place rewrite begins with carriage return');
  assert.ok(latest.includes('• Thinking:'), 'ticker prefix present');
  assert.ok(latest.includes('First thought chunk'), 'snippet present');

  // Test auto-truncation on long reasoning chunks to prevent line wrapping (< 40 cols)
  ticker.feed('and here is a very long chain of reasoning thoughts that would wrap in narrow terminals without truncation');
  const clampedLine = rendered[rendered.length - 1];
  assert.ok(visibleLength(clampedLine) <= 39, `ticker line visibleLength must fit terminal width: ${visibleLength(clampedLine)} <= 39`);
});

test('ThinkingTicker flush clears dynamic line and emits exactly one summary line', () => {
  let cleared = false;
  const ticker = new ThinkingTicker({
    onClear: () => {
      cleared = true;
    },
  });

  ticker.feed('Analyzing the problem and searching repository files');
  assert.equal(cleared, false);

  const summary = ticker.flush();
  assert.equal(cleared, true, 'ticker line cleared on flush');
  assert.ok(summary !== null, 'summary returned');
  const plainSummary = stripAnsi(summary!);
  assert.match(plainSummary, /^• Thought for \d+(?:\.\d+)?s \(\d+ tokens\)$/, 'summary line matches required format');

  // Consecutive flush should return null (zero duplicate lines)
  const secondFlush = ticker.flush();
  assert.equal(secondFlush, null, 'subsequent flush is a no-op');
});

test('ThinkingTicker returns null if no reasoning chunks were fed', () => {
  const ticker = new ThinkingTicker();
  ticker.start();
  const summary = ticker.flush();
  assert.equal(summary, null, 'no summary line when no thought chunks occurred');
});

test('Reasoning text does not leak into output stream or final assistant message', async () => {
  const stdoutWrites: string[] = [];
  const origWrite = process.stdout.write;
  const origLog = console.log;

  process.stdout.write = ((chunk: any) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as any;

  console.log = ((...args: any[]) => {
    stdoutWrites.push(args.map(String).join(' ') + '\n');
  }) as any;

  try {
    const fakeLlm = {
      name: 'fake-reasoning-provider',
      isConfigured: true,
      model: 'test-model',
      setModel: () => {},
      chat: async (_messages: ContextMessage[], options?: any) => {
        // Feed reasoning chunk
        options?.onThought?.('INTERNAL_REASONING_SECRET_KEY_9999');
        // Feed token through onToken
        options?.onToken?.('<think>INTERNAL_REASONING_SECRET_KEY_9999</think>');
        options?.onToken?.('Here is the final answer.');
        return '<think>INTERNAL_REASONING_SECRET_KEY_9999</think>Here is the final answer.';
      },
    };

    const ctx = new Context({ ...DEFAULT_CONFIG, maxContextChars: 10_000 });
    const agent = new Agent(ctx, fakeLlm as any, { ...DEFAULT_CONFIG, maxToolIterations: 2 });

    const reply = await agent.handleInstruction('Jawab pertanyaan ini');

    // 1. Final reply text MUST NOT contain reasoning tokens
    assert.ok(!reply.includes('INTERNAL_REASONING_SECRET_KEY_9999'), 'reasoning must not leak to assistant response');
    assert.ok(reply.includes('Here is the final answer.'));

    // 2. Permanent log lines in stdoutWrites MUST NOT contain raw reasoning text
    const permanentLog = stdoutWrites
      .filter((w) => !w.startsWith('\r')) // ignore dynamic in-place updates
      .join('');
    assert.ok(!permanentLog.includes('INTERNAL_REASONING_SECRET_KEY_9999'), 'raw reasoning must not leak into permanent history');
    assert.ok(permanentLog.includes('• Thought for'), 'summary line must be present in history');
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }
});

// ============================================================================
// 2. Removal of /anim and Pac-Man Animation
// ============================================================================

test('/anim command is completely removed from registry and help text', () => {
  const commands = listCommands();
  const names = new Set(commands.map((c) => c.name));
  assert.ok(!names.has('anim'), '/anim must not be in commands list');

  const help = buildHelpText();
  assert.ok(!help.includes('/anim'), '/anim must not appear in /help output');
  assert.ok(!help.toLowerCase().includes('pac-man'), 'Pac-Man must not appear in /help text');
});

test('createSpinner uses clean dot spinner without pacman animation', () => {
  const writes: string[] = [];
  const origIsTTY = process.stdout.isTTY;
  const origWrite = process.stdout.write;
  const origCols = process.stdout.columns;
  delete process.env.NO_COLOR;

  try {
    process.stdout.isTTY = true;
    process.stdout.columns = 80;
    process.stdout.write = ((chunk: any) => {
      writes.push(String(chunk));
      return true;
    }) as any;

    const spinner = createSpinner('Working');
    assert.ok(writes.length >= 1);
    const first = stripAnsi(writes[0]);
    assert.ok(first.includes('▸ Working'), 'dot spinner rendered');
    assert.ok(!first.includes('Pac-Man') && !first.includes('(oo)'), 'no pacman or ghost symbols');
    spinner.stop();
  } finally {
    process.stdout.isTTY = origIsTTY;
    process.stdout.write = origWrite;
    process.stdout.columns = origCols;
  }
});

// ============================================================================
// 3. Termux Missing Glyph Fix (Universal ⚡ Symbol)
// ============================================================================

test('buildStatusPanel renders universal ⚡ symbol before model name and zero PUA NerdFont characters', () => {
  const panel = buildStatusPanel({
    width: 60,
    model: 'glm-4-flash',
    usedChars: 1000,
    budgetChars: 10000,
  });

  const fullText = panel.join('\n');
  const plainText = stripAnsi(fullText);

  // Model line should contain universal ⚡ symbol
  assert.ok(plainText.includes('⚡ glm'), 'model cell contains ⚡ symbol');

  // Verify zero Private Use Area (NerdFont) characters (U+E000 to U+F8FF)
  for (const char of fullText) {
    const cp = char.codePointAt(0)!;
    assert.ok(
      !(cp >= 0xe000 && cp <= 0xf8ff),
      `Status box must not contain NerdFont PUA characters (found U+${cp.toString(16)})`,
    );
  }
});

// ============================================================================
// 4. HTTP 429 Rate-Limit Exponential Backoff Tests
// ============================================================================

test('backoffDelay calculates exponential backoff: 1s, 2s, 4s', () => {
  assert.equal(backoffDelay(1, 1000, 15000), 1000, 'attempt 1 delay is 1s');
  assert.equal(backoffDelay(2, 1000, 15000), 2000, 'attempt 2 delay is 2s');
  assert.equal(backoffDelay(3, 1000, 15000), 4000, 'attempt 3 delay is 4s');
});

test('LLM client automatically retries 429 with 1s and 2s exponential backoff before failing', async () => {
  let attempts = 0;
  const recordedDelays: number[] = [];

  const provider = createProvider(
    { apiKey: 'test-key', baseUrl: 'https://api.example.com/v1', model: 'test-model' },
    {
      retries: 2,
      baseDelayMs: 1000,
      sleep: async (ms) => {
        recordedDelays.push(ms);
      },
    },
  );

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    attempts += 1;
    if (attempts <= 2) {
      return new Response('Rate limit reached (429)', { status: 429 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Success after backoff' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;

  try {
    const res = await provider.chat([{ role: 'user', content: 'halo', timestamp: '' }]);
    assert.equal(res, 'Success after backoff');
    assert.equal(attempts, 3, 'took initial attempt + 2 retries');
    assert.deepEqual(recordedDelays, [1000, 2000], 'exponential backoff 1s then 2s applied');
  } finally {
    globalThis.fetch = origFetch;
  }
});
