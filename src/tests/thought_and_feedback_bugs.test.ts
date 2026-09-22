import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildStatusBar,
  extractThoughts,
  formatDuration,
  RevealFilter,
  stripAnsi,
  stripThoughtBlocks,
  ThoughtSlidingWindow,
  ThoughtStreamParser,
  visibleLength,
} from '../core/ui.js';
import { parseToolCalls, setWorkspaceRoot, stripToolBlocks } from '../agent/tools.js';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { DEFAULT_CONFIG } from '../types.js';
import { handleCommand, listCommands } from '../agent/commands.js';

// ============================================================================
// 1. ThoughtSlidingWindow Tests
// ============================================================================

test('ThoughtSlidingWindow keeps exactly the last N words (FIFO sliding window)', () => {
  const rendered: string[] = [];
  const window = new ThoughtSlidingWindow({
    maxWords: 5,
    onRender: (line) => rendered.push(line),
  });

  window.feed('satu dua tiga empat lima ');
  assert.deepEqual(window.getWords(), ['satu', 'dua', 'tiga', 'empat', 'lima']);

  window.feed('enam ');
  assert.deepEqual(window.getWords(), ['dua', 'tiga', 'empat', 'lima', 'enam']);

  window.feed('tujuh delapan ');
  assert.deepEqual(window.getWords(), ['empat', 'lima', 'enam', 'tujuh', 'delapan']);

  const renderedStr = stripAnsi(window.render());
  assert.ok(renderedStr.includes('[berpikir] empat lima enam tujuh delapan'));
});

test('ThoughtSlidingWindow buffers partial in-flight words correctly', () => {
  const window = new ThoughtSlidingWindow({ maxWords: 5 });

  window.feed('memer');
  assert.deepEqual(window.getWords(), ['memer']);

  window.feed('iksa ');
  assert.deepEqual(window.getWords(), ['memeriksa']);

  window.feed('file ko');
  assert.deepEqual(window.getWords(), ['memeriksa', 'file', 'ko']);

  window.feed('de ');
  assert.deepEqual(window.getWords(), ['memeriksa', 'file', 'kode']);
});

test('ThoughtSlidingWindow clear properly wipes line with \\r\\x1b[2K and resets active state', () => {
  let cleared = false;
  const window = new ThoughtSlidingWindow({
    maxWords: 5,
    onClear: () => {
      cleared = true;
    },
  });

  window.feed('berpikir sesuatu ');
  assert.equal(window.isActive(), true);

  window.clear();
  assert.equal(cleared, true);
  assert.equal(window.isActive(), false);
  assert.deepEqual(window.getWords(), []);
});

// ============================================================================
// 2. ThoughtStreamParser Tests
// ============================================================================

test('ThoughtStreamParser separates thought tags and regular text across chunks', () => {
  let thoughts = '';
  let normalText = '';
  let ended = false;

  const parser = new ThoughtStreamParser({
    onText: (t) => {
      normalText += t;
    },
    onThought: (th) => {
      thoughts += th;
    },
    onThoughtEnd: () => {
      ended = true;
    },
  });

  const chunks = [
    'Halo! ',
    '<tho',
    'ught>Saya ',
    'perlu membaca file ',
    'terlebih dahulu</tho',
    'ught>Berikut adalah ',
    'jawabannya.',
  ];

  for (const c of chunks) parser.feed(c);
  parser.end();

  assert.equal(normalText, 'Halo! Berikut adalah jawabannya.');
  assert.equal(thoughts, 'Saya perlu membaca file terlebih dahulu');
  assert.equal(ended, true);
});

test('ThoughtStreamParser handles <think>...</think> tags and unclosed tags at end', () => {
  let thoughts = '';
  let normalText = '';

  const parser = new ThoughtStreamParser({
    onText: (t) => {
      normalText += t;
    },
    onThought: (th) => {
      thoughts += th;
    },
  });

  parser.feed('<think>Sedang menganalisis struktur...');
  parser.end();

  assert.equal(normalText, '');
  assert.equal(thoughts, 'Sedang menganalisis struktur...');
});

test('stripThoughtBlocks and extractThoughts operate accurately', () => {
  const text =
    'Preamble.\n<thought>Rencana 1: baca file</thought>\nTeks tengah.\n<think>Rencana 2: edit file</think>\nPenutup.';

  assert.equal(
    stripThoughtBlocks(text),
    'Preamble.\n\nTeks tengah.\n\nPenutup.',
  );

  const extracted = extractThoughts(text);
  assert.deepEqual(extracted, ['Rencana 1: baca file', 'Rencana 2: edit file']);
});

