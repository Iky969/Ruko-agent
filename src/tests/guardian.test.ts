import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assessWithGuardian,
  detectRisk,
  guardedExecute,
  parseGuardianResponse,
} from '../core/approval.js';
import { AgentConfig, ContextMessage, DEFAULT_CONFIG } from '../types.js';
import type { LLMProvider, ChatOptions, ConnectionResult } from '../agent/llm.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...DEFAULT_CONFIG, guardianEnabled: true, guardianTimeoutMs: 5_000, ...overrides };
}

/**
 * Creates a fake LLM provider that returns a predetermined guardian response.
 * The `chatFn` receives the messages so tests can assert what was sent.
 */
function fakeProvider(
  chatFn: (messages: ContextMessage[], options?: ChatOptions) => Promise<string>,
): LLMProvider {
  return {
    name: 'fake-guardian',
    isConfigured: true,
    model: 'test-model',
    setModel() {},
    chat: chatFn,
  };
}

/** Provider that returns a fixed JSON verdict string. */
function verdictProvider(verdict: 'safe' | 'dangerous' | 'blocked', reasoning = 'test'): LLMProvider {
  return fakeProvider(async () => JSON.stringify({ verdict, reasoning }));
}

/** Provider that throws an error (simulates network failure / timeout). */
function failingProvider(error = 'Network error'): LLMProvider {
  return fakeProvider(async () => { throw new Error(error); });
}

/** Provider that returns malformed / non-JSON output. */
function garbageProvider(output = 'I cannot help with that.'): LLMProvider {
  return fakeProvider(async () => output);
}

// ─────────────────────────────────────────────────────────────────────────────
// parseGuardianResponse unit tests
// ─────────────────────────────────────────────────────────────────────────────

test('parseGuardianResponse: parses clean JSON', () => {
  const r = parseGuardianResponse('{"verdict":"safe","reasoning":"Benign print command."}');
  assert.equal(r.verdict, 'safe');
  assert.equal(r.reasoning, 'Benign print command.');
});

test('parseGuardianResponse: parses JSON with markdown fences', () => {
  const r = parseGuardianResponse('```json\n{"verdict":"blocked","reasoning":"Deletes /etc."}\n```');
  assert.equal(r.verdict, 'blocked');
  assert.equal(r.reasoning, 'Deletes /etc.');
});

test('parseGuardianResponse: case-insensitive verdict', () => {
  const r = parseGuardianResponse('{"verdict":"SAFE","reasoning":"ok"}');
  assert.equal(r.verdict, 'safe');
});

test('parseGuardianResponse: unknown verdict falls back to dangerous', () => {
  const r = parseGuardianResponse('{"verdict":"maybe","reasoning":"not sure"}');
  assert.equal(r.verdict, 'dangerous');
  assert.match(r.reasoning, /tidak dikenal/);
});

test('parseGuardianResponse: no JSON → dangerous fallback', () => {
  const r = parseGuardianResponse('I cannot evaluate this command.');
  assert.equal(r.verdict, 'dangerous');
  assert.match(r.reasoning, /tidak mengandung JSON/);
});

test('parseGuardianResponse: malformed JSON → dangerous fallback', () => {
  const r = parseGuardianResponse('{verdict: safe}');
  assert.equal(r.verdict, 'dangerous');
});

test('parseGuardianResponse: JSON embedded in extra text', () => {
  const r = parseGuardianResponse('Here is my analysis:\n{"verdict":"blocked","reasoning":"Wipes disk."}\nDone.');
  assert.equal(r.verdict, 'blocked');
  assert.equal(r.reasoning, 'Wipes disk.');
});

// ─────────────────────────────────────────────────────────────────────────────
// assessWithGuardian unit tests
// ─────────────────────────────────────────────────────────────────────────────

test('assessWithGuardian: returns safe for benign command', async () => {
  const r = await assessWithGuardian('python3 -c "print(1+1)"', config(), verdictProvider('safe', 'Simple print.'));
  assert.equal(r.verdict, 'safe');
  assert.equal(r.reasoning, 'Simple print.');
});

