/**
 * WP-02 (v2.1.0) — Persistence Hardening: Scope .ruko/**
 *
 * DoD: "pembacaan .ruko/history ditolak oleh assertNotSensitivePath."
 *
 * Seluruh subjalur `.ruko/**` (riwayat perintah, sesi, ekspor, audit guardian,
 * memory) default-deny; allowlist hanya `.ruko/skills/**` dan `.ruko/plan.json`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHistory } from '../core/history.js';
import { assertNotSensitivePath, isSensitivePath, runToolCall } from '../agent/tools.js';

function inTempWorkspace<T>(fn: (ws: string) => Promise<T> | T): Promise<T> {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-persist-'));
  return Promise.resolve(fn(ws)).finally(() => {
    rmSync(ws, { recursive: true, force: true });
  });
}

test('WP-02: seluruh subjalur .ruko/** ditolak, allowlist skills & plan.json lolos', () => {
  return inTempWorkspace((ws) => {
    const denied = [
      '.ruko/history',
      '.ruko/sessions/ses_1.json',
      '.ruko/exports/session.jsonl',
      '.ruko/guardian-audit.log',
      '.ruko/memory.md',
      '.ruko/config.json',
      '.ruko/trusted',
      '.ruko/undo/123-1.content',
    ];
    for (const p of denied) {
      assert.equal(isSensitivePath(p, ws), true, `${p} harus dianggap sensitif`);
      assert.throws(() => assertNotSensitivePath(p, ws), /ditolak/);
    }

    const allowed = [
      '.ruko/skills/anti-slop.md',
      '.ruko/skills/nested/SKILL.md',
      '.ruko/skills',
      '.ruko/plan.json',
      'src/index.ts',
      'package.json',
    ];
    for (const p of allowed) {
      assert.equal(isSensitivePath(p, ws), false, `${p} harus lolos allowlist`);
      assert.doesNotThrow(() => assertNotSensitivePath(p, ws));
    }
  });
});

test('WP-02: appendHistory meredaksi kredensial sebelum menulis .ruko/history', () => {
  return inTempWorkspace((ws) => {
    const historyPath = join(ws, '.ruko', 'history');
    appendHistory('export API_KEY=sk-live-1234567890', historyPath);
    appendHistory('git status', historyPath);
    appendHistory('curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123" https://x', historyPath);

    const content = readFileSync(historyPath, 'utf8');
    assert.equal(content.includes('sk-live-1234567890'), false, 'nilai kredensial tidak boleh tersimpan');
    assert.equal(content.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'), false, 'token bearer tidak boleh tersimpan');
    assert.match(content, /API_KEY=\[REDACTED\]/);
    assert.match(content, /git status/);
  });
});

test('WP-02: read_file menolak .ruko/history & .ruko/sessions/*.json, tetapi skill tetap terbaca', async () => {
  await inTempWorkspace(async (ws) => {
    mkdirSync(join(ws, '.ruko', 'sessions'), { recursive: true });
    mkdirSync(join(ws, '.ruko', 'skills'), { recursive: true });
    writeFileSync(join(ws, '.ruko', 'history'), 'export API_KEY=sk-super-rahasia\n', 'utf8');
    writeFileSync(join(ws, '.ruko', 'sessions', 'ses_1.json'), '{"secret":"x"}\n', 'utf8');
    writeFileSync(
      join(ws, '.ruko', 'skills', 'anti-slop.md'),
      '---\nname: anti-slop\ndescription: guardrail\n---\n# Anti-Slop\n',
      'utf8',
    );

    const historyResult = await runToolCall(
      { tool: 'read_file', path: '.ruko/history' },
      { workspaceRoot: ws, planMode: false },
    );
    assert.match(historyResult, /ditolak/i, 'pembacaan .ruko/history harus ditolak');
    assert.equal(historyResult.includes('sk-super-rahasia'), false, 'isi riwayat tidak boleh bocor');

    const sessionResult = await runToolCall(
      { tool: 'read_file', path: '.ruko/sessions/ses_1.json' },
      { workspaceRoot: ws, planMode: false },
    );
    assert.match(sessionResult, /ditolak/i, 'pembacaan sesi harus ditolak');

    const skillResult = await runToolCall(
      { tool: 'read_file', path: '.ruko/skills/anti-slop.md' },
      { workspaceRoot: ws, planMode: false },
    );
    assert.match(skillResult, /Anti-Slop/, 'skill pada allowlist tetap dapat dibaca');
  });
});