// ============================================================================
// 3. RevealFilter with DeepSeek DSML and XML Tool Calls (BUG A)
// ============================================================================

test('RevealFilter hides DeepSeek DSML invoke blocks from terminal streaming output', () => {
  let revealed = '';
  const filter = new RevealFilter((chunk) => {
    revealed += chunk;
  });

  filter.feed('Menganalisis kode...\n');
  filter.feed('<|DSML|invoke name="code_search">\n');
  filter.feed('<|DSML|parameter name="query" string="true">test</|DSML|parameter>\n');
  filter.feed('</|DSML|invoke>\n');
  filter.feed('Hasil pencarian selesai.');
  filter.end();

  assert.ok(!revealed.includes('<|DSML|'), 'DSML tags must not leak');
  assert.ok(!revealed.includes('code_search'), 'tool payload must not leak in reveal filter');
  assert.ok(revealed.includes('Menganalisis kode...'));
  assert.ok(revealed.includes('Hasil pencarian selesai.'));
});

test('RevealFilter hides unicode full-width DeepSeek DSML blocks', () => {
  let revealed = '';
  const filter = new RevealFilter((chunk) => {
    revealed += chunk;
  });

  filter.feed('Langkah 1: ');
  filter.feed('<｜DSML｜invoke name="read_file">');
  filter.feed('<｜DSML｜parameter name="path" string="true">a.ts</｜DSML｜parameter>');
  filter.feed('</｜DSML｜invoke>');
  filter.feed('Selesai.');
  filter.end();

  assert.equal(revealed, 'Langkah 1: Selesai.');
});

test('RevealFilter hides generic XML <tool_call>...</tool_call> blocks', () => {
  let revealed = '';
  const filter = new RevealFilter((chunk) => {
    revealed += chunk;
  });

  filter.feed('Memeriksa:\n<tool_call>{"name":"patch_file"}</tool_call>\nLanjut.');
  filter.end();

  assert.equal(revealed, 'Memeriksa:\nLanjut.');
});

test('RevealFilter hides feedback.txt leaked DSML format (<|DSML||calls><|DSML||invoke name="read_file">...)', () => {
  let revealed = '';
  const filter = new RevealFilter((chunk) => {
    revealed += chunk;
  });

  const chunk1 = 'Membaca file README.md...\n';
  const chunk2 = '<|DSML||calls><|DSML||invoke name="read_file"><|DSML||parameter name="path" string="true">README.md</|DSML||parameter></|DSML||invoke></|DSML||calls>\n';
  const chunk3 = 'File berhasil dibaca.';

  filter.feed(chunk1);
  filter.feed(chunk2);
  filter.feed(chunk3);
  filter.end();

  assert.ok(!revealed.includes('<|DSML||'), 'DSML tags must not leak');
  assert.ok(!revealed.includes('read_file'), 'tool payload must not leak');
  assert.equal(revealed, 'Membaca file README.md...\nFile berhasil dibaca.');

  // Also test character-by-character token streaming
  let charRevealed = '';
  const charFilter = new RevealFilter((c) => {
    charRevealed += c;
  });
  const full = `${chunk1}${chunk2}${chunk3}`;
  for (const ch of full) {
    charFilter.feed(ch);
  }
  charFilter.end();
  assert.equal(charRevealed, 'Membaca file README.md...\nFile berhasil dibaca.');
});

test('RevealFilter hides live deepseek-v4.1-flash full-width double-pipe format (<｜｜DSML｜｜ calls>...)', () => {
  let revealed = '';
  const filter = new RevealFilter((chunk) => {
    revealed += chunk;
  });

  const rawDsml = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read_file">\n<｜｜DSML｜｜ parameter name="path" string="true">README.md</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="limit" string="false">200</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>\n';

  filter.feed('Awal pemeriksaan:\n');
  filter.feed(rawDsml);
  filter.feed('Akhir pemeriksaan.');
  filter.end();

  assert.ok(!revealed.includes('DSML'), 'DSML must not leak');
  assert.ok(!revealed.includes('read_file'), 'tool payload must not leak');
  assert.equal(revealed, 'Awal pemeriksaan:\nAkhir pemeriksaan.');
});

// ============================================================================
// 4. parseToolCalls & stripToolBlocks (BUG A)
// ============================================================================

