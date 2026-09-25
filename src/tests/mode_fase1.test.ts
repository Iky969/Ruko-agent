import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { ReadStream, WriteStream } from 'node:tty';
import { LineEditor } from '../core/tui.js';
import { Agent, IDEMPOTENT_READ_TOOLS, BUILD_MUTATING_TOOLS } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { ChatOptions, LLMProvider } from '../agent/llm.js';
import { handleCommand } from '../agent/commands.js';
import { ContextMessage, DEFAULT_CONFIG } from '../types.js';

class FakeInput extends EventEmitter {
  isTTY = true;
  rawMode = false;
  setRawMode(mode: boolean): void {
    this.rawMode = mode;
  }
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
  send(keys: string): void {
    this.emit('data', keys);
  }
}

class FakeOutput {
  data = '';
  isTTY = true;
  columns = 80;
  write(text: string): boolean {
    this.data += text;
    return true;
  }
}

function makeEditor(): { editor: LineEditor; input: FakeInput; output: FakeOutput } {
  const input = new FakeInput();
  const output = new FakeOutput();
  const editor = new LineEditor(input as unknown as ReadStream, output as unknown as WriteStream);
  return { editor, input, output };
}

class MockSequenceProvider implements LLMProvider {
  readonly name = 'mock-sequence';
  readonly isConfigured = true;
  model = 'mock-model';
  lastFinishReason: string | null = 'stop';
  receivedMessages: ContextMessage[][] = [];
  private calls = 0;

  constructor(private readonly replies: string[]) {}

  setModel(model: string): void {
    this.model = model;
  }

  async chat(messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    this.receivedMessages.push([...messages]);
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    options?.onToken?.(reply);
    return reply;
  }
}

// ============================================================================
// FASE 1 Tests: Popup Selector Navigation, Description, Cancellation & Input Blocking
// ============================================================================

test('Fase 1: askSelector navigates options with Arrow Up/Down and shows 1-line description', async () => {
  const { editor, input, output } = makeEditor();

  const promise = editor.askSelector({
    title: 'Pilih Mode',
    defaultId: 'default',
    items: [
      { id: 'default', label: 'Default', description: 'Perilaku bawaan sistem saat ini.' },
      { id: 'research', label: 'Research', description: 'Relaksasi batas loop khusus whitelist tool read-only.' },
      { id: 'code', label: 'Code', description: 'Batas loop standar, tanpa pengecualian.' },
      { id: 'build', label: 'Build', description: 'Fase explore (longgar) lalu beralih ke mutate (ketat).' },
    ],
  });

  // Verify initial render contains title and default description
  assert.ok(output.data.includes('Pilih Mode'), 'Title rendered');
  assert.ok(output.data.includes('Perilaku bawaan sistem saat ini.'), 'Default description rendered');

  output.data = '';
  // Press Arrow Down -> move to Research
  input.send('\u001b[B');
  assert.ok(output.data.includes('Relaksasi batas loop khusus whitelist tool read-only.'), 'Research description rendered');

  output.data = '';
  // Press Arrow Down -> move to Code
  input.send('\u001b[B');
  assert.ok(output.data.includes('Batas loop standar, tanpa pengecualian.'), 'Code description rendered');

  output.data = '';
  // Press Arrow Down -> move to Build
  input.send('\u001b[B');
  assert.ok(output.data.includes('Fase explore (longgar) lalu beralih ke mutate (ketat).'), 'Build description rendered');

  // Press Enter to confirm Build
  input.send('\r');
  const result = await promise;
  assert.equal(result, 'build', 'Enter confirmed Build selection');
});

test('Fase 1: askSelector Arrow Up wraps around to last option', async () => {
  const { editor, input, output } = makeEditor();

  const promise = editor.askSelector({
    title: 'Pilih Mode',
    defaultId: 'default',
    items: [
      { id: 'default', label: 'Default', description: 'Perilaku bawaan sistem saat ini.' },
      { id: 'research', label: 'Research', description: 'Relaksasi batas loop khusus whitelist tool read-only.' },
      { id: 'code', label: 'Code', description: 'Batas loop standar, tanpa pengecualian.' },
      { id: 'build', label: 'Build', description: 'Fase explore (longgar) lalu beralih ke mutate (ketat).' },
    ],
  });

  // Arrow Up from index 0 -> wraps to Build (index 3)
  output.data = '';
  input.send('\u001b[A');
  assert.ok(output.data.includes('Fase explore (longgar) lalu beralih ke mutate (ketat).'), 'Wrapped to Build');

  input.send('\r');
  const result = await promise;
  assert.equal(result, 'build');
});

