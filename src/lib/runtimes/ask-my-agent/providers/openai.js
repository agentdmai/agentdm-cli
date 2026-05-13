// OpenAI strategy. Same multi-turn tool-use loop as the Anthropic
// provider, expressed in OpenAI's chat-completion shape (tool_calls in
// assistant deltas, tool-role messages for results).
//
// OPENAI_API_KEY is picked up from process.env by the SDK.

import OpenAI from 'openai';

const MAX_TOOL_TURNS = 10;

export class OpenAIProvider {
  constructor({ model = 'gpt-4o-mini' } = {}) {
    this.model = model;
    this._client = null;
  }

  _getClient() {
    if (!this._client) this._client = new OpenAI();
    return this._client;
  }

  /**
   * @param {Array} messages   initial chat history.
   * @param {Array} tools      MCP-aggregated tool descriptors.
   * @param {(name: string, input: object) => Promise<string>} [callTool]
   *                           server-supplied tool dispatcher.
   */
  async *chat(messages, tools, callTool) {
    const client = this._getClient();
    const conversation = [...messages];

    const openaiTools = (tools ?? []).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
      const params = {
        model: this.model,
        messages: conversation,
        stream: true,
      };
      if (openaiTools.length > 0) params.tools = openaiTools;

      const stream = await client.chat.completions.create(params);

      let accumulatedText = '';
      // OpenAI streams tool_calls keyed by .index across multiple chunks.
      // Track each by its index slot.
      const toolCallsByIdx = new Map();
      let finishReason = null;

      for await (const chunk of stream) {
        const choice = chunk?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) {
          yield { type: 'token', delta: delta.content };
          accumulatedText += delta.content;
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            let slot = toolCallsByIdx.get(idx);
            if (!slot) {
              slot = { id: '', name: '', argsText: '' };
              toolCallsByIdx.set(idx, slot);
            }
            if (tc.id) slot.id = slot.id || tc.id;
            if (tc.function?.name) slot.name = slot.name || tc.function.name;
            if (typeof tc.function?.arguments === 'string') {
              slot.argsText += tc.function.arguments;
            }
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }

      const toolCalls = Array.from(toolCallsByIdx.values()).filter((tc) => tc.id);

      // Build the assistant turn message and push to history so follow-up
      // turns can see what was already said.
      const assistantMsg = { role: 'assistant' };
      assistantMsg.content = accumulatedText || null;
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argsText || '{}' },
        }));
      }
      conversation.push(assistantMsg);

      if (toolCalls.length === 0 || finishReason !== 'tool_calls' || !callTool) {
        yield { type: 'done' };
        return;
      }

      // Execute every tool and append one tool-role message per result.
      for (const tc of toolCalls) {
        let input = {};
        try {
          input = tc.argsText ? JSON.parse(tc.argsText) : {};
        } catch {
          // Malformed JSON from the model — feed back as a tool error.
        }
        let resultText;
        try {
          const r = await callTool(tc.name, input);
          resultText = typeof r === 'string' ? r : JSON.stringify(r);
        } catch (err) {
          resultText = `Tool error: ${err?.message ?? String(err)}`;
        }
        conversation.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultText,
        });
        yield {
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input,
          result: resultText,
        };
      }
    }

    yield {
      type: 'token',
      delta: '\n\n(stopped after ' + MAX_TOOL_TURNS + ' tool turns)',
    };
    yield { type: 'done' };
  }
}