test('parseToolCalls parses DeepSeek DSML tool calls correctly', () => {
  const rawDsml = `
<thought>Saya akan mencari fungsi login</thought>
<|DSML|invoke name="code_search">
<|DSML|parameter name="query" string="true">authLogin</|DSML|parameter>
<|DSML|parameter name="path" string="true">src</|DSML|parameter>
<|DSML|parameter name="extension" string="true">ts,tsx</|DSML|parameter>
</|DSML|invoke>
`;

  const { calls } = parseToolCalls(rawDsml);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'code_search');
  assert.equal(calls[0].query, 'authLogin');
  assert.equal(calls[0].path, 'src');
  assert.equal(calls[0].extension, 'ts,tsx');

  const stripped = stripToolBlocks(rawDsml);
  assert.ok(!stripped.includes('<|DSML|'));
  assert.ok(!stripped.includes('authLogin'));
});

test('parseToolCalls parses feedback.txt leaked DSML format (<|DSML||calls><|DSML||invoke...>)', () => {
  const raw = '<|DSML||calls><|DSML||invoke name="read_file"><|DSML||parameter name="path" string="true">README.md</|DSML||parameter></|DSML||invoke></|DSML||calls>';
  const { calls } = parseToolCalls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'read_file');
  assert.equal(calls[0].path, 'README.md');

  const stripped = stripToolBlocks(`Pemeriksaan:\n${raw}\nSelesai.`);
  assert.ok(!stripped.includes('DSML'));
  assert.ok(!stripped.includes('read_file'));
  assert.equal(stripped, 'Pemeriksaan:\n\nSelesai.');
});

