// Anthropic strategy. Streams text deltas from `messages.stream`.
// ANTHROPIC_API_KEY is picked up from process.env by the SDK.

import Anthropic from '@anthropic-ai/sdk';

export class AnthropicProvider {
  constructor({ model = 'claude-sonnet-4-6' } = {}) {
    this.model = model;
    this._client = null;
  }

  _getClient() {
    if (!this._client) this._client = new Anthropic();
    return this._client;
  }

  async *chat(messages, tools) {
    const client = this._getClient();
    const params = {
      model: this.model,
      max_tokens: 1024,
      messages,
    };
    if (tools && tools.length) params.tools = tools;

    const stream = client.messages.stream(params);
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const delta = event.delta.text;
        if (delta) yield { type: 'token', delta };
      }
    }
    yield { type: 'done' };
  }
}
