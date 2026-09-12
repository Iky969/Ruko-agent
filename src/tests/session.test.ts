import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inferTitle, listSessions, loadSession, saveSession } from '../core/session.js';
import { ContextMessage } from '../types.js';

test('inferTitle extracts clean first line from user message', () => {
  const now = new Date().toISOString();
  assert.equal(inferTitle([]), 'untitled');
  const msgs: ContextMessage[] = [
    { role: 'assistant', content: 'Halo', timestamp: now },
    { role: 'user', content: 'Perbaiki bug login di auth.ts\nDetail tambahan...', timestamp: now },
  ];
  assert.equal(inferTitle(msgs), 'Perbaiki bug login di auth.ts');
});

test('saveSession writes session file with 0600 mode and roundtrips with loadSession (M4)', () => {
  const now = new Date().toISOString();
  const dir = mkdtempSync(join(tmpdir(), 'ruko-session-test-'));
  const msgs: ContextMessage[] = [
    { role: 'user', content: 'Halo Ruko', timestamp: now },
    { role: 'assistant', content: 'Halo! Ada yang bisa dibantu?', timestamp: now },
  ];
  const s = saveSession(msgs, dir, 'test-sess-1');
  assert.equal(s.id, 'test-sess-1');
  assert.equal(s.title, 'Halo Ruko');
  assert.equal(s.messageCount, 2);

  const loaded = loadSession('test-sess-1', dir);
  assert.ok(loaded);
  assert.equal(loaded?.title, 'Halo Ruko');
  assert.equal(loaded?.messages.length, 2);

  if (process.platform !== 'win32') {
    const file = join(dir, 'test-sess-1.json');
    const st = statSync(file);
    assert.equal(st.mode & 0o777, 0o600, 'session file must have 0600 owner-only permissions');
  }

  const list = listSessions(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'test-sess-1');

  rmSync(dir, { recursive: true, force: true });
});
