import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatSkillsForPrompt,
  listSkills,
  parseSkillContent,
  readSkill,
  saveSkill,
} from '../core/skills.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
