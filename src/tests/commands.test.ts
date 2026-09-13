import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHelpText, listCommands, matchCommands } from '../agent/commands.js';

test('every core command from feedback §3.18 exists', () => {
  const names = new Set(listCommands().map((c) => c.name));
  for (const want of ['help', 'login', 'model', 'plan', 'compact', 'clear', 'undo', 'usage', 'resume', 'role', 'mode', 'memory', 'export']) {
    assert.ok(names.has(want), `missing /${want}`);
  }
});

test('/help is GENERATED from the registry — never out of sync (§3.17)', () => {
  const help = buildHelpText();
  for (const c of listCommands()) {
    assert.ok(help.includes(`/${c.name}`), `help missing /${c.name}`);
    assert.ok(help.includes(c.help), `help missing description for /${c.name}`);
  }
});

test('matchCommands filters by prefix for autocomplete (§3.16)', () => {
  const m = matchCommands('/mo').map((c) => c.name);
  assert.deepEqual(m.sort(), ['mode', 'model']);
  assert.equal(matchCommands('/zzz').length, 0);
});

test('/anim command exists in registry', () => {
  const names = new Set(listCommands().map((c) => c.name));
  assert.ok(names.has('anim'), 'missing /anim');
});

test('maskApiKey never exposes full secret for short, medium, or long keys (M3)', async () => {
  const { maskApiKey } = await import('../agent/commands.js');
  // Unset or empty
  assert.match(maskApiKey(''), /belum diatur/);
  assert.match(maskApiKey(undefined), /belum diatur/);

  // Short keys (<= 8 chars) - completely masked
  assert.equal(maskApiKey('sk-12345'), '•••••••• (masked)');
  assert.equal(maskApiKey('12345678'), '•••••••• (masked)');

  // Medium keys (9-14 chars) - 2 head, 2 tail
  const med = maskApiKey('secret1234'); // 10 chars
  assert.equal(med, 'se…34 (masked)');
  assert.ok(!med.includes('secret'));

  // Long keys (> 14 chars) - 3 head, 4 tail
  const longKey = maskApiKey('sk-proj-abc123xyz789'); // 20 chars
  assert.equal(longKey, 'sk-…z789 (masked)');
  assert.ok(!longKey.includes('abc123xyz'));
});

test('/context and /context set <jumlah> command works with validations', async () => {
  const { handleCommand } = await import('../agent/commands.js');
  const { Context } = await import('../core/context.js');
  const { DEFAULT_CONFIG } = await import('../types.js');

  const config = { ...DEFAULT_CONFIG, maxContextChars: 30000 };
  const ctx = new Context(config);
  ctx.add('user', 'pesan awal sepanjang 20 karakter'); // totalChars = 34

  let updatedPatch: any = null;
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);

  const env: any = {
    ctx,
    config,
    llm: { model: 'test-model', isConfigured: true },
    confirm: async () => true,
    updateConfig: (patch: any) => {
      updatedPatch = patch;
      Object.assign(config, patch);
    },
    handle: { stop: () => {}, getSessionId: () => null, setSessionId: () => {} },
  };

  try {
    // 1. Display context stats
    await handleCommand('/context', env);
    assert.ok(logged.some((l) => l.includes('messages: 1')));
    assert.ok(logged.some((l) => l.includes('budget: 30000')));

    // 2. Set valid numeric budget
    logged.length = 0;
    await handleCommand('/context set 50000', env);
    assert.equal(config.maxContextChars, 50000);
    assert.equal(updatedPatch.maxContextChars, 50000);
    assert.ok(logged.some((l) => l.includes('50000 karakter')));

    // 3. Set with k notation (e.g. 60k)
    logged.length = 0;
    await handleCommand('/context set 60k', env);
    assert.equal(config.maxContextChars, 60000);

    // 4. Reject negative / zero / invalid
    logged.length = 0;
    await handleCommand('/context set -500', env);
    assert.ok(logged.some((l) => l.includes('angka positif')));

    logged.length = 0;
    await handleCommand('/context set abc', env);
    assert.ok(logged.some((l) => l.includes('angka positif')));

    // 5. Reject budget lower than currently used chars
    logged.length = 0;
    const currentChars = ctx.totalChars;
    await handleCommand(`/context set ${currentChars - 5}`, env);
    assert.ok(logged.some((l) => l.includes('tidak boleh lebih rendah')));
    // Config should still be 60000
    assert.equal(config.maxContextChars, 60000);
  } finally {
    console.log = origLog;
  }
});