test('parseToolCalls parses live deepseek-v4.1-flash format with whitespace and double pipes', () => {
  const raw = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="read_file">
<｜｜DSML｜｜ parameter name="path" string="true">README.md</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="limit" string="false">200</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>`;

  const { calls } = parseToolCalls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'read_file');
  assert.equal(calls[0].path, 'README.md');
  assert.equal(calls[0].limit, 200);

  const stripped = stripToolBlocks(raw);
  assert.equal(stripped, '');
});

test('parseToolCalls parses unicode full-width DSML with numeric and boolean parameters', () => {
  const raw = `
<｜DSML｜tool_calls>
<｜DSML｜invoke name="read_file">
<｜DSML｜parameter name="path" string="true">PROGRESS.md</｜DSML｜parameter>
<｜DSML｜parameter name="offset" string="false">10</｜DSML｜parameter>
<｜DSML｜parameter name="limit" string="false">50</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>
`;

  const { calls } = parseToolCalls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'read_file');
  assert.equal(calls[0].path, 'PROGRESS.md');
  assert.equal(calls[0].offset, 10);
  assert.equal(calls[0].limit, 50);
});

test('parseToolCalls parses generic XML <tool_call> blocks', () => {
  const raw = `
<tool_call>
{"name": "patch_file", "arguments": {"path": "src/app.ts", "oldText": "const a = 1;", "newText": "const a = 2;"}}
</tool_call>
`;

  const { calls } = parseToolCalls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'patch_file');
  assert.equal(calls[0].path, 'src/app.ts');
  assert.equal(calls[0].oldText, 'const a = 1;');
  assert.equal(calls[0].newText, 'const a = 2;');
});

// ============================================================================
// 5. Multi-Step Task Completion Guard (BUG B Scenario)
// ============================================================================

test('Agent multi-step loop does not halt after read_file when instruction asks to fix/edit, nudging to edit phase', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-agent-multistep-'));
  setWorkspaceRoot(tmp);

  const targetFile = join(tmp, 'PROGRESS.md');
  writeFileSync(targetFile, 'Line 1: Normal\nLine 2: BUG: broken logic here\nLine 3: End\n', 'utf8');

  let callCount = 0;
  const recordedPrompts: string[] = [];

  const mockLlm = {
    name: 'mock-llm',
    isConfigured: true,
    model: 'deepseek-v4.1-flash',
    lastFinishReason: 'stop',
    setModel: () => {},
    chat: async (msgs: Array<{ role: string; content: string }>) => {
      callCount += 1;
      const lastMsg = msgs[msgs.length - 1];
      recordedPrompts.push(lastMsg.content);

      if (callCount === 1) {
        // First turn: model reads the file
        return '<thought>Saya akan membaca PROGRESS.md untuk menemukan bug</thought>\n```tool\n{"tool": "read_file", "path": "PROGRESS.md", "offset": 1, "limit": 200}\n```';
      }

      if (callCount === 2) {
        // Second turn: model returns intermediate reasoning WITHOUT tool call
        // Pre-fix: this caused premature halt ("[Selesai] Semua langkah tuntas")
        return '<thought>Saya menemukan bug pada baris 2: "BUG: broken logic here". Perbaikannya adalah menggantinya dengan "FIXED: valid logic".</thought>\nSaya sudah menemukan bug tersebut di PROGRESS.md.';
      }

      if (callCount === 3) {
        // Third turn: after receiving the nudge prompt, model executes the patch tool!
        return '<thought>Menerapkan perbaikan pada PROGRESS.md menggunakan patch_file</thought>\n```tool\n{"tool": "patch_file", "path": "PROGRESS.md", "oldText": "Line 2: BUG: broken logic here", "newText": "Line 2: FIXED: valid logic"}\n```';
      }

      // Fourth turn: final answer after tool execution
      return '<thought>Perbaikan berhasil diverifikasi.</thought>\nBug telah berhasil diperbaiki di PROGRESS.md.';
    },
  };

  const ctx = new Context({ ...DEFAULT_CONFIG, maxContextChars: 40000 });
  const agent = new Agent(ctx, mockLlm as any, { ...DEFAULT_CONFIG, maxContextChars: 40000 }, null, tmp);

  const result = await agent.handleInstruction('baca PROGRESS.md dan perbaiki salah satu bug yang ditemukan');

  // Verify that agent reached turn 4 and actually applied the patch!
  assert.ok(callCount >= 3, `Expected at least 3 LLM calls, got ${callCount}`);
  const updatedContent = readFileSync(targetFile, 'utf8');
  assert.ok(updatedContent.includes('FIXED: valid logic'), 'File must be modified by patch_file');
  assert.ok(result.includes('Bug telah berhasil diperbaiki'));

  rmSync(tmp, { recursive: true, force: true });
});

test('Verification: creates folder with buggy code, Ruko executes full multi-step process (> 3 processes) and fixes bug completely', async () => {
  const bugFolder = mkdtempSync(join(tmpdir(), 'ruko-bug-verification-'));
  setWorkspaceRoot(bugFolder);

  const bugFile = join(bugFolder, 'calculator.ts');
  const initialCode = `export function calculateTotal(prices: number[]): number {\n  // BUG: subtraction instead of addition\n  return prices.reduce((acc, val) => acc - val, 0);\n}\n`;
  writeFileSync(bugFile, initialCode, 'utf8');

  let processCount = 0;
  const recordedSteps: string[] = [];

  const llm = {
    name: 'test-llm',
    isConfigured: true,
    model: 'deepseek-v4.1-flash',
    lastFinishReason: 'stop',
    setModel: () => {},
    chat: async (msgs: Array<{ role: string; content: string }>) => {
      processCount += 1;
      const lastMsg = msgs[msgs.length - 1];
      recordedSteps.push(`Step ${processCount} [${lastMsg.role}]: ${lastMsg.content.slice(0, 80)}`);

      if (processCount === 1) {
        // Process 1: Read file to inspect the bug
        return '<thought>Saya akan membaca calculator.ts untuk memeriksa bug kalkulator</thought>\n```tool\n{"tool": "read_file", "path": "calculator.ts", "offset": 1, "limit": 50}\n```';
      }

      if (processCount === 2) {
        // Process 2: Intermediate reasoning without tool (pre-fix bug stopped here!)
        return '<thought>Analisis: bug terjadi karena pengurangan (acc - val). Harus diganti menjadi penambahan (acc + val).</thought>\nSaya telah menemukan penyebab bug kalkulator pada implementasi reduce.';
      }

      if (processCount === 3) {
        // Process 3: Nudge kicks in, agent calls patch_file
        return '<thought>Menerapkan perbaikan pada calculator.ts dengan patch_file</thought>\n```tool\n{"tool": "patch_file", "path": "calculator.ts", "oldText": "acc - val", "newText": "acc + val"}\n```';
      }

      // Process 4: Agent concludes after successful verification
      return '<thought>Perbaikan berhasil diterapkan dan diverifikasi.</thought>\nBug kalkulator telah tuntas diperbaiki.';
    },
  };

  const ctx = new Context({ ...DEFAULT_CONFIG, maxContextChars: 40000 });
  const agent = new Agent(ctx, llm as any, { ...DEFAULT_CONFIG, maxContextChars: 40000 }, null, bugFolder);

  const result = await agent.handleInstruction('perbaiki bug kalkulator pada file calculator.ts');

  // Verify it reached 4 processes (> 3 processes)
  assert.equal(processCount, 4, `Expected exactly 4 processes, got ${processCount}`);
  assert.ok(result.includes('Bug kalkulator telah tuntas diperbaiki'));

  // Verify file content was actually modified and fixed
  const fixedCode = readFileSync(bugFile, 'utf8');
  assert.ok(fixedCode.includes('acc + val'), 'File must contain the fixed addition code');
  assert.ok(!fixedCode.includes('acc - val'), 'Buggy subtraction must be gone');

  rmSync(bugFolder, { recursive: true, force: true });
});

// ============================================================================
// 6. Slash Command /ctx & /status (BUG C)
// ============================================================================

test('/ctx and /status commands exist in registry and display active context and budget', async () => {
  const commands = listCommands();
  const names = new Set(commands.map((c) => c.name));
  assert.ok(names.has('ctx'), 'missing /ctx command');

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };

  try {
    const ctx = new Context({ ...DEFAULT_CONFIG, maxContextChars: 50000 });
    ctx.add('user', 'halo');
    ctx.add('assistant', 'halo juga');

    const env: any = {
      ctx,
      config: { ...DEFAULT_CONFIG, maxContextChars: 80000 },
      llm: { model: 'deepseek-v4.1-flash', name: 'openai-compatible' },
      handle: { getSessionId: () => 'sess-123' },
    };

    await handleCommand('/ctx', env);
    const output = logs.join('\n');
    assert.ok(output.includes('Context Budget & Status Aktif'));
    assert.ok(output.includes('80,000'));
    assert.ok(output.includes('deepseek-v4.1-flash'));

    logs.length = 0;
    await handleCommand('/status', env);
    const statusOutput = logs.join('\n');
    assert.ok(statusOutput.includes('Context Budget & Status Aktif'));
  } finally {
    console.log = origLog;
  }
});

