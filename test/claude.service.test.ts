import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HumanMessage,
  AIMessage,
  ToolMessage,
} from '@langchain/core/messages';

// The ClaudeService constructor requires an API key; set a dummy one before the
// module (and its singleton) is loaded via dynamic import.
process.env.ANTHROPIC_API_KEY = 'test-key';

async function newService() {
  const { ClaudeService } = await import('../src/services/claude.service');
  return new ClaudeService();
}

test('convertTools maps each tool to the Anthropic shape', async () => {
  const service = await newService();
  const tools = [
    {
      name: 'read_file',
      description: 'Read a file',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ];

  const result = service.convertTools(tools);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'read_file');
  assert.equal(result[0].description, 'Read a file');
  assert.equal(result[0].input_schema.type, 'object');
  assert.deepEqual(result[0].input_schema.required, ['path']);
});

test('convertTools falls back to an object schema when inputSchema is not an object', async () => {
  const service = await newService();
  const result = service.convertTools([
    { name: 'noop', description: '', inputSchema: undefined as any },
  ]);
  assert.deepEqual(result[0].input_schema, { type: 'object', properties: {} });
});

test('convertMessages builds tool_use blocks from an AIMessage', async () => {
  const service: any = await newService();
  const ai = new AIMessage({
    content: 'Let me check that.',
    tool_calls: [
      {
        id: 'toolu_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"/a"}' },
      },
    ] as any,
  });

  const [msg] = service.convertMessages([ai]);

  assert.equal(msg.role, 'assistant');
  assert.equal(msg.content[0].type, 'text');
  assert.equal(msg.content[1].type, 'tool_use');
  assert.equal(msg.content[1].id, 'toolu_1');
  assert.deepEqual(msg.content[1].input, { path: '/a' });
});

test('convertMessages drops a tool_result whose tool_use was truncated out of history', async () => {
  const service: any = await newService();
  // An orphaned tool result (no preceding tool_use) — would 400 if sent.
  const orphan = new ToolMessage({
    content: 'stale result',
    tool_call_id: 'toolu_missing',
    name: 'read_file',
  });
  const user = new HumanMessage('hello');

  const result = service.convertMessages([orphan, user]);

  // Only the user message survives; the orphan is filtered out.
  assert.equal(result.length, 1);
  assert.equal(result[0].role, 'user');
  assert.equal(result[0].content, 'hello');
});

test('convertMessages keeps a tool_result that matches a prior tool_use', async () => {
  const service: any = await newService();
  const ai = new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'toolu_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      },
    ] as any,
  });
  const toolResult = new ToolMessage({
    content: 'file contents',
    tool_call_id: 'toolu_1',
    name: 'read_file',
  });

  const result = service.convertMessages([ai, toolResult]);

  assert.equal(result.length, 2);
  assert.equal(result[1].role, 'user');
  assert.equal(result[1].content[0].type, 'tool_result');
  assert.equal(result[1].content[0].tool_use_id, 'toolu_1');
});
