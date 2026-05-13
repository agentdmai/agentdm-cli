// HuggingFace strategy. Mirrors the OpenAI provider's tool loop because
// most HF inference endpoints (TGI, vLLM behind HF) speak the OpenAI
// chat-completion shape, including tool_calls in streamed deltas.
//
// Caveat: tool calling on HF is best-effort — the endpoint must run a
// model that's actually fine-tuned for tool use (Llama 3.1+ instruct,
// some Mistral variants). If the endpoint ignores tools, the loop falls
// through after one streamed turn with no tool_calls emitted.
//
// HF_TOKEN is read from process.env. The model must be passed explicitly.

import { InferenceClient } from '@huggingface/inference';

const MAX_TOOL_TURNS = 10;

export class HuggingFaceProvider {
  constructor({ model }) {
    if (!model) throw new Error('HuggingFaceProvider requires a model');
    this.model = model;
    this._client = null;
  }

  _getClient() {
    if (!this._client) this._client = new InferenceClient(process.env.HF_TOKEN);
    return this._client;
  }

  async *chat(messages, tools, callTool) {
    const client = this._getClient();
    const conversation = [...messages];

    const hfTools = (tools ?? []).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.input_schema ?? { type: 'object', properties: {} },
      },
    }));

    for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
      const params = { model: this.model, messages: conversation };
      if (hfTools.length > 0) params.tools = hfTools;

      const stream = client.chatCompletionStream(params);

      let accumulatedText = '';
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

      const toolCalls = Array.from(toolCallsByIdx.values()).filter((tc) => tc.id || tc.name);

      const assistantMsg = { role: 'assistant' };
      assistantMsg.content = accumulatedText || null;
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          type: 'function',
          function: { name: tc.name, arguments: tc.argsText || '{}' },
        }));
      }
      conversation.push(assistantMsg);

      if (toolCalls.length === 0 || finishReason !== 'tool_calls' || !callTool) {
        yield { type: 'done' };
        return;
      }

      for (const tc of assistantMsg.tool_calls) {
        let input = {};
        try {
          input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          /* malformed JSON from model — feed back as tool error */
        }
        let resultText;
        try {
          const r = await callTool(tc.function.name, input);
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
          name: tc.function.name,
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
