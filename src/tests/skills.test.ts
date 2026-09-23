import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultSkillsDir,
  deleteSkill,
  formatSkillsForPrompt,
  initDefaultSkills,
  listSkills,
  loadSkillsContext,
  parseSkillContent,
  readSkill,
  saveSkill,
  scanSkills,
} from '../core/skills.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runToolCall, setWorkspaceRoot } from '../agent/tools.js';
import { DEFAULT_CONFIG } from '../types.js';

test('parseSkillContent parses YAML frontmatter and body', () => {
  const raw = `---
name: code-reviewer
description: Professional code review workflow
---
# Instructions
1. Inspect diffs
2. Verify security`;

  const parsed = parseSkillContent(raw, 'fallback');
  assert.equal(parsed.name, 'code-reviewer');
  assert.equal(parsed.description, 'Professional code review workflow');
  assert.ok(parsed.instructions.includes('Inspect diffs'));
});

test('saveSkill, listSkills, and readSkill work in temporary workspace', () => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-skills-test-'));
  try {
    assert.deepEqual(listSkills(tmpWs), []);

    const saved = saveSkill(
      'git-workflow',
      'Git release and branch workflow',
      'Follow gitflow steps carefully.',
      tmpWs,
    );
    assert.equal(saved.name, 'git-workflow');

    const list = listSkills(tmpWs);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'git-workflow');

    const read = readSkill('git-workflow', tmpWs);
    assert.ok(read);
    assert.equal(read.description, 'Git release and branch workflow');
    assert.equal(read.instructions, 'Follow gitflow steps carefully.');

    const promptXml = formatSkillsForPrompt(list);
    assert.ok(promptXml.includes('<available_skills>'));
    assert.ok(promptXml.includes('- **git-workflow**: Git release and branch workflow'));
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('deleteSkill deletes direct and nested skill files', () => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-del-skill-'));
  try {
    saveSkill('test-direct', 'Desc 1', 'Step 1\nStep 2', tmpWs);
    assert.ok(readSkill('test-direct', tmpWs));

    const deleted = deleteSkill('test-direct', tmpWs);
    assert.equal(deleted, true);
    assert.equal(readSkill('test-direct', tmpWs), null);

    // Non-existent returns false
    assert.equal(deleteSkill('nonexistent-skill', tmpWs), false);
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('tool delete_skill requires approval gate, respects rejection, and succeeds on confirmation', async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-tool-del-'));
  setWorkspaceRoot(tmpWs);
  try {
    saveSkill('deploy-flow', 'Production deploy workflow', '1. Build assets\n2. Run migrations\n3. Restart PM2', tmpWs);
    assert.ok(readSkill('deploy-flow', tmpWs));

    // 1. Error bila skill tidak ada
    const notFoundRes = await runToolCall(
      { tool: 'delete_skill', name: 'ghost-skill' },
      { workspaceRoot: tmpWs },
    );
    assert.ok(JSON.parse(notFoundRes).error.includes('tidak ditemukan'));

    // 2. Error bila name kosong
    const emptyNameRes = await runToolCall(
      { tool: 'delete_skill', name: '' },
      { workspaceRoot: tmpWs },
    );
    assert.ok(JSON.parse(emptyNameRes).error.includes('missing "name" field'));

    // 3. Diblokir di Plan Mode
    const planRes = await runToolCall(
      { tool: 'delete_skill', name: 'deploy-flow' },
      { workspaceRoot: tmpWs, planMode: true },
    );
    assert.ok(planRes.includes('plan mode aktif'));
    assert.ok(readSkill('deploy-flow', tmpWs), 'skill tidak boleh terhapus saat plan mode');

    // 4. Approval gate: penolakan konfirmasi oleh user (confirm -> false)
    let promptTitle = '';
    let promptDesc = '';
    const rejectConfirm = async (action: string, reason: string): Promise<boolean> => {
      promptTitle = action;
      promptDesc = reason;
      return false; // User menolak
    };

    const rejectedRes = await runToolCall(
      { tool: 'delete_skill', name: 'deploy-flow' },
      {
        workspaceRoot: tmpWs,
        config: { ...DEFAULT_CONFIG, approvalEnabled: true },
        confirm: rejectConfirm,
      },
    );
    assert.ok(rejectedRes.includes('Persetujuan ditolak'));
    assert.ok(promptTitle.includes('delete_skill deploy-flow'));
    assert.ok(promptDesc.includes('Build assets'), 'preview isi skill harus ditampilkan sebelum konfirmasi');
    assert.ok(readSkill('deploy-flow', tmpWs), 'skill harus TETAP ada setelah persetujuan ditolak');

    // 5. Approval gate: persetujuan berhasil (confirm -> true)
    const acceptConfirm = async (): Promise<boolean> => true;
    const acceptedRes = await runToolCall(
      { tool: 'delete_skill', name: 'deploy-flow' },
      {
        workspaceRoot: tmpWs,
        config: { ...DEFAULT_CONFIG, approvalEnabled: true },
        confirm: acceptConfirm,
      },
    );
    const parsedAccepted = JSON.parse(acceptedRes);
    assert.equal(parsedAccepted.ok, true);
    assert.equal(readSkill('deploy-flow', tmpWs), null, 'skill harus berhasil terhapus setelah dikonfirmasi');

    // 6. Verifikasi save_skill mendukung argumen "content" sebagai alias "instructions"
    const saveRes = await runToolCall(
      { tool: 'save_skill', name: 'aliased-skill', description: 'Aliased', content: 'Langkah instruksi' },
      { workspaceRoot: tmpWs },
    );
    assert.ok(JSON.parse(saveRes).ok);
    const savedSkill = readSkill('aliased-skill', tmpWs);
    assert.ok(savedSkill);
    assert.equal(savedSkill.instructions, 'Langkah instruksi');
  } finally {
    setWorkspaceRoot(null);
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('initDefaultSkills creates .ruko/skills with anti-slop and anti-hallucination guardrails', () => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-skills-init-'));
  try {
    initDefaultSkills(tmpWs);

    const slop = readSkill('anti-slop', tmpWs);
    assert.ok(slop, 'anti-slop.md must be initialized');
    assert.ok(slop.instructions.includes('basa-basi'));
    assert.ok(slop.instructions.includes('to-the-point'));
    assert.ok(slop.instructions.includes('over-commenting'));
    assert.ok(slop.instructions.includes('boilerplate'));

    const hallucination = readSkill('anti-hallucination', tmpWs);
    assert.ok(hallucination, 'anti-hallucination.md must be initialized');
    assert.ok(hallucination.instructions.includes('list_dir'));
    assert.ok(hallucination.instructions.includes('read_file'));
    assert.ok(hallucination.instructions.includes('faktual'));
    assert.ok(hallucination.instructions.includes('API'));

    const skills = listSkills(tmpWs);
    assert.equal(skills.length, 2);
    assert.equal(skills[0].name, 'anti-hallucination');
    assert.equal(skills[1].name, 'anti-slop');
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('scanSkills scans both local and global directories with local override', () => {
  const localWs = mkdtempSync(join(tmpdir(), 'ruko-skills-local-'));
  const globalWs = mkdtempSync(join(tmpdir(), 'ruko-skills-global-'));
  try {
    saveSkill('global-only', 'Global skill description', 'Global instructions', globalWs);
    saveSkill('shared-skill', 'Global shared description', 'Old global instructions', globalWs);

    saveSkill('local-only', 'Local skill description', 'Local instructions', localWs);
    saveSkill('shared-skill', 'Local shared description', 'Overridden local instructions', localWs);

    const scanned = scanSkills(localWs, { includeGlobal: true, globalDir: defaultSkillsDir(globalWs) });

    const names = scanned.map((s) => s.name);
    assert.deepEqual(names, ['global-only', 'local-only', 'shared-skill']);

    const shared = scanned.find((s) => s.name === 'shared-skill');
    assert.ok(shared);
    assert.equal(shared.description, 'Local shared description');
    assert.equal(shared.instructions, 'Overridden local instructions');
  } finally {
    rmSync(localWs, { recursive: true, force: true });
    rmSync(globalWs, { recursive: true, force: true });
  }
});

test('loadSkillsContext merges skill instructions and respects token context limit', () => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-skills-ctx-'));
  try {
    saveSkill('skill-a', 'Skill A', 'Step 1\n\n\n\nStep 2', tmpWs);
    saveSkill('skill-b', 'Skill B', 'Detailed step B instruction', tmpWs);

    const context = loadSkillsContext(tmpWs, 4000);
    assert.ok(context.includes('<active_skills_instructions>'));
    assert.ok(context.includes('### Skill: skill-a'));
    assert.ok(context.includes('Step 1\n\nStep 2'), 'redundant blank lines collapsed');
    assert.ok(context.includes('### Skill: skill-b'));
    assert.ok(context.includes('Detailed step B instruction'));

    // Test context truncation when maxChars budget is tight
    const tightContext = loadSkillsContext(tmpWs, 60);
    assert.ok(tightContext.includes('### Skill: skill-a'));
    assert.ok(tightContext.includes('efisiensi context') || tightContext.includes('omitted'));
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('slash command /skills lists active skills without throwing', async () => {
  const { handleCommand } = await import('../agent/commands.js');
  const { Context } = await import('../core/context.js');

  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-slash-skills-'));
  try {
    initDefaultSkills(tmpWs);
    setWorkspaceRoot(tmpWs);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));

    try {
      const ctx = new Context(DEFAULT_CONFIG);
      await handleCommand('/skills', {
        ctx,
        config: DEFAULT_CONFIG,
        llm: {} as any,
        confirm: async () => true,
        updateConfig: () => {},
        handle: { stop: () => {}, getSessionId: () => null, setSessionId: () => {} },
      });

      const output = logs.join('\n');
      assert.ok(output.includes('Skills Aktif'));
      assert.ok(output.includes('anti-slop'));
      assert.ok(output.includes('anti-hallucination'));
    } finally {
      console.log = origLog;
      setWorkspaceRoot(null);
    }
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

