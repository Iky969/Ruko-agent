// Regression tests for the thought-leak + overthinking bug reported by Beverly
// 2026-11-23 ~13:26 WIB (Ollama mimo-v2.6-heretic:9b, native thinking):
// the model's internal deliberation leaked into the visible answer, every line
// prefixed with `}...`, and the agent spun deliberating whether to emit a tool
// call or a final answer without ever acting. The thought-loop breaker (PR #48)
// never fired because the leaked lines counted as visible "content".
//
// Also covers the same session's malformed tool block (2026-11-23 ~13:29 WIB):
// a `read_file` call failed because its closing tag was garbled as `()>/tool>`.
// The JSON was valid; only the closing tag was broken, yet parseToolCalls
// discarded the whole call as malformed instead of repairing the close.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent, DeliberationLineRouter, isBareDeliberation } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { ChatOptions, LLMProvider } from '../agent/llm.js';
import { parseToolCalls, stripToolBlocks } from '../agent/tools.js';
import { RevealFilter } from '../core/ui.js';
import { ContextMessage, DEFAULT_CONFIG } from '../types.js';

// The leaked deliberation from the screenshot (verbatim lines).
const LEAKED_DELIBERATION = [
  '}... End.',
  '}... Hmm I\'m stuck in analysis. Break.',
  '}... I will now write the tool call.',
  '}... final content: fenced block.',
  '}... go.',
  '}... Okay.',
  '}... (This is absurd).',
  '}... Just output.',
  '}... Done.',
  '}... I need to actually produce assistant final.',
  '}... Now.',
  '}... Let\'s do.',
  '}... I think I\'m overthinking due to tool discipline.',
  '}... Final:',
  '}... No more.',
  '}... Proceed.',
  '}... (end analysis)',
  '}... Wait I can\'t "end analysis" programmatically; I just choose final channel.',
  '}... Do that.',
].join('\n');

// Mock provider that streams a native-reasoning chunk (onThought) and then
// leaks bare deliberation as visible content (onToken), exactly like the
// reported Ollama session.
class LeakingProvider implements LLMProvider {
  readonly name = 'leaking-mock';
  readonly isConfigured = true;
  model = 'mock-model';
  lastFinishReason: string | null = 'stop';
  receivedMessages: ContextMessage[][] = [];
  private calls = 0;

  constructor(private readonly replies: Array<string | { content: string; thought?: string }>) {}

  setModel(model: string): void {
    this.model = model;
  }

  async chat(messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    this.receivedMessages.push([...messages]);
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    if (typeof reply === 'string') {
      options?.onToken?.(reply);
      return reply;
    }
    if (reply.thought) options?.onThought?.(reply.thought);
    options?.onToken?.(reply.content);
    return reply.content;
  }
}

test('isBareDeliberation: the screenshot deliberation (all `}...` lines) is bare deliberation', () => {
  assert.equal(isBareDeliberation(LEAKED_DELIBERATION), true);
});

test('isBareDeliberation: plain deliberation without the `}...` prefix is also detected', () => {
  const text = [
    'Hmm I\'m stuck in analysis. Break.',
    'I will now write the tool call.',
    'I need to actually produce assistant final.',
    'I think I\'m overthinking due to tool discipline.',
  ].join('\n');
  assert.equal(isBareDeliberation(text), true);
});

test('isBareDeliberation: a single `}...` line is bare deliberation', () => {
  assert.equal(isBareDeliberation('}... Do that.'), true);
});

test('isBareDeliberation: genuine answers are NOT bare deliberation', () => {
  assert.equal(isBareDeliberation('Halo! Saya siap membantu.'), false);
  assert.equal(
    isBareDeliberation('Audit selesai: 3 file diperiksa, tidak ada temuan kritis.'),
    false,
  );
  // A short one-word answer must not be mistaken for a filler turn.
  assert.equal(isBareDeliberation('Done.'), false);
  assert.equal(isBareDeliberation('Sudah.'), false);
});

test('isBareDeliberation: deliberation followed by a real answer is NOT bare deliberation', () => {
  const text = [
    '}... I will now write the tool call.',
    'Audit selesai: PROGRESS.md berisi 3 bagian dan tidak ada temuan kritis.',
  ].join('\n');
  assert.equal(isBareDeliberation(text), false);
});

test('isBareDeliberation: empty / whitespace-only text is not bare deliberation', () => {
  assert.equal(isBareDeliberation(''), false);
  assert.equal(isBareDeliberation('   \n  '), false);
});

test('Agent: leaked deliberation must NOT be returned as the final answer; the breaker must fire after 4 deliberation-only turns', async () => {
  const origDelay = process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
  process.env.RUKO_THOUGHT_LOOP_DELAY_MS = '10';
  try {
    const provider = new LeakingProvider([
      { content: LEAKED_DELIBERATION, thought: 'planning the audit steps' },
    ]);
    const config = { ...DEFAULT_CONFIG, maxToolIterations: 10 };
    const ctx = new Context(config);
    const agent = new Agent(ctx, provider, config);

    const result = await agent.handleInstruction('jalankan audit');

    assert.ok(
      !result.includes('I think I\'m overthinking'),
      'Leaked deliberation must not become the final answer',
    );
    assert.ok(
      !result.includes('}...'),
      'No `}...` prefix may survive into the final answer',
    );
    assert.ok(
      result.includes('terjebak dalam thought loop'),
      'The breaker must fire after 4 deliberation-only turns without acting',
    );
    assert.equal(
      provider.receivedMessages.length,
      4,
      'Breaker fires on the 4th deliberation turn (not earlier, not later)',
    );
  } finally {
    if (origDelay !== undefined) {
      process.env.RUKO_THOUGHT_LOOP_DELAY_MS = origDelay;
    } else {
      delete process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
    }
  }
});

