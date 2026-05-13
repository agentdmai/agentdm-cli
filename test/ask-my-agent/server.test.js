// Tests for ask-my-agent server helpers + tool-call routing.
//
// Uses Node's built-in `node:test` (Node ≥18). Run with:
//
//   node --test test/ask-my-agent/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMessages,
  extractToolText,
  buildCallTool,
  defaultWakeUrlFor,
} from '../../src/lib/runtimes/ask-my-agent/server.js';

// ---- extractMessages: shape tolerance ----------------------------------

test('extractMessages: bare array shape', () => {
  const result = {
    content: [{ type: 'text', text: JSON.stringify([{ id: 1 }, { id: 2 }]) }],
  };
  assert.deepEqual(extractMessages(result), [{ id: 1 }, { id: 2 }]);
});

test('extractMessages: wrapped { messages, hasMore } shape', () => {
  const result = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ messages: [{ id: 1 }], hasMore: false }),
      },
    ],
  };
  assert.deepEqual(extractMessages(result), [{ id: 1 }]);
});

test('extractMessages: single-object shape', () => {
  const result = {
    content: [{ type: 'text', text: JSON.stringify({ id: 1, message: 'hi' }) }],
  };
  assert.deepEqual(extractMessages(result), [{ id: 1, message: 'hi' }]);
});

test('extractMessages: empty content returns []', () => {
  assert.deepEqual(extractMessages({ content: [] }), []);
  assert.deepEqual(extractMessages(null), []);
});

test('extractMessages: malformed JSON skipped, returns []', () => {
  const result = { content: [{ type: 'text', text: '{not json' }] };
  assert.deepEqual(extractMessages(result), []);
});

// ---- extractToolText ---------------------------------------------------

test('extractToolText: joins text blocks', () => {
  const result = {
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ],
  };
  assert.equal(extractToolText(result), 'hello\nworld');
});

test('extractToolText: surfaces isError as a tool error message', () => {
  const result = {
    isError: true,
    content: [{ type: 'text', text: 'recipient not found' }],
  };
  assert.match(extractToolText(result), /Tool reported error: recipient not found/);
});

test('extractToolText: falls back to JSON for non-text content', () => {
  const result = {
    content: [{ type: 'image', data: '...' }],
  };
  const out = extractToolText(result);
  assert.ok(out.includes('image'));
});

// ---- buildCallTool: prefix routing -------------------------------------

test('buildCallTool: routes agentdm__ to the agentdm session', async () => {
  const calls = [];
  const agentdm = {
    callTool: async (args) => {
      calls.push({ session: 'agentdm', ...args });
      return { content: [{ type: 'text', text: 'agentdm-result' }] };
    },
  };
  const callTool = buildCallTool({ agentdm, github: null });
  const out = await callTool('agentdm__read_messages', { foo: 1 });
  assert.equal(out, 'agentdm-result');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    session: 'agentdm',
    name: 'read_messages',
    arguments: { foo: 1 },
  });
});

test('buildCallTool: routes gh__ to the github session', async () => {
  const calls = [];
  const agentdm = { callTool: async () => ({ content: [] }) };
  const github = {
    callTool: async (args) => {
      calls.push(args);
      return { content: [{ type: 'text', text: 'gh-result' }] };
    },
  };
  const callTool = buildCallTool({ agentdm, github });
  const out = await callTool('gh__get_file_contents', { path: 'README.md' });
  assert.equal(out, 'gh-result');
  assert.deepEqual(calls[0], {
    name: 'get_file_contents',
    arguments: { path: 'README.md' },
  });
});

test('buildCallTool: rejects gh__ when github session is null', async () => {
  const agentdm = { callTool: async () => ({ content: [] }) };
  const callTool = buildCallTool({ agentdm, github: null });
  await assert.rejects(
    () => callTool('gh__anything', {}),
    /GitHub MCP is not configured/,
  );
});

test('buildCallTool: rejects unknown prefix', async () => {
  const agentdm = { callTool: async () => ({ content: [] }) };
  const callTool = buildCallTool({ agentdm, github: null });
  await assert.rejects(
    () => callTool('unknown__tool', {}),
    /Unknown tool prefix/,
  );
});

test('buildCallTool: rejects non-string tool name', async () => {
  const agentdm = { callTool: async () => ({ content: [] }) };
  const callTool = buildCallTool({ agentdm, github: null });
  await assert.rejects(() => callTool(undefined, {}), /tool name must be a string/);
});

test('buildCallTool: tolerates missing/non-object input', async () => {
  const agentdm = {
    callTool: async (args) => {
      // Should always receive an object, never undefined or a scalar.
      assert.equal(typeof args.arguments, 'object');
      assert.ok(args.arguments !== null);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  const callTool = buildCallTool({ agentdm, github: null });
  await callTool('agentdm__noop', undefined);
  await callTool('agentdm__noop', 'not-an-object');
});

// ---- defaultWakeUrlFor -------------------------------------------------

test('defaultWakeUrlFor: prod api.agentdm.ai → app.agentdm.ai', () => {
  assert.equal(
    defaultWakeUrlFor('https://api.agentdm.ai/mcp/v1/grid'),
    'https://app.agentdm.ai/api/agents/wake-stream',
  );
});

test('defaultWakeUrlFor: localhost :3001 → :3000', () => {
  assert.equal(
    defaultWakeUrlFor('http://localhost:3001/mcp/v1/grid'),
    'http://localhost:3000/api/agents/wake-stream',
  );
  assert.equal(
    defaultWakeUrlFor('http://127.0.0.1:3001/mcp/v1/grid'),
    'http://127.0.0.1:3000/api/agents/wake-stream',
  );
});

test('defaultWakeUrlFor: falls back to same-origin for unknown hosts', () => {
  assert.equal(
    defaultWakeUrlFor('https://grid.example.com/mcp'),
    'https://grid.example.com/api/agents/wake-stream',
  );
});

test('defaultWakeUrlFor: malformed URL falls back to prod', () => {
  assert.equal(
    defaultWakeUrlFor('not-a-url'),
    'https://app.agentdm.ai/api/agents/wake-stream',
  );
});