test('Fase 1: askSelector cancels on Esc without side effect and returns null', async () => {
  const { editor, input } = makeEditor();

  const promise = editor.askSelector({
    title: 'Pilih Mode',
    defaultId: 'default',
    items: [
      { id: 'default', label: 'Default', description: 'Perilaku bawaan sistem saat ini.' },
      { id: 'research', label: 'Research', description: 'Relaksasi batas loop khusus whitelist tool read-only.' },
    ],
  });

  // Press Escape
  input.send('\u001b');
  const result = await promise;
  assert.equal(result, null, 'Esc cancelled selector returning null');
});

test('Fase 1: askSelector cancels on Ctrl+C without side effect and returns null', async () => {
  const { editor, input } = makeEditor();

  const promise = editor.askSelector({
    title: 'Pilih Mode',
    defaultId: 'default',
    items: [
      { id: 'default', label: 'Default', description: 'Perilaku bawaan sistem saat ini.' },
      { id: 'research', label: 'Research', description: 'Relaksasi batas loop khusus whitelist tool read-only.' },
    ],
  });

  // Press Ctrl+C (\u0003)
  input.send('\u0003');
  const result = await promise;
  assert.equal(result, null, 'Ctrl+C cancelled selector returning null');
});

test('Fase 1: askSelector blocks chat input while open', async () => {
  const { editor, input, output } = makeEditor();

  const promise = editor.askSelector({
    title: 'Pilih Mode',
    defaultId: 'default',
    items: [
      { id: 'default', label: 'Default', description: 'Perilaku bawaan sistem saat ini.' },
      { id: 'research', label: 'Research', description: 'Relaksasi batas loop khusus whitelist tool read-only.' },
    ],
  });

  output.data = '';
  // Type regular characters that would normally go into a chat buffer
  input.send('hello world 123 !@#');
  // None of this should appear as typed buffer text
  assert.equal(output.data, '', 'Regular keys ignored and not echoed');

  input.send('\r');
  const result = await promise;
  assert.equal(result, 'default');
});

// ============================================================================
// FASE 1 Tests: Command /mode, SessionState In-Memory & Reset State Per Session
// ============================================================================

test('Fase 1: /mode opens popup selector and updates sessionState in-memory', async () => {
  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const provider = new MockSequenceProvider(['ok']);
  const agent = new Agent(ctx, provider, config);

  assert.equal(agent.sessionState.mode, 'default');
  assert.equal(agent.sessionState.buildPhase, 'explore');

  let selectCalled = false;
  const mockEnv = {
    ctx,
    config,
    llm: provider,
    agent,
    sessionState: agent.sessionState,
    confirm: async () => true,
    select: async (options: any) => {
      selectCalled = true;
      assert.equal(options.items.length, 4);
      return 'research';
    },
    updateConfig: () => {
      assert.fail('updateConfig should NOT be called for session-scoped mode');
    },
    handle: {
      stop: () => {},
      getSessionId: () => null,
      setSessionId: () => {},
    },
  };

  await handleCommand('/mode', mockEnv as any);
  assert.ok(selectCalled, 'select popup was invoked');
  assert.equal(agent.sessionState.mode, 'research', 'Mode updated to research in-memory');
  assert.equal(config.mode, 'beginner', 'config.json / AgentConfig was NOT modified');
});