test('Agent: deliberation followed by a real answer returns the real answer', async () => {
  const origDelay = process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
  process.env.RUKO_THOUGHT_LOOP_DELAY_MS = '10';
  try {
    const provider = new LeakingProvider([
      { content: LEAKED_DELIBERATION, thought: 'planning the audit steps' },
      'Audit selesai: 3 file diperiksa, tidak ada temuan kritis.',
    ]);
    const config = { ...DEFAULT_CONFIG, maxToolIterations: 10 };
    const ctx = new Context(config);
    const agent = new Agent(ctx, provider, config);

    const result = await agent.handleInstruction('jalankan audit');

    assert.ok(
      result.includes('Audit selesai'),
      'The real answer after the nudge is returned',
    );
    assert.ok(
      !result.includes('I think I\'m overthinking'),
      'The leaked deliberation is not part of the final answer',
    );
  } finally {
    if (origDelay !== undefined) {
      process.env.RUKO_THOUGHT_LOOP_DELAY_MS = origDelay;
    } else {
      delete process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
    }
  }
});

test('DeliberationLineRouter: `}...` lines go to the thought panel, other lines stay visible', () => {
  const visible: string[] = [];
  const thought: string[] = [];
  const router = new DeliberationLineRouter(
    (text) => visible.push(text),
    (text) => thought.push(text),
  );

  router.feed('Halo! Berikut hasil audit:\n');
  router.feed('}... Hmm I\'m stuck in analysis. Break.\n');
  router.feed('}... I will now write the tool call.\n');
  router.feed('Tiga file diperiksa, tidak ada temuan.\n');
  router.feed('}... Do that.'); // partial line, no trailing newline yet
  router.end();

  assert.equal(visible.join(''), 'Halo! Berikut hasil audit:\nTiga file diperiksa, tidak ada temuan.\n');
  assert.equal(
    thought.join(''),
    '}... Hmm I\'m stuck in analysis. Break.\n}... I will now write the tool call.\n}... Do that.',
  );
});

test('DeliberationLineRouter: a `}...` split across chunks is still routed to thought', () => {
  const visible: string[] = [];
  const thought: string[] = [];
  const router = new DeliberationLineRouter(
    (text) => visible.push(text),
    (text) => thought.push(text),
  );

  router.feed('}');
  router.feed('..');
  router.feed('. Do that.\nJawaban akhir.\n');
  router.end();

  assert.equal(visible.join(''), 'Jawaban akhir.\n');
  assert.equal(thought.join(''), '}... Do that.\n');
});

// --- Malformed tool-block close: `()>/tool>` (same session, 13:29 WIB) ---

test('parseToolCalls: a tool block whose closing tag is garbled as `()>/tool>` still parses', () => {
  const result = parseToolCalls(
    '<tool>\n{"tool": "read_file", "path": "PROGRESS.md"}\n()>/tool>',
  );
  assert.deepEqual(result.calls, [{ tool: 'read_file', path: 'PROGRESS.md' }]);
  assert.deepEqual(result.malformedBlocks, []);
});

test('parseToolCalls: a bare `/tool>` close is repaired too', () => {
  const result = parseToolCalls(
    '<tool>\n{"tool": "read_file", "path": "PROGRESS.md"}\n/tool>',
  );
  assert.deepEqual(result.calls, [{ tool: 'read_file', path: 'PROGRESS.md' }]);
  assert.deepEqual(result.malformedBlocks, []);
});

test('parseToolCalls: a well-formed `</tool>` close still parses (no regression)', () => {
  const result = parseToolCalls(
    '<tool>\n{"tool": "read_file", "path": "PROGRESS.md"}\n</tool>',
  );
  assert.deepEqual(result.calls, [{ tool: 'read_file', path: 'PROGRESS.md' }]);
  assert.deepEqual(result.malformedBlocks, []);
});

test('parseToolCalls: invalid JSON inside a garbled close is still malformed (repair does not invent calls)', () => {
  const result = parseToolCalls('<tool>\n{not json}\n()>/tool>');
  assert.deepEqual(result.calls, []);
  assert.equal(result.malformedBlocks.length, 1);
});

test('stripToolBlocks: a tool block with a garbled close is fully removed from the visible reply', () => {
  const text = 'Sebelum.\n<tool>\n{"tool": "read_file", "path": "PROGRESS.md"}\n()>/tool>\nSesudah.';
  const stripped = stripToolBlocks(text);
  assert.ok(!stripped.includes('read_file'), 'Tool JSON must not leak into the visible reply');
  assert.ok(!stripped.includes('()>/tool>'), 'The garbled close must not leak either');
  assert.ok(stripped.includes('Sebelum.'));
  assert.ok(stripped.includes('Sesudah.'));
});

test('RevealFilter: a garbled tool close must not swallow the visible text that follows it', () => {
  const out: string[] = [];
  const filter = new RevealFilter((text) => out.push(text));
  filter.feed('<tool>\n{"tool": "read_file", "path": "PROGRESS.md"}\n()>/tool>\n');
  filter.feed('Audit selesai.\n');
  filter.end();
  assert.equal(out.join(''), 'Audit selesai.\n');
});
