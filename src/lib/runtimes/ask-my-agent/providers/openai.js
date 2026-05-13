// OpenAI strategy. Streams text deltas from chat.completions.create.
// OPENAI_API_KEY is picked up from process.env by the SDK.

import OpenAI from 'openai';

export class OpenAIProvider {
  constructor({ model = 'gpt-4o-mini' } = {}) {
    this.model = model;
    this._client = null;
  }

  _getClient() {
    if (!this._client) this._client = new OpenAI();
    return this._client;
  }

  async *chat(messages, tools) {
    const client = this._getClient();
    const params = {
      model: this.model,
      messages,
      stream: true,
    };
    if (tools && tools.length) params.tools = tools;

    const stream = await client.chat.completions.create(params);
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (delta) yield { type: 'token', delta };
    }
    yield { type: 'done' };
  }
}
