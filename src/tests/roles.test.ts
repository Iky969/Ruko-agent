import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  allRoles,
  buildSystemPrompt,
  CORE_IDENTITY,
  getBuiltInRole,
  loadCustomRoles,
  parseRoleFile,
  planModeAddendum,
  TOOL_RULES,
} from '../agent/roles.js';

test('built-in roles cover the feedback set (§4)', () => {
  const names = allRoles('/nonexistent-ruko-test', '/nonexistent-ruko-test').map((r) => r.name);
  for (const want of ['default', 'reviewer', 'teacher', 'minimal']) {
    assert.ok(names.includes(want), `missing role ${want}`);
  }
});

test('reviewer role is read-only by prompt contract', () => {
  const r = getBuiltInRole('reviewer')!;
  assert.ok(r.prompt.includes('READ-ONLY'));
});

test('parseRoleFile reads frontmatter name/description', () => {
  const r = parseRoleFile('---\nname: devin\ndescription: Senior engineer\n---\nDo the work.', 'fallback');
  assert.equal(r.name, 'devin');
  assert.equal(r.description, 'Senior engineer');
  assert.equal(r.prompt, 'Do the work.');
});

test('parseRoleFile without frontmatter uses fallback name and whole body', () => {
  const r = parseRoleFile('just instructions here', 'plain');
  assert.equal(r.name, 'plain');
  assert.equal(r.prompt, 'just instructions here');
});

test('loadCustomRoles reads .md files from a dir (project-level roles §4)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-roles-'));
  writeFileSync(join(dir, 'ekspert.md'), '---\nname: ekspert\ndescription: test\n---\nBe expert.', 'utf8');
  writeFileSync(join(dir, 'skip.txt'), 'not a role', 'utf8');
  const roles = loadCustomRoles(dir);
  assert.equal(roles.length, 1);
  assert.equal(roles[0].name, 'ekspert');
  rmSync(dir, { recursive: true, force: true });
});

test('system prompt keeps cache-friendly fixed layer order (§5.30)', () => {
  const doc = '# Project\nUse pnpm.';
  const p1 = buildSystemPrompt({ role: getBuiltInRole('teacher')!, planMode: false, mode: 'beginner', agentDoc: doc });
  const p2 = buildSystemPrompt({ role: getBuiltInRole('teacher')!, planMode: false, mode: 'beginner', agentDoc: doc });
  assert.equal(p1, p2, 'deterministic for prompt caching');
  assert.ok(p1.indexOf(CORE_IDENTITY) < p1.indexOf(TOOL_RULES), 'identity before tool rules');
  assert.ok(p1.indexOf(TOOL_RULES) < p1.indexOf('patient teacher'), 'tools before role');
  assert.ok(p1.indexOf('patient teacher') < p1.indexOf('Use pnpm'), 'role before AGENT.md');
  assert.ok(!p1.includes('ACTIVE MODE'), 'no plan addendum when off');
});

test('plan mode and beginner addenda append last (§4d/§7)', () => {
  const p = buildSystemPrompt({ role: getBuiltInRole('default')!, planMode: true, mode: 'beginner', agentDoc: null });
  assert.ok(p.includes('ACTIVE MODE — PLAN'));
  assert.ok(p.includes('USER MODE — BEGINNER'));
  assert.ok(p.indexOf(planModeAddendum()) < p.indexOf('USER MODE — BEGINNER'));
});
