import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHelpText, listCommands, matchCommands } from '../agent/commands.js';
import { visibleLength } from '../core/ui.js';

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

test('/anim command is not in registry', () => {
  const names = new Set(listCommands().map((c) => c.name));
  assert.ok(!names.has('anim'), 'anim should be completely removed');
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

test('VULN-04: /config set baseUrl blocks cleartext remote HTTP unless overridden', async () => {
  const { handleCommand } = await import('../agent/commands.js');
  const { Context } = await import('../core/context.js');
  const { DEFAULT_CONFIG } = await import('../types.js');

  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);

  let updatedPatch: any = null;
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);

  const env: any = {
    ctx,
    config,
    llm: { model: 'test-model', isConfigured: true, setCredentials: () => {} },
    confirm: async () => true,
    updateConfig: (patch: any) => {
      updatedPatch = patch;
      Object.assign(config, patch);
    },
    handle: { stop: () => {}, getSessionId: () => null, setSessionId: () => {} },
  };

  try {
    // 1. Remote HTTP without override -> rejected
    logged.length = 0;
    updatedPatch = null;
    await handleCommand('/config set baseUrl http://attacker.com/v1', env);
    assert.equal(updatedPatch, null);
    assert.ok(logged.some((l) => l.includes('HTTP (cleartext) untuk host remote')));

    // 2. Remote HTTP with --insecure -> allowed
    logged.length = 0;
    updatedPatch = null;
    await handleCommand('/config set baseUrl http://attacker.com/v1 --insecure', env);
    assert.equal(updatedPatch?.baseUrl, 'http://attacker.com/v1');

    // 3. Localhost HTTP -> allowed
    logged.length = 0;
    updatedPatch = null;
    await handleCommand('/config set baseUrl http://localhost:11434/v1', env);
    assert.equal(updatedPatch?.baseUrl, 'http://localhost:11434/v1');

    // 4. Remote HTTPS -> allowed
    logged.length = 0;
    updatedPatch = null;
    await handleCommand('/config set baseUrl https://api.openai.com/v1', env);
    assert.equal(updatedPatch?.baseUrl, 'https://api.openai.com/v1');

    // 5. Private LAN IP / router HTTP -> allowed without --insecure
    logged.length = 0;
    updatedPatch = null;
    await handleCommand('/config set baseUrl http://192.168.1.100:11434/v1', env);
    assert.equal(updatedPatch?.baseUrl, 'http://192.168.1.100:11434/v1');

    logged.length = 0;
    updatedPatch = null;
    await handleCommand('/config set baseUrl http://router.local:8000/v1', env);
    assert.equal(updatedPatch?.baseUrl, 'http://router.local:8000/v1');

    // 6. HTTP rejected by user trust check -> aborted
    const untrustedEnv = {
      ...env,
      confirm: async () => false,
    };
    logged.length = 0;
    updatedPatch = null;
    await handleCommand('/config set baseUrl http://localhost:11434/v1', untrustedEnv);
    assert.equal(updatedPatch, null);
    assert.ok(logged.some((l) => l.includes('Dibatalkan: protokol/URL HTTP tidak disetujui')));
  } finally {
    console.log = origLog;
  }
});

test('VULN-05: /undo <path> rejects path traversal outside workspace', async () => {
  const { handleCommand } = await import('../agent/commands.js');
  const { Context } = await import('../core/context.js');
  const { DEFAULT_CONFIG } = await import('../types.js');

  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);

  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);

  const env: any = {
    ctx,
    config,
    llm: { model: 'test-model', isConfigured: true },
    confirm: async () => true,
    updateConfig: () => {},
    handle: { stop: () => {}, getSessionId: () => null, setSessionId: () => {} },
  };

  try {
    logged.length = 0;
    await handleCommand('/undo ../../../etc/passwd', env);
    assert.ok(logged.some((l) => l.includes('di luar working directory')));
  } finally {
    console.log = origLog;
  }
});

test('/help renders modern Freebuff-style Chip/Badge Highlight with navy background and 1 space inside', () => {
  const help = buildHelpText();
  // Navy background \x1b[48;5;18m and bold bright white \x1b[1;97m
  assert.ok(help.includes('\x1b[48;5;18m\x1b[1;97m /help \x1b[0m'));
  assert.ok(help.includes('\x1b[48;5;18m\x1b[1;97m /config \x1b[0m'));
  assert.ok(help.includes('\x1b[48;5;18m\x1b[1;97m /undo \x1b[0m'));

  // Every command must have 1 leading space and 1 trailing space inside badge
  for (const c of listCommands()) {
    assert.ok(
      help.includes(`\x1b[48;5;18m\x1b[1;97m /${c.name} \x1b[0m`),
      `Badge missing or incorrectly padded for /${c.name}`,
    );
  }

  // Description must use neutral light gray \x1b[37m
  assert.ok(help.includes('\x1b[37m'));
});

test('/help groups commands into elegant categorized badge headers', () => {
  const help = buildHelpText();
  const categories = [
    '[ Sesi & Model ]',
    '[ Konfigurasi & Budget ]',
    '[ Operasi & Eksekusi ]',
    '[ Sistem & Bantuan ]',
  ];

  for (const cat of categories) {
    assert.ok(help.includes(cat), `Missing category header: ${cat}`);
    // Dim background \x1b[48;5;236m with bold cyan \x1b[1;36m
    assert.ok(
      help.includes(`\x1b[48;5;236m\x1b[1;36m ${cat} \x1b[0m`),
      `Category header badge style missing for ${cat}`,
    );
  }
});

test('/help aligns descriptions with precise column spacing', () => {
  const help = buildHelpText();
  const lines = help.split('\n');

  for (const c of listCommands()) {
    const line = lines.find((l) => l.includes(`/${c.name} `));
    assert.ok(line, `Line for /${c.name} not found`);

    // Match leading spaces, badge, padding, and the start of description \x1b[37m
    const match = line.match(/^(\s*\x1b\[48;5;18m\x1b\[1;97m\s+\/[^\s]+\s+\x1b\[0m\s*)(?=\x1b\[37m)/);
    assert.ok(match, `Invalid layout format for /${c.name}`);

    // Visible length of leading indent + badge + padding must be exactly 17
    const prefixVisible = visibleLength(match[1]);
    assert.equal(
      prefixVisible,
      17,
      `Expected prefix column visible width of 17 for /${c.name}, got ${prefixVisible}`,
    );
  }
});

test('/help header and badges fit safely within narrow 40-60 column terminals without wrapping issues', () => {
  const origCols = process.env.COLUMNS;
  try {
    process.env.COLUMNS = '40';
    const help40 = buildHelpText();
    const lines = help40.split('\n');

    for (const line of lines) {
      // Category header line must not exceed 40 columns
      if (line.includes('[ Sesi & Model ]') || line.includes('[ Konfigurasi & Budget ]')) {
        const len = visibleLength(line);
        assert.ok(
          len <= 39,
          `Category header line exceeds 39 cols on 40-col screen: ${len} (${line})`,
        );
      }
    }
  } finally {
    if (origCols !== undefined) process.env.COLUMNS = origCols;
    else delete process.env.COLUMNS;
  }
});


