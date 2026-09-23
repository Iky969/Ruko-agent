import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseToolCalls, stripToolBlocks } from '../agent/tools.js';

describe('Tugas 6: Generic XML Self-Closing & Malformed Non-ASCII Tag Handling', () => {
  it('parses self-closing <tool name="..." path="..." /> with XML attributes into valid ToolCall', () => {
    const input = '<tool name="read_file" path="package.json" />';
    const res = parseToolCalls(input);
    assert.equal(res.calls.length, 1);
    assert.equal(res.calls[0].tool, 'read_file');
    assert.equal(res.calls[0].path, 'package.json');
    assert.equal(res.malformedBlocks.length, 0);
  });

  it('normalizes tool alias and alternative parameter names from self-closing tags', () => {
    const input = '<tool name="ReadFile" file_path="src/index.ts" />';
    const res = parseToolCalls(input);
    assert.equal(res.calls.length, 1);
    assert.equal(res.calls[0].tool, 'read_file');
    assert.equal(res.calls[0].path, 'src/index.ts');
  });

  it('parses self-closing <tool tool="..." command="..." /> for exec', () => {
    const input = '<tool tool="bash" command="npm test" />';
    const res = parseToolCalls(input);
    assert.equal(res.calls.length, 1);
    assert.equal(res.calls[0].tool, 'exec');
    assert.equal(res.calls[0].command, 'npm test');
  });

  it('malformedBlocks contains raw tag and NEVER contains empty string "" on JSON parse failure', () => {
    // Malformed JSON inside <tool>
    const input = '<tool name="broken">{invalid json here</tool>';
    const res = parseToolCalls(input);
    assert.equal(res.calls.length, 0);
    assert.equal(res.malformedBlocks.length, 1);
    assert.notEqual(res.malformedBlocks[0], '');
    assert.ok(res.malformedBlocks[0].includes('invalid json here'));

    // Empty body with invalid attributes
    const inputEmpty = '<tool></tool>';
    const resEmpty = parseToolCalls(inputEmpty);
    for (const mb of resEmpty.malformedBlocks) {
      assert.notEqual(mb, '', 'malformedBlocks must never contain an empty string');
    }
  });

  it('captures corrupted non-ASCII/CJK tag name (<認 name=... />) as malformed tool call', () => {
    const input = '<認 name=code_search tool="code_search" query="test" />';
    const res = parseToolCalls(input);
    assert.equal(res.calls.length, 0);
    assert.equal(res.malformedBlocks.length, 1);
    assert.ok(res.malformedBlocks[0].includes('認'));
  });

  it('stripToolBlocks strips self-closing <tool ... /> tags from terminal output', () => {
    const input = 'Reading config:\n<tool name="read_file" path="package.json" />\nDone reading.';
    const stripped = stripToolBlocks(input);
    assert.ok(!stripped.includes('<tool'), 'Must strip <tool ... />');
    assert.ok(!stripped.includes('package.json'), 'Must strip tool attributes');
    assert.ok(stripped.includes('Reading config:'));
    assert.ok(stripped.includes('Done reading.'));
  });

  it('stripToolBlocks strips corrupted non-ASCII tags (<認 ... />)', () => {
    const input = 'Searching files:\n<認 name=code_search query="auth" />\nSearch finished.';
    const stripped = stripToolBlocks(input);
    assert.ok(!stripped.includes('<認'), 'Must strip corrupted non-ASCII tag');
    assert.ok(!stripped.includes('code_search'));
    assert.ok(stripped.includes('Searching files:'));
    assert.ok(stripped.includes('Search finished.'));
  });
});
