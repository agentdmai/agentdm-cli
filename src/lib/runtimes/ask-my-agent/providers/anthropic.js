// Anthropic strategy.
//
// Streams text deltas from `messages.stream` and drives a multi-turn loop
// when the model emits tool_use blocks. The server supplies `callTool` so
// the provider can resolve a tool name → MCP session itself; control
// returns to the server only as a stream of:
//
//   { type: 'token', delta }              — text fragments (yielded live)
//   { type: 'tool_use', id, name, input, result }   — after each tool runs
//   { type: 'done' }
//
// ANTHROPIC_API_KEY is picked up from process.env by the SDK.

import Anthropic from '@anthropic-ai/sdk';

const MAX_TOOL_TURNS = 10;

export class AnthropicProvider {
  constructor({ model = 'claude-sonnet-4-6' } = {}) {
    this.model = model;
    this._client = null;
  }

  _getClient() {
    if (!this._client) this._client = new Anthropic();
    return this._client;
  }

  /**
   * @param {Array} messages   initial chat history; the provider appends
   *                           assistant + tool_result turns internally.
   * @param {Array} tools      MCP-aggregated tool descriptors
   *                           ({ name, description, input_schema }).
   * @param {(name: string, input: object) => Promise<string>} [callTool]
   *                           server-supplied tool dispatcher. Optional;
   *                           without it, tool calls are ignored.
   */
  async *chat(messages, tools, callTool) {
    const client = this._getClient();
    // Anthropic takes `system` as a top-level param, not as a role in the
    // messages array. Pull any role: 'system' entries out and concatenate
    // them; everything else flows into the conversation as-is.
    const systemParts = [];
    const conversation = [];
    for (const m of messages) {
      if (m.role === 'system' && typeof m.content === 'string') {
        systemParts.push(m.content);
      } else {
        conversation.push(m);
      }
    }
    const systemText = systemParts.join('\n');

    const anthropicTools = (tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.input_schema ?? { type: 'object', properties: {} },
    }));

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
      const params = {
        model: this.model,
        max_tokens: 1024,
        messages: conversation,
      };
      if (systemText) params.system = systemText;
      if (anthropicTools.length > 0) params.tools = anthropicTools;

      const stream = client.messages.stream(params);

      // Track tool_use blocks streamed in this turn, keyed by content-block
      // index since input arrives as JSON deltas across multiple events.
      const partialToolUses = new Map();

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') {
            partialToolUses.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              jsonText: '',
            });
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta') {
            const delta = event.delta.text;
            if (delta) yield { type: 'token', delta };
          } else if (event.delta?.type === 'input_json_delta') {
            const slot = partialToolUses.get(event.index);
            if (slot) slot.jsonText += event.delta.partial_json ?? '';
          }
        }
      }

      const final = await stream.finalMessage();

      // Push the assistant turn (text + tool_use blocks) into history so a
      // follow-up turn can reference it.
      conversation.push({ role: 'assistant', content: final.content });

      const toolUseBlocks = final.content.filter((b) => b.type === 'tool_use');
      if (toolUseBlocks.length === 0 || !callTool) {
        yield { type: 'done' };
        return;
      }

      // Execute every tool_use block; append all results as one user turn
      // (Anthropic requires tool_result blocks grouped in one user message).
      const toolResults = [];
      for (const tu of toolUseBlocks) {
        let resultText;
        let isError = false;
        try {
          const r = await callTool(tu.name, tu.input);
          resultText = typeof r === 'string' ? r : JSON.stringify(r);
        } catch (err) {
          resultText = `Tool error: ${err?.message ?? String(err)}`;
          isError = true;
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: resultText,
          ...(isError ? { is_error: true } : {}),
        });
        yield {
          type: 'tool_use',
          id: tu.id,
          name: tu.name,
          input: tu.input,
          result: resultText,
        };
      }
      conversation.push({ role: 'user', content: toolResults });
    }

    // Safety: too many tool turns. Surface a final note so the caller sees
    // the conversation didn't terminate cleanly.
    yield {
      type: 'token',
      delta: '\n\n(stopped after ' + MAX_TOOL_TURNS + ' tool turns)',
    };
    yield { type: 'done' };
  }
}