test('Fase 1: /mode cancelled via popup does not change sessionState (no side effect)', async () => {
  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const provider = new MockSequenceProvider(['ok']);
  const agent = new Agent(ctx, provider, config);
  agent.sessionState.mode = 'code';

  const mockEnv = {
    ctx,
    config,
    llm: provider,
    agent,
    sessionState: agent.sessionState,
    confirm: async () => true,
    select: async () => null, // Esc / cancelled
    updateConfig: () => {},
    handle: {
      stop: () => {},
      getSessionId: () => null,
      setSessionId: () => {},
    },
  };

  await handleCommand('/mode', mockEnv as any);
  assert.equal(agent.sessionState.mode, 'code', 'Mode unchanged after cancellation');
});

test('Fase 1: direct argument /mode sets mode directly', async () => {
  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const provider = new MockSequenceProvider(['ok']);
  const agent = new Agent(ctx, provider, config);

  const mockEnv = {
    ctx,
    config,
    llm: provider,
    agent,
    sessionState: agent.sessionState,
    confirm: async () => true,
    updateConfig: () => {},
    handle: {
      stop: () => {},
      getSessionId: () => null,
      setSessionId: () => {},
    },
  };

  await handleCommand('/mode build', mockEnv as any);
  assert.equal(agent.sessionState.mode, 'build');
  assert.equal(agent.sessionState.buildPhase, 'explore');

  await handleCommand('/mode code', mockEnv as any);
  assert.equal(agent.sessionState.mode, 'code');
});

test('Fase 1: /new resets sessionState.mode to default and buildPhase to explore', async () => {
  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const provider = new MockSequenceProvider(['ok']);
  const agent = new Agent(ctx, provider, config);
  agent.sessionState.mode = 'research';
  agent.sessionState.buildPhase = 'mutate';

  const mockEnv = {
    ctx,
    config,
    llm: provider,
    agent,
    sessionState: agent.sessionState,
    confirm: async () => true,
    updateConfig: () => {},
    handle: {
      stop: () => {},
      getSessionId: () => 'prev-session',
      setSessionId: () => {},
    },
  };

  await handleCommand('/new', mockEnv as any);
  assert.equal(agent.sessionState.mode, 'default', 'Mode reset to default on new session');
  assert.equal(agent.sessionState.buildPhase, 'explore', 'buildPhase reset to explore on new session');
});

// ============================================================================
// FASE 1 Tests: Loop Detector Parameter Injection per Mode
// ============================================================================

test('Fase 1: Whitelist tool read-only matches official specification', () => {
  assert.ok(IDEMPOTENT_READ_TOOLS.has('read_file'));
  assert.ok(IDEMPOTENT_READ_TOOLS.has('glob'));
  assert.ok(IDEMPOTENT_READ_TOOLS.has('list_dir'));
  assert.ok(IDEMPOTENT_READ_TOOLS.has('code_search'));
  assert.ok(IDEMPOTENT_READ_TOOLS.has('read_process_logs'));
});

test('Fase 1: Mutating tools for Build mode match official specification', () => {
  assert.ok(BUILD_MUTATING_TOOLS.has('write_file'));
  assert.ok(BUILD_MUTATING_TOOLS.has('edit_file'));
  assert.ok(BUILD_MUTATING_TOOLS.has('patch_file'));
  assert.ok(BUILD_MUTATING_TOOLS.has('delete_file'));
  assert.ok(BUILD_MUTATING_TOOLS.has('exec'));
});

test('Fase 1: Loop detector in Default mode halts on repeated read_file > 2', async () => {
  const identicalCall = '```tool\n{"tool": "read_file", "path": "stuck.txt"}\n```';
  const provider = new MockSequenceProvider([
    identicalCall,
    identicalCall,
    identicalCall,
    identicalCall,
  ]);

  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  agent.sessionState.mode = 'default';

  const result = await agent.handleInstruction('periksa file');
  assert.ok(result.includes('[deteksi loop]'), 'Default mode interrupts loop at default threshold');
});

test('Fase 1: Loop detector in Code mode halts on repeated read_file > 2 without exception', async () => {
  const identicalCall = '```tool\n{"tool": "read_file", "path": "stuck.txt"}\n```';
  const provider = new MockSequenceProvider([
    identicalCall,
    identicalCall,
    identicalCall,
    identicalCall,
  ]);

  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  agent.sessionState.mode = 'code';

  const result = await agent.handleInstruction('periksa file di mode code');
  assert.ok(result.includes('[deteksi loop]'), 'Code mode interrupts loop at default threshold');
});

