import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent } from '../agent/agent.js';
import {
  extractFallbackToolCall,
  extractFallbackToolCalls,
  normalizeToolName,
  parseToolCalls,
  setWorkspaceRoot,
  stripToolBlocks,
} from '../agent/tools.js';
import { Context } from '../core/context.js';
import { RevealFilter, stripAnsi } from '../core/ui.js';
import { DEFAULT_CONFIG } from '../types.js';

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; writes: string[] }> {
  const original = process.stdout.write.bind(process.stdout);
  let out = '';
  const writes: string[] = [];
  (process.stdout as unknown as { write: (s: any, ...args: any[]) => boolean }).write = (
    s: any,
    ...args: any[]
  ) => {
    const str = typeof s === 'string' ? s : s?.toString() ?? '';
    out += str;
    writes.push(str);
    return true;
  };
  try {
    const result = await fn();
    return { result, out, writes };
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
}

test('normalizeToolName maps aliases to canonical internal tool names', () => {
  // Read aliases
  assert.equal(normalizeToolName('read_file'), 'read_file');
  assert.equal(normalizeToolName('Read'), 'read_file');
  assert.equal(normalizeToolName('read'), 'read_file');
  assert.equal(normalizeToolName('ReadFile'), 'read_file');

  // Bash / Exec aliases
  assert.equal(normalizeToolName('Bash'), 'exec');
  assert.equal(normalizeToolName('bash'), 'exec');
  assert.equal(normalizeToolName('shell'), 'exec');
  assert.equal(normalizeToolName('execute_command'), 'exec');
  assert.equal(normalizeToolName('sh'), 'exec');
  assert.equal(normalizeToolName('terminal'), 'exec');

  // Edit / Write aliases
  assert.equal(normalizeToolName('Edit'), 'edit_file');
  assert.equal(normalizeToolName('EditFile'), 'edit_file');
  assert.equal(normalizeToolName('Write'), 'write_file');
  assert.equal(normalizeToolName('write_file'), 'write_file');

  // Search aliases
  assert.equal(normalizeToolName('Search'), 'code_search');
  assert.equal(normalizeToolName('search_files'), 'code_search');
  assert.equal(normalizeToolName('find_in_files'), 'code_search');

  // Glob aliases
  assert.equal(normalizeToolName('Glob'), 'glob');
  assert.equal(normalizeToolName('glob_files'), 'glob');
  assert.equal(normalizeToolName('list_files'), 'glob');

  assert.equal(normalizeToolName('ListDir'), 'list_dir');
  assert.equal(normalizeToolName('Delete'), 'delete_file');
  assert.equal(normalizeToolName('Move'), 'move_file');
});

test('parseToolCalls parses feedback.txt exact scenario: <tool>{"tool": "read_file", "path": "README.md"}</tool>', () => {
  const raw = '<tool>\n{"tool": "read_file", "path": "README.md"}\n</tool>';
  const { calls } = parseToolCalls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'read_file');
  assert.equal(calls[0].path, 'README.md');
});

test('parseToolCalls parses unclosed <tool> tag (streaming / truncated)', () => {
  const raw = 'Sedang membaca berkas...\n<tool>\n{"tool": "read_file", "path": "README.md"}';
  const { calls } = parseToolCalls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'read_file');
  assert.equal(calls[0].path, 'README.md');
});

test('parseToolCalls maps tool alias "Read" and normalized arguments', () => {
  const raw = '<tool>\n{"tool": "Read", "file": "README.md"}\n</tool>';
  const { calls } = parseToolCalls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'read_file');
  assert.equal(calls[0].path, 'README.md');
});

test('parseToolCalls parses tag with name attribute: <tool name="read_file">{"path": "README.md"}</tool>', () => {
  const raw = '<tool name="read_file">{"path": "README.md"}</tool>';
  const { calls } = parseToolCalls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'read_file');
  assert.equal(calls[0].path, 'README.md');
});