test('assessWithGuardian: returns blocked for destructive command', async () => {
  const r = await assessWithGuardian(
    'python3 -c "import shutil; shutil.rmtree(\'/etc\')"',
    config(),
    verdictProvider('blocked', 'Deletes /etc recursively.'),
  );
  assert.equal(r.verdict, 'blocked');
});

test('assessWithGuardian: returns dangerous for ambiguous command', async () => {
  const r = await assessWithGuardian(
    'node -e "require(\'child_process\').execSync(\'ls\')"',
    config(),
    verdictProvider('dangerous', 'Executes arbitrary shell command.'),
  );
  assert.equal(r.verdict, 'dangerous');
});

test('assessWithGuardian: network error → fail-safe dangerous', async () => {
  const r = await assessWithGuardian('python3 -c "exit()"', config(), failingProvider());
  assert.equal(r.verdict, 'dangerous');
  assert.match(r.reasoning, /gagal dihubungi/);
});

test('assessWithGuardian: garbage response → fail-safe dangerous', async () => {
  const r = await assessWithGuardian('python3 -c "exit()"', config(), garbageProvider());
  assert.equal(r.verdict, 'dangerous');
});

test('assessWithGuardian: no provider → fail-safe dangerous', async () => {
  const r = await assessWithGuardian('python3 -c "exit()"', config(), null);
  assert.equal(r.verdict, 'dangerous');
  assert.match(r.reasoning, /tidak tersedia/);
});

test('assessWithGuardian: guardian disabled → fail-safe dangerous', async () => {
  const r = await assessWithGuardian(
    'python3 -c "exit()"',
    config({ guardianEnabled: false }),
    verdictProvider('safe'),
  );
  assert.equal(r.verdict, 'dangerous');
});

test('assessWithGuardian: unconfigured provider → fail-safe dangerous', async () => {
  const unconfigured: LLMProvider = {
    name: 'unconfigured',
    isConfigured: false,
    model: '',
    setModel() {},
    chat: async () => '',
  };
  const r = await assessWithGuardian('python3 -c "exit()"', config(), unconfigured);
  assert.equal(r.verdict, 'dangerous');
});

test('assessWithGuardian: sends correct system prompt and command', async () => {
  let capturedMessages: ContextMessage[] = [];
  const provider = fakeProvider(async (msgs) => {
    capturedMessages = msgs;
    return '{"verdict":"safe","reasoning":"ok"}';
  });
  await assessWithGuardian('node -e "console.log(42)"', config(), provider);
  assert.equal(capturedMessages.length, 2);
  assert.equal(capturedMessages[0].role, 'system');
  assert.match(capturedMessages[0].content, /SECURITY ANALYST/);
  assert.equal(capturedMessages[1].role, 'user');
  assert.match(capturedMessages[1].content, /node -e "console.log\(42\)"/);
});

