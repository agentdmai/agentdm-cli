// Provider registry. Maps a provider id to its strategy class.

import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { HuggingFaceProvider } from './huggingface.js';

export const PROVIDERS = {
  anthropic: AnthropicProvider,
  openai: OpenAIProvider,
  huggingface: HuggingFaceProvider,
};

export function buildProvider(id, opts = {}) {
  const Cls = PROVIDERS[id];
  if (!Cls) throw new Error(`Unknown provider: ${id}`);
  return new Cls(opts);
}