// ============================================================================
// 7. Status Bar Clamping on Narrow Screens (BUG D)
// ============================================================================

test('buildStatusBar strictly never exceeds target width on extra narrow screens (30 cols)', () => {
  const bar30 = buildStatusBar({
    model: 'deepseek-v4.1-flash',
    usedChars: 15000,
    budgetChars: 50000,
    width: 30,
    busy: true,
  });

  const plain = stripAnsi(bar30);
  assert.ok(plain.includes('ctx 30%'), 'ctx percentage must be preserved on narrow screen');
  assert.ok(visibleLength(bar30) <= 29, `Visible length ${visibleLength(bar30)} must be <= 29 cols`);
});

// ============================================================================
// 8. /settings Command and /? Help Alias
// ============================================================================

test('/settings command displays unified dashboard and allows tuning context, max-tokens, role, mode, approval', async () => {
  const commands = listCommands();
  const names = new Set(commands.map((c) => c.name));
  assert.ok(names.has('settings'), 'missing /settings command');

  // Verify DEFAULT_CONFIG context window freedom (512k chars = 128k tokens)
  assert.equal(DEFAULT_CONFIG.maxContextChars, 512_000);
  assert.equal(DEFAULT_CONFIG.maxOutputTokens, 4096);

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

  try {
    const config = { ...DEFAULT_CONFIG, maxContextChars: 100000, maxOutputTokens: 2048 };
    const ctx = new Context(config);
    ctx.add('user', 'halo settings');

    let updatedPatch: any = null;
    const env: any = {
      ctx,
      config,
      llm: { model: 'deepseek-v4.1-flash', name: 'openai-compatible' },
      handle: { getSessionId: () => 'sess-set' },
      updateConfig: (patch: any) => {
        updatedPatch = patch;
        Object.assign(config, patch);
      },
    };

    // Verify /? alias for help works via handleCommand
    logs.length = 0;
    await handleCommand('/?', env);
    assert.ok(logs.join('\n').includes('settings'));

    // 1. Dashboard overview
    await handleCommand('/settings', env);
    const dashboard = logs.join('\n');
    assert.ok(dashboard.includes('Settings & Configuration Dashboard'));
    assert.ok(dashboard.includes('MODEL & PROVIDER'));
    assert.ok(dashboard.includes('TOKEN & CONTEXT BUDGET'));
    assert.ok(dashboard.includes('BEHAVIOR & SAFETY'));

    // 2. /settings context
    logs.length = 0;
    await handleCommand('/settings context 128k', env);
    assert.equal(config.maxContextChars, 512000);
    assert.equal(updatedPatch.maxContextChars, 512000);

    // 3. /settings context unlimited
    logs.length = 0;
    await handleCommand('/settings context unlimited', env);
    assert.equal(config.maxContextChars, 2000000);

    // 4. /settings max-tokens
    logs.length = 0;
    await handleCommand('/settings max-tokens 4096', env);
    assert.equal(config.maxOutputTokens, 4096);
    assert.equal(updatedPatch.maxOutputTokens, 4096);

    // 5. /settings role
    logs.length = 0;
    await handleCommand('/settings role reviewer', env);
    assert.equal(config.role, 'reviewer');

    // 6. /settings mode
    logs.length = 0;
    await handleCommand('/settings mode pro', env);
    assert.equal(config.mode, 'pro');

    // 7. /settings approval
    logs.length = 0;
    await handleCommand('/settings approval yolo', env);
    assert.equal(config.approvalEnabled, false);

    // 8. /settings anim
    logs.length = 0;
    await handleCommand('/settings anim off', env);
    assert.equal(config.funAnimations, false);
  } finally {
    console.log = origLog;
  }
});

