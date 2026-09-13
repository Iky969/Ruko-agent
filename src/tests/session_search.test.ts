import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  exportSessionTrajectory,
  saveSession,
  searchSessions,
} from '../core/session.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextMessage } from '../types.js';

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
