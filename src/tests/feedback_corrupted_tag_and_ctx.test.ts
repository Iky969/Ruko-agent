import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls, stripToolBlocks } from '../agent/tools.js';
import { RevealFilter, stripAnsi, visibleLength } from '../core/ui.js';
import { handleCommand, listCommands } from '../agent/commands.js';
import { Context } from '../core/context.js';
import { DEFAULT_CONFIG } from '../types.js';

// ============================================================================
// Item 1: Robustness against non-ASCII / CJK corrupted tool tags
// ============================================================================

test('Item 1: parseToolCalls detects non-ASCII/CJK tag name as malformed tool-call', () => {
  const payload1 = '<認 name=code_search tool="code_search" query="authLogin" path="src" />';
  const res1 = parseToolCalls(payload1);
  assert.equal(res1.calls.length, 0, 'Must not be parsed as valid executable call');
  assert.equal(res1.malformedBlocks.length, 1, 'Must be marked as malformed tool call');
  assert.ok(res1.malformedBlocks[0].includes('認'), 'Malformed block must preserve corrupted tag');

  // Katakana tag name: <ツール name="read_file" .../>
  const payload2 = '<ツール name="read_file" path="src/agent/llm.ts" />';
  const res2 = parseToolCalls(payload2);
  assert.equal(res2.calls.length, 0);
  assert.equal(res2.malformedBlocks.length, 1);
  assert.ok(res2.malformedBlocks[0].includes('ツール'));

  // Kanji tag name with body
  const payload3 = 'Memeriksa berkas:\n<関数 name="exec" command="npm test">konten</関数>\nSelesai.';
  const res3 = parseToolCalls(payload3);
  assert.equal(res3.calls.length, 0);
  assert.equal(res3.malformedBlocks.length, 1);
  assert.ok(res3.malformedBlocks[0].includes('関数'));
});

test('Item 1: stripToolBlocks strips non-ASCII/CJK corrupted tool tags from assistant output', () => {
  const raw = 'Menganalisis codebase:\n<認 name=code_search tool="code_search" query="authLogin" path="src" />\nPencarian selesai.';
  const stripped = stripToolBlocks(raw);

  assert.ok(!stripped.includes('<認'), 'Corrupted tag must not leak in stripped output');
  assert.ok(!stripped.includes('code_search'), 'Tool arguments in corrupted tag must not leak');
  assert.ok(stripped.includes('Menganalisis codebase:'));
  assert.ok(stripped.includes('Pencarian selesai.'));
});

test('Item 1: RevealFilter hides non-ASCII/CJK corrupted tool tags during streaming', () => {
  // 1. Chunked streaming
  let chunkEmitted = '';
  const chunkFilter = new RevealFilter((t) => {
    chunkEmitted += t;
  });

  chunkFilter.feed('Sedang memeriksa kode...\n');
  chunkFilter.feed('<認 name=code_search tool="code_search" query="authLogin" path="src" />\n');
  chunkFilter.feed('Pemeriksaan tuntas.');
  chunkFilter.end();

  assert.ok(!chunkEmitted.includes('<認'), 'Tag with CJK must not leak during chunked streaming');
  assert.ok(!chunkEmitted.includes('code_search'), 'Tool payload must not leak');
  assert.ok(chunkEmitted.includes('Sedang memeriksa kode...'));
  assert.ok(chunkEmitted.includes('Pemeriksaan tuntas.'));

  // 2. Character-by-character token streaming
  let charEmitted = '';
  const charFilter = new RevealFilter((t) => {
    charEmitted += t;
  });

  const fullText = 'Sedang mencari:\n<認 name=code_search tool="code_search" query="authLogin" path="src" />\nHasil ditemukan.';
  for (const ch of fullText) {
    charFilter.feed(ch);
  }
  charFilter.end();

  assert.ok(!charEmitted.includes('<認'), 'Tag with CJK must not leak during char-by-char streaming');
  assert.ok(!charEmitted.includes('code_search'), 'Tool name must not leak during char-by-char streaming');
  assert.ok(charEmitted.includes('Sedang mencari:'));
  assert.ok(charEmitted.includes('Hasil ditemukan.'));
});

// ============================================================================
// Item 2: /ctx command for active context & token budget verification
// ============================================================================

test('Item 2: /ctx command exists and has /budget and /status aliases', () => {
  const commands = listCommands();
  const ctxCmd = commands.find((c) => c.name === 'ctx');
  assert.ok(ctxCmd, '/ctx command must be registered');
  assert.ok(ctxCmd.aliases?.includes('budget'), '/budget must be registered as alias for /ctx');
  assert.ok(ctxCmd.aliases?.includes('status'), '/status must be registered as alias for /ctx');
});

