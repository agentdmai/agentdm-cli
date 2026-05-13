// HuggingFace strategy. Streams chat-completion deltas from an inference
// endpoint. HF_TOKEN is picked up from process.env by the SDK.
//
// No default model: HF endpoints vary per user and there is no universally
// sensible fallback. Caller must pass `model` explicitly via .env.

import { InferenceClient } from '@huggingface/inference';

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

  async *chat(messages, _tools) {
    const client = this._getClient();
    const stream = client.chatCompletionStream({
      model: this.model,
      messages,
    });
    for await (const chunk of stream) {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (delta) yield { type: 'token', delta };
    }
    yield { type: 'done' };
  }
}
