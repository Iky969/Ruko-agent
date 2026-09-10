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