test('Fase 1: Loop detector in Research mode relaxes threshold for read-only whitelist tools', async () => {
  // In Research mode, read_file repeated 3 times should NOT be halted by loop detection
  const readCall = '```tool\n{"tool": "read_file", "path": "notes.txt"}\n```';
  const provider = new MockSequenceProvider([
    readCall,
    readCall,
    readCall,
    'Riset selesai.',
  ]);

  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  agent.sessionState.mode = 'research';

  const result = await agent.handleInstruction('baca berkas riset');
  assert.equal(result, 'Riset selesai.', 'Research mode relaxed threshold permits repeated reads without halt');
  assert.ok(!result.includes('[deteksi loop]'));
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setWorkspaceRoot } from '../agent/tools.js';

test('Fase 1: Loop detector in Research mode still halts on mutating tools at default threshold', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-test-fase1-'));
  setWorkspaceRoot(tmp);
  try {
    const writeCall = '```tool\n{"tool": "write_file", "path": "out.txt", "content": "abc"}\n```';
    const provider = new MockSequenceProvider([
      writeCall,
      writeCall,
      writeCall,
      writeCall,
    ]);

    const config = { ...DEFAULT_CONFIG };
    const ctx = new Context(config);
    const agent = new Agent(ctx, provider, config, async () => true, tmp);
    agent.sessionState.mode = 'research';

    const result = await agent.handleInstruction('tulis file');
    assert.ok(result.includes('[deteksi loop]'), 'Research mode does NOT relax mutating tools');
  } finally {
    setWorkspaceRoot(null);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Fase 1: Build mode starts in explore phase (relaxed) and transitions permanently to mutate phase (strict) upon mutating tool', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-test-fase1-build-'));
  setWorkspaceRoot(tmp);
  try {
    const config = { ...DEFAULT_CONFIG };
    const ctx = new Context(config);
    const provider = new MockSequenceProvider(['ok']);
    const agent = new Agent(ctx, provider, config, async () => true, tmp);
    agent.sessionState.mode = 'build';
    agent.sessionState.buildPhase = 'explore';

    // In explore phase: read_file gets relaxed parameters
    const exploreParams = agent.getLoopDetectorParams('read_file');
    assert.equal(exploreParams.readOnlyRelaxed, true, 'Explore phase provides relaxed read-only threshold');
    assert.equal(exploreParams.loopThreshold, 10);

    // Executing a read-only tool keeps explore phase
    const readTurnProvider = new MockSequenceProvider([
      '```tool\n{"tool": "read_file", "path": "app.ts"}\n```',
      'Hasil baca.',
    ]);
    const agentWithRead = new Agent(ctx, readTurnProvider, config, async () => true, tmp);
    agentWithRead.sessionState.mode = 'build';
    agentWithRead.sessionState.buildPhase = 'explore';
    await agentWithRead.handleInstruction('baca app.ts');
    assert.equal(agentWithRead.sessionState.buildPhase, 'explore', 'Still in explore phase after read_file');

    // Now execute a mutating tool (write_file) -> must switch permanently to mutate phase
    const mutateTurnProvider = new MockSequenceProvider([
      '```tool\n{"tool": "write_file", "path": "output.txt", "content": "123"}\n```',
      'Tulis selesai.',
    ]);
    agentWithRead.setLlmProvider(mutateTurnProvider);
    await agentWithRead.handleInstruction('tulis output.txt');
    assert.equal(agentWithRead.sessionState.buildPhase, 'mutate', 'buildPhase transitioned permanently to mutate');

    // Once in mutate phase: read_file now gets strict parameters (no relaxation)
    const mutateParams = agentWithRead.getLoopDetectorParams('read_file');
    assert.equal(mutateParams.readOnlyRelaxed, false, 'Mutate phase is strict');
    assert.equal(mutateParams.loopThreshold, 2, 'Mutate phase uses strict default loopThreshold 2');
  } finally {
    setWorkspaceRoot(null);
    rmSync(tmp, { recursive: true, force: true });
  }
});
