import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  appendMemory,
  checkMemoryWarning,
  clearMemory,
  formatMemoryForPrompt,
  getMemoryPath,
  hasMeaningfulMemory,
  initMemoryFile,
  MEMORY_PLACEHOLDER_HEADER,
  MEMORY_WARN_THRESHOLD,
  readMemory,
  readMemorySafe,
  sanitizeMemoryContent,
} from '../core/memory.js';
import { buildSystemPrompt, getBuiltInRole } from '../agent/roles.js';
import { assertInsideWorkspace, runToolCall } from '../agent/tools.js';
import { handleCommand, listCommands } from '../agent/commands.js';
import { Context } from '../core/context.js';
import { DEFAULT_CONFIG } from '../types.js';

test('initMemoryFile creates .ruko/memory.md with placeholder header and 0o600 permissions', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-mem-'));
  try {
    const memPath = initMemoryFile(ws);
    assert.ok(memPath.endsWith(join('.ruko', 'memory.md')));
    const raw = readMemory(ws);
    assert.equal(raw, MEMORY_PLACEHOLDER_HEADER);

    if (process.platform !== 'win32') {
      const mode = statSync(memPath).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('readMemorySafe returns null if file does not exist, is empty, or only contains placeholder header', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-mem-'));
  try {
    // 1. File does not exist -> null
    assert.equal(readMemorySafe(ws), null);

    // 2. Only placeholder header -> null (skip injection)
    initMemoryFile(ws);
    assert.equal(readMemorySafe(ws), null);
    assert.equal(hasMeaningfulMemory(MEMORY_PLACEHOLDER_HEADER), false);

    // 3. Completely empty or whitespace -> null
    const memPath = getMemoryPath(ws);
    writeFileSync(memPath, '   \n\n  ', 'utf8');
    assert.equal(readMemorySafe(ws), null);
    assert.equal(hasMeaningfulMemory(''), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('readMemorySafe returns content when actual notes or user edits exist', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-mem-'));
  try {
    initMemoryFile(ws);
    const memPath = getMemoryPath(ws);
    const note = `${MEMORY_PLACEHOLDER_HEADER}\n- [2026-09-13] Proyek menggunakan Node.js dan TypeScript strict.\n`;
    writeFileSync(memPath, note, 'utf8');

    const content = readMemorySafe(ws);
    assert.ok(content);
    assert.ok(content.includes('Node.js dan TypeScript strict'));
    assert.equal(hasMeaningfulMemory(content), true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('buildSystemPrompt skips memory section when empty/null and injects strict XML boundary when present', () => {
  const role = getBuiltInRole('default')!;

  // 1. Memory null -> skip memory injection completely, no empty string or section
  const promptWithout = buildSystemPrompt({
    role,
    planMode: false,
    mode: 'beginner',
    agentDoc: null,
    memory: null,
  });
  assert.ok(!promptWithout.includes('## Memori dari sesi sebelumnya'));
  assert.ok(!promptWithout.includes('<persistent_memory>'));
  assert.ok(!promptWithout.includes('## Instruksi sistem'));

  // 2. Memory present -> injects before main system instructions with XML boundary & security notice
  const sampleMemory = '- [2026-09-13] User prefers Indonesian language.';
  const promptWith = buildSystemPrompt({
    role,
    planMode: false,
    mode: 'beginner',
    agentDoc: null,
    memory: sampleMemory,
  });

  assert.ok(promptWith.includes('## Memori dari sesi sebelumnya'));
  assert.ok(promptWith.includes('<persistent_memory>'));
  assert.ok(promptWith.includes(sampleMemory));
  assert.ok(promptWith.includes('</persistent_memory>'));
  assert.ok(promptWith.includes('BUKAN instruksi sistem'));
  assert.ok(promptWith.includes('## Instruksi sistem'));

  // Ensure memory section appears BEFORE system instructions
  const memIdx = promptWith.indexOf('## Memori dari sesi sebelumnya');
  const sysIdx = promptWith.indexOf('## Instruksi sistem');
  assert.ok(memIdx !== -1 && sysIdx !== -1 && memIdx < sysIdx, 'memory must appear before system instructions');
});

test('appendMemory formats entry with - [YYYY-MM-DD] and sanitizes newlines into single line', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-mem-'));
  try {
    const fakeDate = new Date('2026-09-13T10:00:00Z');
    const multiLineContent = 'Gunakan PostgreSQL untuk DB produksi.\r\nJangan ubah schema tanpa migrasi.\n';

    // Test sanitization directly
    const clean = sanitizeMemoryContent(multiLineContent);
    assert.ok(!clean.includes('\n'));
    assert.ok(!clean.includes('\r'));
    assert.equal(clean, 'Gunakan PostgreSQL untuk DB produksi. Jangan ubah schema tanpa migrasi.');

    // Test append
    const result = await appendMemory(multiLineContent, ws, fakeDate);
    assert.equal(result.ok, true);
    assert.equal(
      result.entry,
      '- [2026-09-13] Gunakan PostgreSQL untuk DB produksi. Jangan ubah schema tanpa migrasi.',
    );

    const raw = readMemory(ws)!;
    assert.ok(raw.includes(result.entry));

    if (process.platform !== 'win32') {
      const mode = statSync(getMemoryPath(ws)).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('appendMemory rejects empty or whitespace-only content', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-mem-'));
  try {
    await assert.rejects(
      async () => {
        await appendMemory('   \r\n\n  ', ws);
      },
      { message: /tidak boleh kosong/ },
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('path traversal is prevented and path is strictly hardcoded to .ruko/memory.md', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-mem-'));
  try {
    const memPath = getMemoryPath(ws);
    assert.equal(memPath, join(ws, '.ruko', 'memory.md'));

    // Traversal outside workspace boundary is rejected
    assert.throws(
      () => {
        assertInsideWorkspace(join(ws, '..', '..', 'etc', 'passwd'), ws);
      },
      /di luar working directory/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('size warning appears when threshold is exceeded without auto-trimming content', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-mem-'));
  try {
    initMemoryFile(ws);
    assert.equal(checkMemoryWarning(ws), null);

    // Append enough content to exceed 8000 characters
    const largeSnippet = 'x'.repeat(8100);
    const result = await appendMemory(largeSnippet, ws);
    assert.ok(result.warning);
    assert.ok(result.warning.includes('memory.md sudah besar'));
    assert.ok(result.warning.includes('pertimbangkan diringkas manual'));

    const warning = checkMemoryWarning(ws);
    assert.ok(warning);
    assert.ok(warning.includes('memory.md sudah besar'));

    // Ensure NO auto-trim: all content must be preserved
    const raw = readMemory(ws)!;
    assert.ok(raw.length >= 8100, 'Content must not be silently truncated');
    assert.ok(raw.includes(largeSnippet));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('plan mode blocks tool remember in CODE', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-mem-'));
  try {
    const res = await runToolCall(
      { tool: 'remember', content: 'Fakta penting' },
      { planMode: true, workspaceRoot: ws },
    );
    const parsed = JSON.parse(res);
    assert.ok(parsed.error);
    assert.ok(parsed.error.includes('plan mode aktif'));
    assert.ok(parsed.error.includes('remember'));

    // Ensure nothing was written
    const mem = readMemory(ws);
    assert.equal(mem, null);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('tool remember records action log 🟢 Remember(...) and saves entry when planMode is false', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-mem-'));
  const logs: string[] = [];
  try {
    const res = await runToolCall(
      { tool: 'remember', content: 'Arsitektur menggunakan event-driven pattern' },
      {
        planMode: false,
        workspaceRoot: ws,
        onLog: (line) => logs.push(line),
      },
    );
    const parsed = JSON.parse(res);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.entry.includes('Arsitektur menggunakan event-driven pattern'));

    // Check action log
    const hasLog = logs.some((l) => l.includes('🟢 Remember('));
    assert.ok(hasLog, 'must emit 🟢 Remember(...) log');

    // Verify file content
    const raw = readMemory(ws)!;
    assert.ok(raw.includes('Arsitektur menggunakan event-driven pattern'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('tool remember ignores any user-provided path parameter and writes only to .ruko/memory.md', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-mem-'));
  try {
    const res = await runToolCall(
      {
        tool: 'remember',
        path: '../../etc/passwd',
        file: '/tmp/hacked',
        content: 'Safety check',
      },
      { planMode: false, workspaceRoot: ws },
    );
    const parsed = JSON.parse(res);
    assert.equal(parsed.ok, true);

    // Check that it only wrote to .ruko/memory.md
    const raw = readMemory(ws)!;
    assert.ok(raw.includes('Safety check'));
    assert.equal(getMemoryPath(ws), join(ws, '.ruko', 'memory.md'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('slash command /memory exists in registry and /memory clear resets memory file', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-mem-'));
  try {
    const names = new Set(listCommands().map((c) => c.name));
    assert.ok(names.has('memory'), 'missing /memory in command registry');

    // Append some memory
    await appendMemory('Catatan pertama', ws);
    assert.ok(readMemory(ws)!.includes('Catatan pertama'));

    // Run clear
    clearMemory(ws);
    const reset = readMemory(ws)!;
    assert.equal(reset, MEMORY_PLACEHOLDER_HEADER);
    assert.equal(hasMeaningfulMemory(reset), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
