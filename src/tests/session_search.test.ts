import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  exportSessionTrajectory,
  saveSession,
  searchSessions,
} from '../core/session.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextMessage, DEFAULT_CONFIG } from '../types.js';
import { runToolCall, setWorkspaceRoot } from '../agent/tools.js';
import { handleCommand, listCommands } from '../agent/commands.js';
import { Context } from '../core/context.js';

test('searchSessions finds keyword matches across session messages', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ruko-sess-search-'));
  try {
    const msgs: ContextMessage[] = [
      { role: 'user', content: 'Bagaimana cara setup database PostgreSQL?', timestamp: new Date().toISOString() },
      { role: 'assistant', content: 'Gunakan docker run dengan image postgres:alpine.', timestamp: new Date().toISOString() },
    ];
    saveSession(msgs, tmpDir, 'sess-1');

    const msgs2: ContextMessage[] = [
      { role: 'user', content: 'Tolong buatkan endpoint Express', timestamp: new Date().toISOString() },
      { role: 'assistant', content: 'Gunakan express.Router() untuk modularitas.', timestamp: new Date().toISOString() },
    ];
    saveSession(msgs2, tmpDir, 'sess-2');

    const foundPostgres = searchSessions('postgres', tmpDir);
    assert.equal(foundPostgres.length, 2);
    assert.equal(foundPostgres[0].sessionId, 'sess-1');
    assert.ok(foundPostgres[0].snippet.toLowerCase().includes('postgres'));

    const foundExpress = searchSessions('express', tmpDir);
    assert.equal(foundExpress.length, 2);
    assert.equal(foundExpress[0].sessionId, 'sess-2');

    const notFound = searchSessions('nonexistent_technology_xyz', tmpDir);
    assert.equal(notFound.length, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('exportSessionTrajectory exports to jsonl and markdown', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ruko-export-test-'));
  try {
    const msgs: ContextMessage[] = [
      { role: 'user', content: 'Buat file test.ts', timestamp: '2026-09-13T00:00:00Z' },
      { role: 'assistant', content: 'File dibuat.', timestamp: '2026-09-13T00:00:01Z' },
    ];

    const jsonlRes = exportSessionTrajectory(msgs, 'jsonl', tmpDir, 'test-export');
    assert.equal(jsonlRes.entryCount, 2);
    assert.ok(jsonlRes.filePath.endsWith('.jsonl'));
    const jsonlContent = readFileSync(jsonlRes.filePath, 'utf8');
    const lines = jsonlContent.trim().split('\n');
    assert.equal(lines.length, 2);
    const parsed1 = JSON.parse(lines[0]);
    assert.equal(parsed1.step, 1);
    assert.equal(parsed1.role, 'user');

    const mdRes = exportSessionTrajectory(msgs, 'md', tmpDir, 'test-export-md');
    assert.equal(mdRes.entryCount, 2);
    assert.ok(mdRes.filePath.endsWith('.md'));
    const mdContent = readFileSync(mdRes.filePath, 'utf8');
    assert.ok(mdContent.includes('# Trajectory Export: test-export-md'));
    assert.ok(mdContent.includes('### Step 1 — [USER]'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('searchSessions respects limit, caps snippet <= 150 chars, and handles empty/corrupt files', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ruko-sess-advanced-'));
  try {
    // Sesi 1: Pesan panjang > 200 karakter
    const longMsg = 'Alpha '.repeat(40) + 'KATA_KUNCI_UNIK ' + 'Omega '.repeat(40);
    saveSession(
      [
        { role: 'user', content: longMsg, timestamp: '2026-09-13T10:00:00Z' },
        { role: 'assistant', content: 'Jawaban kedua tentang KATA_KUNCI_UNIK juga.', timestamp: '2026-09-13T10:01:00Z' },
      ],
      tmpDir,
      'sess-long',
    );

    // Sesi 2: Sesi kosong (messages kosong)
    writeFileSync(
      join(tmpDir, 'sess-empty.json'),
      JSON.stringify({ id: 'sess-empty', title: 'Empty', updatedAt: '2026-09-13T09:00:00Z', messageCount: 0, messages: [] }),
      'utf8',
    );

    // Sesi 3: File rusak / corrupt JSON
    writeFileSync(join(tmpDir, 'sess-corrupt.json'), 'not valid json {{{', 'utf8');

    // Sesi 4: File kosong 0-byte
    writeFileSync(join(tmpDir, 'sess-zero.json'), '', 'utf8');

    // Uji batas limit 1
    const limit1 = searchSessions('KATA_KUNCI_UNIK', tmpDir, 1);
    assert.equal(limit1.length, 1, 'limit 1 harus dihormati');
    assert.equal(limit1[0].sessionId, 'sess-long');
    assert.ok(limit1[0].snippet.length <= 150, `snippet length (${limit1[0].snippet.length}) harus <= 150`);
    assert.equal(limit1[0].messageCount, 2);
    assert.ok(limit1[0].timestamp);

    // Uji kata kunci yang tidak ada sama sekali
    const none = searchSessions('TIDAK_ADA_SEKALI_PUN_XYZ', tmpDir);
    assert.equal(none.length, 0);

    // Uji query kosong
    assert.equal(searchSessions('', tmpDir).length, 0);
    assert.equal(searchSessions('   ', tmpDir).length, 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('tool search_sessions and slash command /search work end-to-end', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-tool-search-'));
  const sessionsDir = join(ws, '.ruko', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  setWorkspaceRoot(ws);

  try {
    saveSession(
      [
        { role: 'user', content: 'Bagaimana arsitektur Kubernetes microservice?', timestamp: '2026-09-13T12:00:00Z' },
        { role: 'assistant', content: 'Gunakan Ingress controller dan deployment pod.', timestamp: '2026-09-13T12:01:00Z' },
      ],
      sessionsDir,
      'k8s-session',
    );

    // 1. Eksekusi tool search_sessions
    const toolResStr = await runToolCall(
      { tool: 'search_sessions', query: 'kubernetes', limit: 3 },
      { workspaceRoot: ws },
    );
    const toolRes = JSON.parse(toolResStr);
    assert.equal(toolRes.ok, true);
    assert.equal(toolRes.count, 1);
    assert.equal(toolRes.results[0].session_id, 'k8s-session');
    assert.equal(toolRes.results[0].message_count, 2);
    assert.ok(toolRes.results[0].snippet.toLowerCase().includes('kubernetes'));

    // 2. Verifikasi slash command /search terdaftar dan berjalan
    const commands = listCommands();
    assert.ok(commands.some((c) => c.name === 'search'), '/search harus terdaftar di command list');

    let output = '';
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      output += args.join(' ') + '\n';
    };

    const ctx = new Context({ ...DEFAULT_CONFIG });
    const mockEnv: any = {
      ctx,
      config: DEFAULT_CONFIG,
      llm: { name: 'mock', isConfigured: true, model: 'mock', setModel: () => {}, chat: async () => '' },
      confirm: async () => true,
      handle: { stop: () => {}, getSessionId: () => null, setSessionId: () => {} },
    };

    try {
      await handleCommand('/search kubernetes', mockEnv);
      assert.ok(output.includes('k8s-session'), 'output /search harus menampilkan id sesi');
      assert.ok(output.includes('/resume k8s-session'), 'output /search harus menyertakan petunjuk resume');
    } finally {
      console.log = origLog;
    }
  } finally {
    setWorkspaceRoot(null);
    rmSync(ws, { recursive: true, force: true });
  }
});
