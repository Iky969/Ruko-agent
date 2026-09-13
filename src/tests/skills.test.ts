import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deleteSkill,
  formatSkillsForPrompt,
  listSkills,
  parseSkillContent,
  readSkill,
  saveSkill,
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