test('assessWithGuardian: uses small max_tokens and temperature 0', async () => {
  let capturedOptions: ChatOptions | undefined;
  const provider = fakeProvider(async (_msgs, opts) => {
    capturedOptions = opts;
    return '{"verdict":"safe","reasoning":"ok"}';
  });
  await assessWithGuardian('echo hi', config(), provider);
  assert.equal(capturedOptions?.maxTokens, 150);
  assert.equal(capturedOptions?.temperature, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// guardedExecute integration with guardian
// ─────────────────────────────────────────────────────────────────────────────

test('guardedExecute + guardian: DANGEROUS + guardian safe → auto-execute', async () => {
  // python3 -c is DANGEROUS by regex. Guardian says safe → should run.
  const result = await guardedExecute(
    'python3 -c "print(42)"',
    {
      confirm: async () => { throw new Error('Should not be called'); },
      llmProvider: verdictProvider('safe', 'Simple print.'),
    },
    config(),
  );
  // Command actually ran (python3 prints 42)
  assert.equal(result.code, 0);
  assert.match(result.output, /42/);
});

test('guardedExecute + guardian: DANGEROUS + guardian blocked → refuse without asking user', async () => {
  const result = await guardedExecute(
    'python3 -c "import shutil; shutil.rmtree(\'/etc\')"',
    {
      confirm: async () => { throw new Error('Should not be called'); },
      llmProvider: verdictProvider('blocked', 'Destroys /etc.'),
    },
    config(),
  );
  assert.equal(result.code, null);
  assert.match(result.output, /BLOCKED/);
  assert.match(result.output, /Guardian LLM/);
});

test('guardedExecute + guardian: DANGEROUS + guardian dangerous → falls through to user confirm', async () => {
  let confirmCalled = false;
  const result = await guardedExecute(
    'sudo apt install vim',
    {
      confirm: async () => { confirmCalled = true; return false; },
      llmProvider: verdictProvider('dangerous', 'Privilege escalation.'),
    },
    config(),
  );
  assert.ok(confirmCalled, 'User confirmation should be called when guardian says dangerous');
  assert.equal(result.code, null);
  assert.match(result.output, /ditolak/);
});

test('guardedExecute + guardian: DANGEROUS + guardian error → falls through to user confirm', async () => {
  let confirmCalled = false;
  const result = await guardedExecute(
    'sudo apt install vim',
    {
      confirm: async () => { confirmCalled = true; return false; },
      llmProvider: failingProvider('Connection refused'),
    },
    config(),
  );
  assert.ok(confirmCalled, 'User confirmation should be called on guardian error');
});

test('guardedExecute + guardian: NONE commands bypass guardian entirely', async () => {
  let guardianCalled = false;
  const spyProvider = fakeProvider(async () => {
    guardianCalled = true;
    return '{"verdict":"blocked","reasoning":"Should not happen"}';
  });
  const result = await guardedExecute(
    'ls -la',
    { llmProvider: spyProvider },
    config(),
  );
  assert.ok(!guardianCalled, 'Guardian should NOT be called for NONE risk commands');
  assert.equal(result.code, 0);
});

test('guardedExecute + guardian: BLOCKED commands bypass guardian entirely', async () => {
  let guardianCalled = false;
  const spyProvider = fakeProvider(async () => {
    guardianCalled = true;
    return '{"verdict":"safe","reasoning":"Should not happen"}';
  });
  const result = await guardedExecute(
    'rm -rf /etc',
    { confirm: async () => true, llmProvider: spyProvider },
    config(),
  );
  assert.ok(!guardianCalled, 'Guardian should NOT be called for BLOCKED commands');
  assert.match(result.output, /BLOCKED/);
});

test('guardedExecute + guardian: guardianEnabled=false skips guardian', async () => {
  let guardianCalled = false;
  let confirmCalled = false;
  const spyProvider = fakeProvider(async () => {
    guardianCalled = true;
    return '{"verdict":"safe","reasoning":"safe"}';
  });
  const result = await guardedExecute(
    'sudo echo hi',
    {
      confirm: async () => { confirmCalled = true; return true; },
      llmProvider: spyProvider,
    },
    config({ guardianEnabled: false }),
  );
  assert.ok(!guardianCalled, 'Guardian should NOT be called when disabled');
  assert.ok(confirmCalled, 'Should fall through directly to user confirm');
});

test('guardedExecute + guardian: onGuardianStatus callback is called', async () => {
  const statuses: Array<string | null> = [];
  await guardedExecute(
    'python3 -c "print(1)"',
    {
      confirm: async () => true,
      llmProvider: verdictProvider('safe', 'ok'),
      onGuardianStatus: (msg) => statuses.push(msg),
    },
    config(),
  );
  assert.deepEqual(statuses, ['🔍 Memeriksa keamanan command...', null]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial guardian scenarios — the 6 known limitations
// ─────────────────────────────────────────────────────────────────────────────

test('guardian scenario: python3 -c destructive payload → regex DANGEROUS, guardian should block', async () => {
  // This tests the scenario from feedback: python3 -c "shutil.rmtree('/etc')"
  // Regex marks it DANGEROUS (interpreter inline). A properly-prompted guardian should say blocked.
  const verdict = detectRisk('python3 -c "import shutil; shutil.rmtree(\'/etc\')"', config());
  assert.equal(verdict.risk, 'dangerous', 'Regex should classify as DANGEROUS');

  // With a guardian that correctly analyses the payload:
  const result = await guardedExecute(
    'python3 -c "import shutil; shutil.rmtree(\'/etc\')"',
    {
      confirm: async () => { throw new Error('Should not reach user'); },
      llmProvider: verdictProvider('blocked', 'shutil.rmtree deletes /etc recursively.'),
    },
    config(),
  );
  assert.match(result.output, /BLOCKED/);
});

test('guardian scenario: python3 -c safe payload → regex DANGEROUS, guardian should allow', async () => {
  // python3 -c "print(1+1)" is DANGEROUS by regex but actually safe.
  // Guardian should say safe, command should auto-execute.
  const result = await guardedExecute(
    'python3 -c "print(1+1)"',
    {
      confirm: async () => { throw new Error('Should not reach user'); },
      llmProvider: verdictProvider('safe', 'Simple arithmetic print.'),
    },
    config(),
  );
  assert.equal(result.code, 0);
  assert.match(result.output, /2/);
});

test('guardian scenario: variable indirection X=/etc; rm -rf $X → regex DANGEROUS', async () => {
  // Regex catches rm -rf as DANGEROUS but can't resolve $X.
  // Guardian should identify the variable indirection.
  const verdict = detectRisk('X=/etc; rm -rf $X', config());
  assert.equal(verdict.risk, 'dangerous', 'Regex should at least be DANGEROUS');

  const result = await guardedExecute(
    'X=/etc; rm -rf $X',
    {
      confirm: async () => { throw new Error('Should not reach user'); },
      llmProvider: verdictProvider('blocked', 'Variable $X resolves to /etc, rm -rf would delete system directory.'),
    },
    config(),
  );
  assert.match(result.output, /BLOCKED/);
});

test('guardian scenario: eval obfuscation → regex DANGEROUS, guardian blocks', async () => {
  // eval constructs are now caught as DANGEROUS by the regex layer (eval pattern).
  // The guardian can then semantically decode the base64 payload and block.
  const cmd = 'eval "$(echo cm0gLXJmIC9ldGM= | base64 -d)"';
  const verdict = detectRisk(cmd, config());
  assert.equal(verdict.risk, 'dangerous',
    'Eval should be caught as DANGEROUS by regex');

  const result = await guardedExecute(
    cmd,
    {
      confirm: async () => { throw new Error('Should not reach user'); },
      llmProvider: verdictProvider('blocked', 'Decodes and executes rm -rf /etc.'),
    },
    config(),
  );
  assert.match(result.output, /BLOCKED/);
});

test('guardian scenario: node -e destructive → guardian blocks', async () => {
  const result = await guardedExecute(
    'node -e "require(\'fs\').rmSync(\'/\', {recursive: true, force: true})"',
    {
      confirm: async () => { throw new Error('Should not reach user'); },
      llmProvider: verdictProvider('blocked', 'Recursively deletes entire filesystem.'),
    },
    config(),
  );
  assert.match(result.output, /BLOCKED/);
});

test('guardian scenario: node -e safe → guardian allows', async () => {
  const result = await guardedExecute(
    'node -e "console.log(\'hello\')"',
    {
      confirm: async () => { throw new Error('Should not reach user'); },
      llmProvider: verdictProvider('safe', 'Simple console.log.'),
    },
    config(),
  );
  assert.equal(result.code, 0);
  assert.match(result.output, /hello/);
});