test('parseToolCalls parses nested parameters / arguments payload', () => {
  const raw = '<tool>{"name": "read_file", "parameters": {"path": "README.md"}}</tool>';
  const { calls } = parseToolCalls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'read_file');
  assert.equal(calls[0].path, 'README.md');
});

test('parseToolCalls parses multiple <tool> tags in single message', () => {
  const raw =
    '<tool>{"tool": "read_file", "path": "README.md"}</tool>\n' +
    '<tool>{"tool": "read_file", "path": "package.json"}</tool>';
  const { calls } = parseToolCalls(raw);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tool, 'read_file');
  assert.equal(calls[0].path, 'README.md');
  assert.equal(calls[1].tool, 'read_file');
  assert.equal(calls[1].path, 'package.json');
});

test('stripToolBlocks removes closed and unclosed <tool> tags keeping surrounding text', () => {
  const text1 = 'Halo, saya akan memeriksa berkas.\n<tool>\n{"tool": "read_file", "path": "README.md"}\n</tool>';
  assert.equal(stripToolBlocks(text1), 'Halo, saya akan memeriksa berkas.');

  const text2 = 'Pemeriksaan dimulai:\n<tool>\n{"tool": "read_file", "path": "README.md"}';
  assert.equal(stripToolBlocks(text2), 'Pemeriksaan dimulai:');
});

test('RevealFilter hides <tool>...</tool> from terminal streaming output', () => {
  let emitted = '';
  const filter = new RevealFilter((chunk) => {
    emitted += chunk;
  });

  const chunks = [
    'Saya ',
    'akan ',
    'membaca ',
    'berkas.\n',
    '<to',
    'ol>\n',
    '{"tool": "read_file", "path": "README.md"}\n',
    '</to',
    'ol>\n',
    'Tunggu sebentar.',
  ];

  for (const chunk of chunks) {
    filter.feed(chunk);
  }
  filter.end();

  assert.ok(emitted.includes('Saya akan membaca berkas.'));
  assert.ok(emitted.includes('Tunggu sebentar.'));
  assert.ok(!emitted.includes('<tool>'), 'emitted text must not contain <tool>');
  assert.ok(!emitted.includes('read_file'), 'emitted text must not contain raw tool payload');
  assert.ok(!emitted.includes('</tool>'), 'emitted text must not contain </tool>');
});

test('RevealFilter hides unclosed <tool> tag upon stream end()', () => {
  let emitted = '';
  const filter = new RevealFilter((chunk) => {
    emitted += chunk;
  });

  const chunks = [
    'Membaca berkas:\n',
    '<tool>\n{"tool": "read_file", "path": "README.md"}',
  ];

  for (const chunk of chunks) {
    filter.feed(chunk);
  }
  filter.end();

  assert.ok(emitted.includes('Membaca berkas:'));
  assert.ok(!emitted.includes('<tool>'), 'unclosed <tool> must be suppressed at stream end');
  assert.ok(!emitted.includes('read_file'), 'unclosed payload must not leak');
});

