import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateOpenAiMessages } from '../agent/llm.js';

test('Item 4: valid tool sequence is preserved in order', () => {
  const input = [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: 'I will call tools',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'call_2', type: 'function', function: { name: 'exec', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'result 1', name: 'read_file' },
    { role: 'tool', tool_call_id: 'call_2', content: 'result 2', name: 'exec' },
  ];

  const validated = validateOpenAiMessages(input);
  assert.equal(validated.length, 4);
  assert.equal(validated[2].role, 'tool');
  assert.equal(validated[2].tool_call_id, 'call_1');
  assert.equal(validated[3].role, 'tool');
  assert.equal(validated[3].tool_call_id, 'call_2');
});

test('Item 4: missing tool response is synthesized to preserve invariant', () => {
  const input = [
    { role: 'user', content: 'run commands' },
    {
      role: 'assistant',
      content: 'Calling 2 tools',
      tool_calls: [
        { id: 'call_A', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'call_B', type: 'function', function: { name: 'edit_file', arguments: '{}' } },
      ],
    },
    // Only call_A was answered; call_B was omitted (e.g. aborted or errored)
    { role: 'tool', tool_call_id: 'call_A', content: 'result A' },
  ];

  const validated = validateOpenAiMessages(input);
  assert.equal(validated.length, 4, 'Must synthesize missing tool response');
  assert.equal(validated[2].tool_call_id, 'call_A');
  assert.equal(validated[3].tool_call_id, 'call_B');
  assert.equal(validated[3].role, 'tool');
  assert.ok(validated[3].content?.includes('call_B') || validated[3].content?.includes('edit_file'));
});

test('Item 4: out-of-order tool responses are reordered to match tool_calls order', () => {
  const input = [
    {
      role: 'assistant',
      content: 'Call two',
      tool_calls: [
        { id: 'call_first', type: 'function', function: { name: 't1' } },
        { id: 'call_second', type: 'function', function: { name: 't2' } },
      ],
    },
    // Reversed responses in history
    { role: 'tool', tool_call_id: 'call_second', content: 'res 2' },
    { role: 'tool', tool_call_id: 'call_first', content: 'res 1' },
  ];

  const validated = validateOpenAiMessages(input);
  assert.equal(validated.length, 3);
  assert.equal(validated[1].tool_call_id, 'call_first', 'First tool response must follow tool_calls order');
  assert.equal(validated[2].tool_call_id, 'call_second', 'Second tool response must follow tool_calls order');
});

type TestMessage = { role: string; content?: string | null; tool_calls?: any[]; tool_call_id?: string; name?: string };

test('Item 4: assistant message with tool_calls followed by user message gets tool responses filled before user message', () => {
  const input: TestMessage[] = [
    {
      role: 'assistant',
      content: 'Interrupted',
      tool_calls: [
        { id: 'call_pending', type: 'function', function: { name: 'exec' } },
      ],
    },
    { role: 'user', content: 'New user prompt before tool completed' },
  ];

  const validated = validateOpenAiMessages(input);
  assert.equal(validated.length, 3);
  assert.equal(validated[0].role, 'assistant');
  assert.equal(validated[1].role, 'tool');
  assert.equal(validated[1].tool_call_id, 'call_pending');
  assert.equal(validated[2].role, 'user');
});

test('Item 4: orphan tool messages without preceding assistant tool_calls are dropped', () => {
  const input = [
    { role: 'user', content: 'hello' },
    { role: 'tool', tool_call_id: 'orphan_call', content: 'orphan result' },
  ];

  const validated = validateOpenAiMessages(input);
  assert.equal(validated.length, 1);
  assert.equal(validated[0].role, 'user');
});
