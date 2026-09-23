import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  sanitizeEnv,
  validateManifest,
  interpolateArgs,
  manifestToToolDefinition,
  loadManifest,
  scanManifests,
  executeExternalTool,
} from '../agent/external-tools.js';

test('sanitizeEnv strips sensitive keys but keeps safe ones', () => {
  const fakeEnv = {
    PATH: '/usr/bin',
    HOME: '/home/user',
    NODE_ENV: 'test',
    OPENAI_API_KEY: 'sk-12345',
    ANTHROPIC_API_KEY: 'sk-ant-123',
    SECRET_TOKEN: 'hidden',
    PASSWORD: 'pwd',
    MY_CREDENTIAL: 'xyz',
  };

  const clean = sanitizeEnv(fakeEnv);

  assert.strictEqual(clean.PATH, '/usr/bin');
  assert.strictEqual(clean.HOME, '/home/user');
  assert.strictEqual(clean.NODE_ENV, 'test');
  
  assert.strictEqual(clean.OPENAI_API_KEY, undefined);
  assert.strictEqual(clean.ANTHROPIC_API_KEY, undefined);
  assert.strictEqual(clean.SECRET_TOKEN, undefined);
  assert.strictEqual(clean.PASSWORD, undefined);
  assert.strictEqual(clean.MY_CREDENTIAL, undefined);
});

test('validateManifest with valid manifest returns null', () => {
  const manifest = {
    name: 'test_tool',
    description: 'A test tool',
    command: 'echo',
    args: ['hello'],
    parameters: { type: 'object', properties: {} }
  };
  assert.strictEqual(validateManifest(manifest), null);
});

test('validateManifest with invalid manifests returns error strings', () => {
  assert.match(validateManifest(null) as string, /objek JSON/);
  assert.match(validateManifest({ description: 'desc', command: 'cmd' }) as string, /"name"/);
  assert.match(validateManifest({ name: 'name', command: 'cmd' }) as string, /"description"/);
  assert.match(validateManifest({ name: 'name', description: 'desc' }) as string, /"command"/);
  assert.match(validateManifest({ name: 'n', description: 'd', command: 'c', args: 'not-array' }) as string, /"args"/);
});

test('interpolateArgs substitutes correctly', () => {
  const args = ['--name', '{{name}}', '--age', '{{age}}'];
  const params = { name: 'Alice', age: 30 };
  const result = interpolateArgs(args, params);
  assert.deepEqual(result, ['--name', 'Alice', '--age', '30']);
});

test('interpolateArgs with missing params replaces with empty string', () => {
  const args = ['--name', '{{name}}'];
  const params = {};
  const result = interpolateArgs(args, params);
  assert.deepEqual(result, ['--name', '']);
});

test('manifestToToolDefinition produces correct OpenAI format', () => {
  const manifest = {
    name: 'test_tool',
    description: 'A test tool',
    command: 'echo',
    parameters: { type: 'object' as const, properties: { prop: { type: 'string' } } }
  };
  const def = manifestToToolDefinition(manifest);
  assert.strictEqual(def.type, 'function');
  assert.strictEqual(def.function.name, 'test_tool');
  assert.strictEqual(def.function.description, 'A test tool');
  assert.deepEqual(def.function.parameters, manifest.parameters);
});

test('loadManifest and scanManifests with a valid temporary file', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ruko-test-'));

  const manifestPath = join(tempDir, 'test.tool.json');
  const manifestData = {
    name: 'temp_tool',
    description: 'temp',
    command: 'ls'
  };

  try {
    await writeFile(manifestPath, JSON.stringify(manifestData));
    
    // Test loadManifest
    const loaded = await loadManifest(manifestPath);
    assert.strictEqual(loaded.name, 'temp_tool');
    
    // Test scanManifests
    const manifests = await scanManifests(tempDir);
    assert.strictEqual(manifests.length, 1);
    assert.strictEqual(manifests[0].name, 'temp_tool');
    
    // Scan empty dir
    const emptyDir = join(tempDir, 'empty');
    await mkdir(emptyDir);
    const emptyScan = await scanManifests(emptyDir);
    assert.strictEqual(emptyScan.length, 0);

  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('executeExternalTool with a simple command', async () => {
  const manifest = {
    name: 'echo_tool',
    description: 'echoes',
    command: 'echo',
    args: ['hello', '{{name}}']
  };
  
  const result = await executeExternalTool(manifest, { name: 'world' });
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.timedOut, false);
  assert.match(result.stdout, /hello world/);
});

test('executeExternalTool timeout behavior', async () => {
  const manifest = {
    name: 'sleep_tool',
    description: 'sleeps',
    command: 'sleep',
    args: ['2'] // sleep for 2 seconds
  };
  
  const start = Date.now();
  const result = await executeExternalTool(manifest, {}, { timeoutMs: 100 });
  const duration = Date.now() - start;
  
  assert.strictEqual(result.timedOut, true);
  // execution should take around 100ms, definitely less than 2 seconds
  assert.ok(duration < 1000);
});