test('End-to-End: Agent intercepts pseudo-tool <tool>, executes read_file, logs compact UI, and does not leak raw tag', async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-pseudo-tool-test-'));
  setWorkspaceRoot(tmpWs);
  writeFileSync(join(tmpWs, 'README.md'), '# Documentation\nRuko Agent Testing\n', 'utf-8');

  let callCount = 0;
  const mockProvider = {
    name: 'openrouter',
    isConfigured: true,
    model: 'nvidia/nemotron-3-ultra',
    setModel() {},
    async chat(messages: any[], options?: any) {
      callCount++;
      if (callCount === 1) {
        // First turn: model outputs pseudo-tool XML tag in text
        const responseText =
          'Saya akan membaca README.md terlebih dahulu.\n<tool>\n{"tool": "read_file", "path": "README.md"}\n</tool>';
        for (const ch of responseText) {
          options?.onToken?.(ch);
        }
        return responseText;
      }
      // Second turn: model receives tool execution result and answers
      assert.ok(
        messages.some(
          (m: any) =>
            m.role === 'tool' &&
            m.content.includes('Result of tool "read_file"') &&
            m.content.includes('Documentation'),
        ),
        'tool result for read_file must be sent to model in messages',
      );
      return 'Berdasarkan README.md, proyek ini adalah Ruko Agent Testing.';
    },
  };

  try {
    const config = { ...DEFAULT_CONFIG, mode: 'beginner' as const };
    const ctx = new Context(config);
    const agent = new Agent(ctx, mockProvider as any, config, async () => true, tmpWs);

    const { result: finalAnswer, out } = await captureStdout(() => agent.handleInstruction('baca README.md'));
    assert.equal(callCount, 2, 'agent should loop 2 times: 1 tool execution + 1 final answer');
    assert.ok(finalAnswer.includes('Ruko Agent Testing'));
    assert.ok(!finalAnswer.includes('<tool>'), 'final answer must never contain <tool>');

    // Check logs: compact format [No] 📖 Read README.md should be printed
    const plainLogs = stripAnsi(out);
    assert.ok(
      plainLogs.includes('📖 Read README.md') || plainLogs.includes('Read(README.md)'),
      `logs should indicate Read(README.md) tool execution: ${plainLogs}`,
    );
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('Universal Fallback Parser: extractFallbackToolCall and extractFallbackToolCalls multi-format detection', () => {
  // 1. Nemotron style
  const nemotron = '<tool>{"tool": "read_file", "path": "README.md"}</tool>';
  const nemoCall = extractFallbackToolCall(nemotron);
  assert.ok(nemoCall);
  assert.equal(nemoCall.tool, 'read_file');
  assert.equal(nemoCall.path, 'README.md');

  // 2. DeepSeek DSML style
  const deepseek = '<|DSML|calls><|DSML|invoke name="read_file"><|DSML|parameter name="file_path" string="true">README.md</|DSML|parameter></|DSML|invoke></|DSML|calls>';
  const dsCall = extractFallbackToolCall(deepseek);
  assert.ok(dsCall);
  assert.equal(dsCall.tool, 'read_file');
  assert.equal(dsCall.path, 'README.md', 'file_path parameter must be normalized to path');

  // 3. Markdown JSON style
  const markdownJson = '```json\n{"name": "Read", "arguments": {"path": "README.md"}}\n```';
  const mdCall = extractFallbackToolCall(markdownJson);
  assert.ok(mdCall);
  assert.equal(mdCall.tool, 'read_file');
  assert.equal(mdCall.path, 'README.md');

  // 4. Markdown JSON style with tool & file_path
  const mdJsonDirect = '```json\n{"tool": "edit_file", "file_path": "index.ts", "old_text": "foo", "new_text": "bar"}\n```';
  const mdEditCall = extractFallbackToolCall(mdJsonDirect);
  assert.ok(mdEditCall);
  assert.equal(mdEditCall.tool, 'edit_file');
  assert.equal(mdEditCall.path, 'index.ts');
  assert.equal(mdEditCall.oldText, 'foo');
  assert.equal(mdEditCall.newText, 'bar');

  // 5. XML tag attributes
  const xmlTagAttr = '<tool name="read_file" file_path="package.json" />';
  const xmlCall = extractFallbackToolCall(xmlTagAttr);
  assert.ok(xmlCall);
  assert.equal(xmlCall.tool, 'read_file');
  assert.equal(xmlCall.path, 'package.json');

  // 6. Multiple tool calls via extractFallbackToolCalls
  const multi = '<tool name="read_file" path="a.txt" />\n<tool name="read_file" path="b.txt" />';
  const multiCalls = extractFallbackToolCalls(multi);
  assert.equal(multiCalls.length, 2);
  assert.equal(multiCalls[0].path, 'a.txt');
  assert.equal(multiCalls[1].path, 'b.txt');

  // 7. Aliases: execute_command, search_files, glob_files
  const bashCall = extractFallbackToolCall('```json\n{"name": "execute_command", "command": "npm test"}\n```');
  assert.equal(bashCall?.tool, 'exec');
  assert.equal(bashCall?.command, 'npm test');

  const searchCall = extractFallbackToolCall('```json\n{"name": "search_files", "query": "TODO"}\n```');
  assert.equal(searchCall?.tool, 'code_search');
  assert.equal(searchCall?.query, 'TODO');

  const globCall = extractFallbackToolCall('```json\n{"name": "glob_files", "pattern": "*.ts"}\n```');
  assert.equal(globCall?.tool, 'glob');
  assert.equal(globCall?.pattern, '*.ts');
});

test('RevealFilter suppresses Markdown JSON tool calls and DeepSeek DSML during streaming', () => {
  // Test Markdown JSON suppression
  let emittedMd = '';
  const filterMd = new RevealFilter((chunk) => {
    emittedMd += chunk;
  });

  const mdChunks = [
    'Berikut adalah eksekusi tool:\n',
    '```',
    'json\n',
    '{"name": "Read", "path": "README.md"}\n',
    '```\n',
    'Hasil pembacaan berkas.',
  ];
  for (const chunk of mdChunks) {
    filterMd.feed(chunk);
  }
  filterMd.end();

  assert.ok(emittedMd.includes('Berikut adalah eksekusi tool:'));
  assert.ok(emittedMd.includes('Hasil pembacaan berkas.'));
  assert.ok(!emittedMd.includes('{"name": "Read"'), 'Markdown JSON tool block must not leak to output');
  assert.ok(!emittedMd.includes('```json'), '```json tool fence must not leak to output');

  // Test DeepSeek DSML suppression
  let emittedDs = '';
  const filterDs = new RevealFilter((chunk) => {
    emittedDs += chunk;
  });

  const dsChunks = [
    'Menganalisis...\n',
    '<|DSML|calls>\n',
    '<|DSML|invoke name="read_file">\n',
    '<|DSML|parameter name="path" string="true">README.md</|DSML|parameter>\n',
    '</|DSML|invoke>\n',
    '</|DSML|calls>\n',
    'Analisis selesai.',
  ];
  for (const chunk of dsChunks) {
    filterDs.feed(chunk);
  }
  filterDs.end();

  assert.ok(emittedDs.includes('Menganalisis...'));
  assert.ok(emittedDs.includes('Analisis selesai.'));
  assert.ok(!emittedDs.includes('<|DSML|'), 'DeepSeek DSML tags must not leak to output');
  assert.ok(!emittedDs.includes('read_file'), 'DeepSeek DSML invoke must not leak to output');
});

test('Visual Spacing: Agent inserts single blank line between tool execution and assistant text response', async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-spacing-test-'));
  setWorkspaceRoot(tmpWs);
  writeFileSync(join(tmpWs, 'test.txt'), 'Hello world\n', 'utf-8');

  let callCount = 0;
  const mockProvider = {
    name: 'openrouter',
    isConfigured: true,
    model: 'nvidia/nemotron-3-ultra',
    setModel() {},
    async chat(messages: any[], options?: any) {
      callCount++;
      if (callCount === 1) {
        const responseText = '<tool>{"tool": "read_file", "path": "test.txt"}</tool>';
        for (const ch of responseText) {
          options?.onToken?.(ch);
        }
        return responseText;
      }
      const answer = 'Isi berkas adalah Hello world.';
      for (const ch of answer) {
        options?.onToken?.(ch);
      }
      return answer;
    },
  };

  try {
    const config = { ...DEFAULT_CONFIG, mode: 'beginner' as const };
    const ctx = new Context(config);
    const agent = new Agent(ctx, mockProvider as any, config, async () => true, tmpWs);

    const { result: res, writes: capturedWrites } = await captureStdout(() => agent.handleInstruction('baca test.txt'));
    assert.equal(res, 'Isi berkas adalah Hello world.');

    // Verify that right before assistant answer there is a blank line separator (\n)
    const textIndex = capturedWrites.findIndex((w) => w.includes('Isi berkas'));
    assert.ok(textIndex > 0, 'assistant text should be found in captured writes');
    assert.equal(capturedWrites[textIndex - 1], '\n', 'blank line separator must be written right before assistant answer text');
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('Visual Spacing: Sequential multiple tool calls remain compact with 1 line each', async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-spacing-multi-test-'));
  setWorkspaceRoot(tmpWs);
  writeFileSync(join(tmpWs, 'a.txt'), 'AAA\n', 'utf-8');
  writeFileSync(join(tmpWs, 'b.txt'), 'BBB\n', 'utf-8');

  let callCount = 0;
  const mockProvider = {
    name: 'openrouter',
    isConfigured: true,
    model: 'mock-model',
    setModel() {},
    async chat(messages: any[], options?: any) {
      callCount++;
      if (callCount === 1) {
        // First turn: model calls two tools in one turn
        const resp = '<tool>{"tool": "read_file", "path": "a.txt"}</tool>\n<tool>{"tool": "read_file", "path": "b.txt"}</tool>';
        for (const ch of resp) options?.onToken?.(ch);
        return resp;
      }
      const answer = 'Kedua file sudah dibaca.';
      for (const ch of answer) options?.onToken?.(ch);
      return answer;
    },
  };

  try {
    const config = { ...DEFAULT_CONFIG, mode: 'beginner' as const };
    const ctx = new Context(config);
    const agent = new Agent(ctx, mockProvider as any, config, async () => true, tmpWs);

    const { result: res, out } = await captureStdout(() => agent.handleInstruction('baca file a dan b'));
    assert.equal(res, 'Kedua file sudah dibaca.');

    const toolLogs = out.split('\n').map(stripAnsi).filter((l) => l.includes('📖 Read'));
    assert.equal(toolLogs.length, 2, 'both tools must be logged');
    assert.ok(toolLogs[0].includes('[1] 📖 Read a.txt'));
    assert.ok(toolLogs[1].includes('[2] 📖 Read b.txt'));
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('End-to-End: Agent intercepts DeepSeek DSML style, executes tool, and outputs clean answer', async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-dsml-test-'));
  setWorkspaceRoot(tmpWs);
  writeFileSync(join(tmpWs, 'README.md'), '# DeepSeek Test\n', 'utf-8');

  let callCount = 0;
  const mockProvider = {
    name: 'deepseek',
    isConfigured: true,
    model: 'deepseek-chat',
    setModel() {},
    async chat(messages: any[], options?: any) {
      callCount++;
      if (callCount === 1) {
        const responseText = '<|DSML|calls><|DSML|invoke name="read_file"><|DSML|parameter name="path" string="true">README.md</|DSML|parameter></|DSML|invoke></|DSML|calls>';
        for (const ch of responseText) options?.onToken?.(ch);
        return responseText;
      }
      return 'Berdasarkan README.md, ini adalah DeepSeek Test.';
    },
  };

  try {
    const config = { ...DEFAULT_CONFIG, mode: 'beginner' as const };
    const ctx = new Context(config);
    const agent = new Agent(ctx, mockProvider as any, config, async () => true, tmpWs);

    const { result: finalAnswer, out } = await captureStdout(() => agent.handleInstruction('baca README.md'));
    assert.equal(callCount, 2);
    assert.ok(finalAnswer.includes('DeepSeek Test'));
    assert.ok(!finalAnswer.includes('<|DSML|'));

    const plainLogs = stripAnsi(out);
    assert.ok(plainLogs.includes('📖 Read README.md'));
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('End-to-End: Agent intercepts Markdown JSON style, executes tool, and outputs clean answer', async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-mdjson-test-'));
  setWorkspaceRoot(tmpWs);
  writeFileSync(join(tmpWs, 'README.md'), '# Markdown JSON Test\n', 'utf-8');

  let callCount = 0;
  const mockProvider = {
    name: 'mock',
    isConfigured: true,
    model: 'mock-model',
    setModel() {},
    async chat(messages: any[], options?: any) {
      callCount++;
      if (callCount === 1) {
        const responseText = '```json\n{"name": "Read", "arguments": {"path": "README.md"}}\n```';
        for (const ch of responseText) options?.onToken?.(ch);
        return responseText;
      }
      return 'Berdasarkan README.md, ini adalah Markdown JSON Test.';
    },
  };

  try {
    const config = { ...DEFAULT_CONFIG, mode: 'beginner' as const };
    const ctx = new Context(config);
    const agent = new Agent(ctx, mockProvider as any, config, async () => true, tmpWs);

    const { result: finalAnswer, out } = await captureStdout(() => agent.handleInstruction('baca README.md'));
    assert.equal(callCount, 2);
    assert.ok(finalAnswer.includes('Markdown JSON Test'));
    assert.ok(!finalAnswer.includes('```json'));

    const plainLogs = stripAnsi(out);
    assert.ok(plainLogs.includes('📖 Read README.md'));
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// feedback.txt item 1 (v1.7.7 batch 2): multi-invoke DSML/XML tool calls
//
// Sebelumnya: hanya panggilan PERTAMA yang dieksekusi, dan sisa tag penutup
// (mis. `.github/workflows</parameter></invoke>`) bocor ke stream teks/thought.
// Penyebab: regex invoke mewajibkan prefix DSML di tag PEMBUKA dan PENUTUP
// sekaligus, dan tidak ada parser untuk bentuk XML telanjang `<invoke name=…>`.
// ─────────────────────────────────────────────────────────────────────────────

test('Item 1: multi-invoke DSML dengan tag penutup telanjang → SEMUA call di-parse, tanpa bocor', () => {
  const raw =
    'Menulis workflow.\n' +
    '<|DSML|invoke name="write_file"><|DSML|parameter name="path" string="true">.github/workflows/ci.yml</|DSML|parameter></|DSML|invoke>' +
    '<|DSML|invoke name="write_file"><|DSML|parameter name="path" string="true">.github/workflows/release.yml</parameter></invoke>';
  const { calls, malformedBlocks } = parseToolCalls(raw);
  assert.equal(malformedBlocks.length, 0, 'tidak boleh ada blok malformed');
  assert.equal(calls.length, 2, 'KEDUA blok invoke harus di-parse');
  assert.equal(calls[0].tool, 'write_file');
  assert.equal(calls[0].path, '.github/workflows/ci.yml');
  assert.equal(calls[1].tool, 'write_file');
  assert.equal(calls[1].path, '.github/workflows/release.yml');

  // Kebocoran yang dilaporkan feedback.txt: `.github/workflows</parameter></invoke>`
  const stripped = stripToolBlocks(raw);
  assert.ok(!stripped.includes('</parameter>'), 'tag penutup </parameter> tidak boleh tersisa');
  assert.ok(!stripped.includes('</invoke>'), 'tag penutup </invoke> tidak boleh tersisa');
  assert.ok(!stripped.includes('.github/workflows'), 'payload tool tidak boleh bocor sebagai teks');
  assert.ok(stripped.includes('Menulis workflow.'), 'teks biasa tetap dipertahankan');
});

test('Item 1: blok XML telanjang <invoke>/<parameter> (gaya Anthropic) di-parse, bukan malformed', () => {
  const raw =
    '<invoke name="write_file">\n' +
    '<parameter name="path" string="true">.github/workflows/ci.yml</parameter>\n' +
    '<parameter name="content" string="true">name: CI</parameter>\n' +
    '</invoke>\n' +
    '<invoke name="read_file">\n<parameter name="file_path" string="true">README.md</parameter>\n</invoke>';
  const { calls, malformedBlocks } = parseToolCalls(raw);
  assert.equal(malformedBlocks.length, 0, 'invoke telanjang adalah call valid, bukan malformed');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tool, 'write_file');
  assert.equal(calls[0].path, '.github/workflows/ci.yml');
  assert.equal(calls[0].content, 'name: CI');
  assert.equal(calls[1].tool, 'read_file');
  assert.equal(calls[1].path, 'README.md', 'file_path harus dinormalisasi menjadi path');
});

test('Item 1: parameter non-string pada invoke telanjang tetap di-parse sebagai JSON', () => {
  const raw = '<invoke name="read_file"><parameter name="offset">40</parameter><parameter name="limit">10</parameter></invoke>';
  const { calls } = parseToolCalls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].offset, 40);
  assert.equal(calls[0].limit, 10);
});

test('Item 1: RevealFilter menyembunyikan blok invoke telanjang saat streaming per karakter', () => {
  let emitted = '';
  const filter = new RevealFilter((chunk) => {
    emitted += chunk;
  });
  const raw =
    'Saya akan menulis workflow.\n' +
    '<invoke name="write_file"><parameter name="path" string="true">.github/workflows/ci.yml</parameter></invoke>\n' +
    'Selesai.';
  for (const ch of raw) filter.feed(ch);
  filter.end();

  assert.ok(emitted.includes('Saya akan menulis workflow.'));
  assert.ok(emitted.includes('Selesai.'));
  assert.ok(!emitted.includes('<invoke'), '<invoke> tidak boleh bocor ke stream');
  assert.ok(!emitted.includes('</parameter>'), '</parameter> tidak boleh bocor ke stream');
  assert.ok(!emitted.includes('.github/workflows'), 'payload parameter tidak boleh bocor');
});

test('Item 1: RevealFilter tidak menelan sisa teks setelah blok DSML dengan penutup telanjang', () => {
  let emitted = '';
  const filter = new RevealFilter((chunk) => {
    emitted += chunk;
  });
  const raw =
    'Menulis.\n' +
    '<|DSML|invoke name="write_file"><|DSML|parameter name="path" string="true">.github/workflows/ci.yml</parameter></invoke>\n' +
    'Selesai.';
  for (const ch of raw) filter.feed(ch);
  filter.end();

  assert.ok(emitted.includes('Selesai.'), 'teks setelah blok tidak boleh ikut tersembunyi');
  assert.ok(!emitted.includes('</invoke>'), 'tag penutup tidak boleh bocor');
  assert.ok(!emitted.includes('.github/workflows'), 'payload tidak boleh bocor');
});

test('Item 1: blok <function_calls> wrapper tidak bocor ke stream', () => {
  let emitted = '';
  const filter = new RevealFilter((chunk) => {
    emitted += chunk;
  });
  const raw =
    'Awal.\n<function_calls>\n<invoke name="read_file">\n<parameter name="path">a.txt</parameter>\n</invoke>\n</function_calls>\nAkhir.';
  for (const ch of raw) filter.feed(ch);
  filter.end();

  assert.ok(emitted.includes('Awal.') && emitted.includes('Akhir.'));
  assert.ok(!emitted.includes('function_calls'), 'wrapper tidak boleh bocor');
  assert.ok(!emitted.includes('<invoke'), 'invoke tidak boleh bocor');
  assert.ok(!emitted.includes('a.txt'), 'payload tidak boleh bocor');
});

test('End-to-End Item 1: Agent mengeksekusi DUA invoke campuran dalam satu giliran', async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-multi-invoke-'));
  setWorkspaceRoot(tmpWs);

  let callCount = 0;
  const mockProvider = {
    name: 'deepseek',
    isConfigured: true,
    model: 'deepseek-chat',
    setModel() {},
    async chat(messages: any[], options?: any) {
      callCount++;
      if (callCount === 1) {
        const responseText =
          'Menulis dua berkas workflow.\n' +
          '<|DSML|invoke name="write_file"><|DSML|parameter name="path" string="true">a.txt</|DSML|parameter><|DSML|parameter name="content" string="true">AAA</|DSML|parameter></|DSML|invoke>' +
          '<|DSML|invoke name="write_file"><|DSML|parameter name="path" string="true">b.txt</parameter><parameter name="content" string="true">BBB</parameter></invoke>';
        for (const ch of responseText) options?.onToken?.(ch);
        return responseText;
      }
      const toolMsgs = messages.filter((m: any) => m.role === 'tool');
      assert.equal(toolMsgs.length, 2, 'kedua hasil tool harus dikirim balik ke model');
      return 'Dua berkas selesai ditulis.';
    },
  };

  try {
    const config = { ...DEFAULT_CONFIG, mode: 'beginner' as const };
    const ctx = new Context(config);
    const agent = new Agent(ctx, mockProvider as any, config, async () => true, tmpWs);

    const { result: finalAnswer, out } = await captureStdout(() => agent.handleInstruction('tulis dua berkas'));

    assert.equal(callCount, 2);
    assert.equal(finalAnswer, 'Dua berkas selesai ditulis.');
    assert.ok(!finalAnswer.includes('<invoke'), 'jawaban akhir tidak boleh mengandung tag invoke');
    assert.equal(readFileSync(join(tmpWs, 'a.txt'), 'utf8'), 'AAA');
    assert.equal(readFileSync(join(tmpWs, 'b.txt'), 'utf8'), 'BBB');

    const plainLogs = stripAnsi(out);
    assert.ok(!plainLogs.includes('</parameter>'), 'tag penutup tidak boleh bocor ke log terminal');
    assert.ok(!plainLogs.includes('</invoke>'), 'tag invoke tidak boleh bocor ke log terminal');
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('End-to-End Item 1b: tool call di dalam <thought> tidak bocor ke reasoning box', async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-thought-leak-'));
  setWorkspaceRoot(tmpWs);
  writeFileSync(join(tmpWs, 'note.txt'), 'ISI-NOTE\n', 'utf-8');

  const previousReasoning = process.env.RUKO_SHOW_REASONING;
  process.env.RUKO_SHOW_REASONING = '1';

  let callCount = 0;
  const mockProvider = {
    name: 'deepseek',
    isConfigured: true,
    model: 'deepseek-reasoner',
    setModel() {},
    async chat(messages: any[], options?: any) {
      callCount++;
      if (callCount === 1) {
        const responseText =
          '<thought>Membaca note.txt.\n<|DSML|invoke name="read_file"><|DSML|parameter name="path" string="true">note.txt</|DSML|parameter></|DSML|invoke>\nAnalisis selesai</thought>\n' +
          '<|DSML|invoke name="read_file"><|DSML|parameter name="path" string="true">note.txt</|DSML|parameter></|DSML|invoke>';
        for (const ch of responseText) options?.onToken?.(ch);
        return responseText;
      }
      return 'Isi note adalah ISI-NOTE.';
    },
  };

  try {
    const config = { ...DEFAULT_CONFIG, mode: 'beginner' as const };
    const ctx = new Context(config);
    const agent = new Agent(ctx, mockProvider as any, config, async () => true, tmpWs);

    const { result: finalAnswer, out } = await captureStdout(() => agent.handleInstruction('baca note.txt'));
    assert.equal(finalAnswer, 'Isi note adalah ISI-NOTE.');

    const plainLogs = stripAnsi(out);
    assert.ok(plainLogs.includes('Reasoning'), 'reasoning box harus dirender (RUKO_SHOW_REASONING=1)');
    assert.ok(!plainLogs.includes('<|DSML|'), 'DSML tidak boleh bocor ke reasoning box');
    assert.ok(!plainLogs.includes('<invoke'), 'tag invoke tidak boleh bocor ke reasoning box');
    assert.ok(!plainLogs.includes('</parameter>'), 'tag penutup tidak boleh bocor ke reasoning box');
  } finally {
    if (previousReasoning === undefined) delete process.env.RUKO_SHOW_REASONING;
    else process.env.RUKO_SHOW_REASONING = previousReasoning;
    rmSync(tmpWs, { recursive: true, force: true });
  }
});
