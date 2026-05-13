// Anthropic provider tool-call roundtrip test.
//
// Uses Node's built-in mock to swap the SDK client with a hand-rolled
// stream that emits a tool_use block, then on the SECOND call emits text
// only. Verifies the provider:
//   - yields tool_use events with the executed result, and
//   - feeds tool_result back into the next turn, and
//   - terminates with `done` when no more tool_uses are emitted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider } from '../../src/lib/runtimes/ask-my-agent/providers/anthropic.js';

/**
 * Build a fake `messages.stream(...)` return value: it must be async
 * iterable AND expose a `finalMessage()` method, just like the real SDK.
 */
function fakeStream({ events, finalContent }) {
  let iterated = false;
  return {
    async *[Symbol.asyncIterator]() {
      iterated = true;
      for (const evt of events) yield evt;
    },
    async finalMessage() {
      // Match the real SDK shape: { content: ContentBlock[], stop_reason }
      if (!iterated) {
        // The real SDK lets you await finalMessage without iterating;
        // we don't bother emulating that path here since the provider
        // always iterates.
      }
      return { content: finalContent, stop_reason: 'end_turn' };
    },
  };
}

test('AnthropicProvider: tool_use → execute → continue → done', async () => {
  // Two turns. Turn 1 emits one tool_use; turn 2 emits plain text and ends.
  const turn1Events = [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'agentdm__read_messages' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"count' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '": 5}' },
    },
    { type: 'content_block_stop', index: 0 },
  ];
  const turn1Final = [
    { type: 'tool_use', id: 'toolu_1', name: 'agentdm__read_messages', input: { count: 5 } },
  ];

  const turn2Events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'You have ' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '0 messages.' },
    },
    { type: 'content_block_stop', index: 0 },
  ];
  const turn2Final = [{ type: 'text', text: 'You have 0 messages.' }];

  let turn = 0;
  const fakeClient = {
    messages: {
      stream(params) {
        turn += 1;
        // Sanity-check: tools were forwarded with the Anthropic schema.
        if (turn === 1) {
          assert.equal(params.tools.length, 1);
          assert.equal(params.tools[0].name, 'agentdm__read_messages');
          assert.equal(params.messages.length, 1);
          return fakeStream({ events: turn1Events, finalContent: turn1Final });
        }
        // Turn 2: the assistant message from turn 1 + the tool_result user
        // turn should have been pushed into messages.
        assert.equal(params.messages.length, 3);
        assert.equal(params.messages[1].role, 'assistant');
        assert.equal(params.messages[2].role, 'user');
        const toolResult = params.messages[2].content[0];
        assert.equal(toolResult.type, 'tool_result');
        assert.equal(toolResult.tool_use_id, 'toolu_1');
        assert.equal(toolResult.content, 'no new messages');
        return fakeStream({ events: turn2Events, finalContent: turn2Final });
      },
    },
  };

  const provider = new AnthropicProvider({ model: 'test-model' });
  provider._client = fakeClient;

  const calls = [];
  const callTool = async (name, input) => {
    calls.push({ name, input });
    return 'no new messages';
  };

  const events = [];
  for await (const evt of provider.chat(
    [{ role: 'user', content: 'how many messages do I have?' }],
    [
      {
        name: 'agentdm__read_messages',
        description: 'Read inbox',
        input_schema: { type: 'object', properties: {} },
      },
    ],
    callTool,
  )) {
    events.push(evt);
  }

  // Provider invoked the tool exactly once with parsed args.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'agentdm__read_messages');
  assert.deepEqual(calls[0].input, { count: 5 });

  // Event stream contains tokens + tool_use + done.
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['tool_use', 'token', 'token', 'done']);

  const toolEvt = events.find((e) => e.type === 'tool_use');
  assert.equal(toolEvt.name, 'agentdm__read_messages');
  assert.equal(toolEvt.result, 'no new messages');

  const tokens = events.filter((e) => e.type === 'token').map((e) => e.delta).join('');
  assert.equal(tokens, 'You have 0 messages.');
});

test('AnthropicProvider: no tool_use → single turn, just text', async () => {
  const fakeClient = {
    messages: {
      stream() {
        return fakeStream({
          events: [
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'hello' },
            },
          ],
          finalContent: [{ type: 'text', text: 'hello' }],
        });
      },
    },
  };

  const provider = new AnthropicProvider({ model: 'test-model' });
  provider._client = fakeClient;

  const events = [];
  for await (const evt of provider.chat([{ role: 'user', content: 'hi' }], [])) {
    events.push(evt);
  }

  assert.deepEqual(
    events.map((e) => e.type),
    ['token', 'done'],
  );
});

test('AnthropicProvider: tool callback throws → tool_result carries the error', async () => {
  const stream = fakeStream({
    events: [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_x', name: 'gh__nope' },
      },
      { type: 'content_block_stop', index: 0 },
    ],
    finalContent: [{ type: 'tool_use', id: 'toolu_x', name: 'gh__nope', input: {} }],
  });

  const stream2 = fakeStream({
    events: [
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'sorry, can\'t do that' },
      },
    ],
    finalContent: [{ type: 'text', text: 'sorry' }],
  });

  let call = 0;
  const fakeClient = {
    messages: {
      stream(params) {
        call += 1;
        if (call === 1) return stream;
        // Verify the error was fed back as a tool_result with is_error.
        const lastUser = params.messages[params.messages.length - 1];
        assert.equal(lastUser.role, 'user');
        assert.equal(lastUser.content[0].type, 'tool_result');
        assert.equal(lastUser.content[0].is_error, true);
        assert.match(lastUser.content[0].content, /Tool error: /);
        return stream2;
      },
    },
  };

  const provider = new AnthropicProvider({ model: 'test' });
  provider._client = fakeClient;

  const failing = async () => {
    throw new Error('boom');
  };
  const events = [];
  for await (const evt of provider.chat(
    [{ role: 'user', content: 'do it' }],
    [],
    failing,
  )) {
    events.push(evt);
  }
  assert.equal(call, 2);
  const toolEvt = events.find((e) => e.type === 'tool_use');
  assert.match(toolEvt.result, /Tool error: boom/);
});
