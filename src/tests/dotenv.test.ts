import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnv, loadDotenv } from '../core/dotenv.js';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('parseEnv parses basic KEY=value lines and comments', () => {
  const content = `
# Comment line
OPENAI_API_KEY=sk-test-12345
OPENAI_BASE_URL=https://api.openai.com/v1 # inline comment
EMPTY_KEY=
SPACED_VALUE = hello world
  `;
  const res = parseEnv(content);
  assert.equal(res.OPENAI_API_KEY, 'sk-test-12345');
  assert.equal(res.OPENAI_BASE_URL, 'https://api.openai.com/v1');
  assert.equal(res.EMPTY_KEY, '');
  assert.equal(res.SPACED_VALUE, 'hello world');
});

test('parseEnv handles double and single quotes with escapes', () => {
  const content = `
SINGLE='simple string'
DOUBLE="line with \\n newline and \\"quotes\\""
MULTILINE="first line
second line"
  `;
  const res = parseEnv(content);
  assert.equal(res.SINGLE, 'simple string');
  assert.equal(res.DOUBLE, 'line with \n newline and "quotes"');
  assert.equal(res.MULTILINE, 'first line\nsecond line');
});

test('loadDotenv loads file into process.env without overriding existing by default', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ruko-test-'));
  const tmpFile = join(tmpDir, 'test.env');
  writeFileSync(tmpFile, 'TEST_RUKO_DOTENV_KEY=some_value\nTEST_EXISTING_KEY=new_val', 'utf8');

  process.env.TEST_EXISTING_KEY = 'orig_val';
  try {
    loadDotenv({ path: tmpFile });
    assert.equal(process.env.TEST_RUKO_DOTENV_KEY, 'some_value');
    assert.equal(process.env.TEST_EXISTING_KEY, 'orig_val', 'existing must not be overridden');

    // With override: true
    loadDotenv({ path: tmpFile, override: true });
    assert.equal(process.env.TEST_EXISTING_KEY, 'new_val');
  } finally {
    delete process.env.TEST_RUKO_DOTENV_KEY;
    delete process.env.TEST_EXISTING_KEY;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});
