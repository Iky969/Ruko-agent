import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '../core/context.js';
import { AgentConfig } from '../types.js';

test('Context trajectory - preserves intermediate tool call messages', () => {
  const config: AgentConfig = { maxContextChars: 1000 } as AgentConfig;
  const ctx = new Context(config);

  ctx.add('user', 'What is the date today?');
  
  ctx.addToolCall('get_date', { timezone: 'UTC' });
  ctx.addToolResult('get_date', '2026-09-22');
  
  ctx.add('assistant', 'The date is 2026-09-22.');

  const messages = ctx.toJSON();
  
  assert.equal(messages.length, 4, 'Should contain exactly 4 messages');
  
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'What is the date today?');
  
  assert.equal(messages[1].role, 'tool_call');
  const parsedToolCall = JSON.parse(messages[1].content);
  assert.equal(parsedToolCall.tool, 'get_date');
  assert.deepEqual(parsedToolCall.args, { timezone: 'UTC' });
  
  assert.equal(messages[2].role, 'tool');
  assert.equal(messages[2].content, '[get_date] 2026-09-22');
  
  assert.equal(messages[3].role, 'assistant');
  assert.equal(messages[3].content, 'The date is 2026-09-22.');
  
  // Verify timestamps exist and are roughly chronological
  assert.ok(messages[0].timestamp <= messages[1].timestamp);
  assert.ok(messages[1].timestamp <= messages[2].timestamp);
  assert.ok(messages[2].timestamp <= messages[3].timestamp);
});