// ============================================================================
// 9. /usage Agent Active Working Time & Duration Formatting
// ============================================================================

test('formatDuration and /usage active working time tracking', async () => {
  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(4200), '4.2s');
  assert.equal(formatDuration(65000), '1m 5s');
  assert.equal(formatDuration(120000), '2m 0s');

  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const mockLlm = {
    name: 'test-llm',
    isConfigured: true,
    model: 'mock-model',
    chat: async () => {
      // simulate agent taking 25ms of active work
      await new Promise((r) => setTimeout(r, 25));
      return 'Jawaban';
    },
  };

  const agent = new Agent(ctx, mockLlm as any, config);
  await agent.handleInstruction('tes durasi aktif');

  assert.ok(agent.sessionUsage.activeWorkingMs >= 20, `expected activeWorkingMs >= 20, got ${agent.sessionUsage.activeWorkingMs}`);
  assert.equal(agent.sessionUsage.totalTurns, 1);

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

  try {
    const env: any = {
      ctx,
      config,
      llm: mockLlm,
      agent,
      handle: { getSessionId: () => 'sess-dur' },
    };

    await handleCommand('/usage', env);
    const usageOutput = logs.join('\n');
    assert.ok(usageOutput.includes('WAKTU KERJA AKTIF AGENT'));
    assert.ok(usageOutput.includes('Total waktu kerja:'));
    assert.ok(usageOutput.includes('Rata-rata per turn:'));
    assert.ok(usageOutput.includes('cache'));
  } finally {
    console.log = origLog;
  }
});

// ============================================================================
// 10. DeepSeek v4.1 Flash DSML End-to-End Agent Execution
// ============================================================================

test('Agent executes deepseek-v4.1-flash DSML response without leaking to terminal and completes read_file tool call', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-deepseek-dsml-'));
  setWorkspaceRoot(tmp);
  writeFileSync(join(tmp, 'README.md'), '# Test DeepSeek DSML\nIni adalah file proyek testing.\n', 'utf-8');

  let callCount = 0;
  const mockProvider = {
    name: 'openai-compatible',
    isConfigured: true,
    model: 'deepseek-v4.1-flash',
    setModel() {},
    async chat(messages: any[], options?: any) {
      callCount++;
      if (callCount === 1) {
        const raw = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="read_file">\n<｜｜DSML｜｜ parameter name="path" string="true">README.md</｜｜DSML｜｜ parameter>\n<｜｜DSML｜｜ parameter name="limit" string="false">200</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';
        for (const ch of raw) {
          options?.onToken?.(ch);
        }
        return raw;
      }
      return 'File README.md berisi dokumentasi proyek testing Ruko.';
    },
  };

  const config = { ...DEFAULT_CONFIG, maxToolIterations: 5, mode: 'beginner' as const };
  const ctx = new Context(config);
  const agent = new Agent(ctx, mockProvider as any, config, async () => true, tmp);

  try {
    const res = await agent.handleInstruction('baca file README.md dan jelaskan isinya');
    assert.equal(callCount, 2);
    assert.ok(res.includes('README.md'));
    assert.ok(!res.includes('DSML'), 'Result text must not contain DSML tags');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

