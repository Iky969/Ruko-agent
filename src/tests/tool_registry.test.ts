import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../agent/tool-registry.js';

test('ToolRegistry - register and get', () => {
  const registry = new ToolRegistry();
  const entry = {
    definition: {
      type: 'function' as const,
      function: {
        name: 'test_tool',
        description: 'Test description',
        parameters: { type: 'object', properties: {} }
      }
    },
    handler: async () => 'test result',
    source: 'builtin' as const
  };

  registry.register(entry);
  assert.equal(registry.has('test_tool'), true);
  assert.equal(registry.get('test_tool'), entry);
  assert.equal(registry.size, 1);
});

test('ToolRegistry - unregister', () => {
  const registry = new ToolRegistry();
  const entry = {
    definition: {
      type: 'function' as const,
      function: {
        name: 'test_tool',
        description: 'Test description',
        parameters: { type: 'object', properties: {} }
      }
    },
    handler: async () => 'test result',
    source: 'builtin' as const
  };

  registry.register(entry);
  const result = registry.unregister('test_tool');
  assert.equal(result, true);
  assert.equal(registry.has('test_tool'), false);
  assert.equal(registry.size, 0);
  
  const result2 = registry.unregister('not_found');
  assert.equal(result2, false);
});

test('ToolRegistry - getDefinitions', () => {
  const registry = new ToolRegistry();
  const entry1 = {
    definition: {
      type: 'function' as const,
      function: { name: 'tool1', description: 'desc1', parameters: {} }
    },
    handler: async () => '',
    source: 'builtin' as const
  };
  const entry2 = {
    definition: {
      type: 'function' as const,
      function: { name: 'tool2', description: 'desc2', parameters: {} }
    },
    handler: async () => '',
    source: 'external' as const
  };

  registry.register(entry1);
  registry.register(entry2);

  const all = registry.getDefinitions();
  assert.equal(all.length, 2);

  const builtin = registry.getDefinitions({ source: 'builtin' });
  assert.equal(builtin.length, 1);
  assert.equal(builtin[0].function.name, 'tool1');

  const external = registry.getDefinitions({ source: 'external' });
  assert.equal(external.length, 1);
  assert.equal(external[0].function.name, 'tool2');
});

test('ToolRegistry - getNames', () => {
  const registry = new ToolRegistry();
  registry.register({
    definition: { type: 'function', function: { name: 'tool1', description: '', parameters: {} } },
    handler: async () => '',
    source: 'builtin'
  });
  assert.deepEqual(registry.getNames(), ['tool1']);
});

test('ToolRegistry - execute registered tool', async () => {
  const registry = new ToolRegistry();
  registry.register({
    definition: { type: 'function', function: { name: 'tool1', description: '', parameters: {} } },
    handler: async (call, ctx) => `result for ${call.tool}`,
    source: 'builtin'
  });

  const result = await registry.execute({ tool: 'tool1', parameters: {} }, { config: {} });
  assert.equal(result, 'result for tool1');
});

test('ToolRegistry - execute unregistered tool returns error', async () => {
  const registry = new ToolRegistry();
  const result = await registry.execute({ tool: 'missing', parameters: {} }, { config: {} });
  assert.equal(result, 'Error: Tool "missing" tidak ditemukan dalam registry.');
});

test('ToolRegistry - list', () => {
  const registry = new ToolRegistry();
  registry.register({
    definition: { type: 'function', function: { name: 'tool1', description: 'desc1', parameters: {} } },
    handler: async () => '',
    source: 'builtin'
  });
  
  const list = registry.list();
  assert.deepEqual(list, [
    { name: 'tool1', description: 'desc1', source: 'builtin' }
  ]);
});
