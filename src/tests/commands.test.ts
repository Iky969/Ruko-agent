import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHelpText, listCommands, matchCommands } from '../agent/commands.js';

test('every core command from feedback §3.18 exists', () => {
  const names = new Set(listCommands().map((c) => c.name));
  for (const want of ['help', 'login', 'model', 'plan', 'compact', 'clear', 'undo', 'usage', 'resume', 'role', 'mode']) {
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