test('Item 2: /ctx displays correct default context and token budget values when not overridden', async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };

  try {
    const config = { ...DEFAULT_CONFIG };
    const ctx = new Context(config);
    const env: any = {
      ctx,
      config,
      llm: { model: 'deepseek-v4.1-flash', name: 'openai-compatible' },
      handle: { getSessionId: () => 'sess-test' },
      updateConfig: (patch: any) => Object.assign(config, patch),
    };

    await handleCommand('/ctx', env);
    const output = logs.join('\n');

    assert.ok(output.includes('512,000'), 'Default context window limit (512,000 chars) must be displayed');
    assert.ok(output.includes('128,000'), 'Default token budget (~128,000 tokens) must be displayed');
    assert.ok(output.includes('4,096'), 'Default max output tokens (4,096) must be displayed');
    assert.ok(output.includes('0%'), 'Context percent (0%) must be displayed');
  } finally {
    console.log = origLog;
  }
});

test('Item 2: /ctx reflects overridden context limits after /setctx and /settoken', async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };

  try {
    const config = { ...DEFAULT_CONFIG };
    const ctx = new Context(config);
    const env: any = {
      ctx,
      config,
      llm: { model: 'deepseek-v4.1-flash', name: 'openai-compatible' },
      handle: { getSessionId: () => 'sess-test' },
      updateConfig: (patch: any) => Object.assign(config, patch),
    };

    // 1. Override via /setctx
    await handleCommand('/setctx 80000', env);
    logs.length = 0;
    await handleCommand('/ctx', env);
    const setctxOutput = logs.join('\n');
    assert.ok(setctxOutput.includes('80,000'), 'Active limit must reflect 80,000 chars');
    assert.ok(setctxOutput.includes('20,000'), 'Active token budget must reflect ~20,000 tokens');

    // 2. Override via /settoken
    logs.length = 0;
    await handleCommand('/settoken 16k', env);
    logs.length = 0;
    await handleCommand('/ctx', env);
    const settokenOutput = logs.join('\n');
    assert.ok(settokenOutput.includes('64,000'), 'Active limit must reflect 64,000 chars (16k * 4)');
    assert.ok(settokenOutput.includes('16,000'), 'Active token budget must reflect 16,000 tokens');

    // 3. Verify /budget and /status aliases
    logs.length = 0;
    await handleCommand('/budget', env);
    const budgetOutput = logs.join('\n');
    assert.ok(budgetOutput.includes('16,000'), '/budget alias must produce active budget output');

    logs.length = 0;
    await handleCommand('/status', env);
    const statusOutput = logs.join('\n');
    assert.ok(statusOutput.includes('16,000'), '/status alias must produce active budget output');
  } finally {
    console.log = origLog;
  }
});

test('Item 2: /ctx output adapts to narrow screens without cutting off essential budget info', async () => {
  const logs: string[] = [];
  const origLog = console.log;
  const origCols = process.stdout.columns;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };

  try {
    // Simulate narrow terminal (Termux / 40 columns)
    process.stdout.columns = 40;

    const config = { ...DEFAULT_CONFIG, maxContextChars: 80000, maxOutputTokens: 2048 };
    const ctx = new Context(config);
    ctx.add('user', 'halo');
    const env: any = {
      ctx,
      config,
      llm: { model: 'deepseek-v4.1-flash', name: 'openai-compatible' },
      handle: { getSessionId: () => 'sess-test' },
      updateConfig: (patch: any) => Object.assign(config, patch),
    };

    await handleCommand('/ctx', env);
    const output = logs.join('\n');
    const lines = output.split('\n');

    // Ensure all rows fit within the 40-col width
    for (const line of lines) {
      assert.ok(visibleLength(line) <= 40, `Line exceeds terminal width 40: "${line}" (width: ${visibleLength(line)})`);
    }

    // Ensure all critical fields remain fully readable (not truncated with ellipsis)
    const plain = stripAnsi(output);
    assert.ok(plain.includes('80,000'), 'Context limit (80,000) must not be cut off');
    assert.ok(plain.includes('20,000'), 'Token budget (20,000) must not be cut off');
    assert.ok(plain.includes('2,048'), 'Max output tokens (2,048) must not be cut off');
    assert.ok(plain.includes('deepseek-v4.1-flash'), 'Model name must not be lost');
  } finally {
    process.stdout.columns = origCols;
    console.log = origLog;
  }
});
