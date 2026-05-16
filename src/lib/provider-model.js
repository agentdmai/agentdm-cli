import prompts from 'prompts';

// Per-provider model metadata: the basic model used as the default + a
// couple of alternatives shown inline as examples. Keep these lists short
// (3 each) so the prompt stays scannable — power users can type anything
// they want regardless.
//
// When adding a provider: drop an entry here and `getProviderModel` /
// `modelEnvName` pick it up automatically.
const PROVIDER_MODELS = {
  anthropic: {
    label: 'Anthropic model',
    defaultModel: 'claude-sonnet-4-6',
    examples: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    envName: 'ANTHROPIC_MODEL',
  },
  openai: {
    label: 'OpenAI model',
    defaultModel: 'gpt-4o',
    examples: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
    envName: 'OPENAI_MODEL',
  },
  huggingface: {
    label: 'HuggingFace model id',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    examples: [
      'meta-llama/Llama-3.3-70B-Instruct',
      'Qwen/Qwen2.5-72B-Instruct',
      'mistralai/Mistral-7B-Instruct-v0.3',
    ],
    envName: 'HUGGINGFACE_MODEL',
  },
};

export function modelEnvName(providerId) {
  return PROVIDER_MODELS[providerId]?.envName ?? null;
}

export function defaultModelFor(providerId) {
  return PROVIDER_MODELS[providerId]?.defaultModel ?? null;
}

/**
 * Prompt the user for a model id for the given provider. Returns the
 * trimmed string. Enter accepts the default; users can type any value.
 */
export async function getProviderModel(providerId, { onCancel } = {}) {
  const meta = PROVIDER_MODELS[providerId];
  if (!meta) throw new Error(`unknown provider: ${providerId}`);

  const { model } = await prompts(
    [
      {
        type: 'text',
        name: 'model',
        message: `${meta.label} (e.g. ${meta.examples.join(', ')})`,
        initial: meta.defaultModel,
        validate: (v) => (v && v.trim().length > 0 ? true : 'model is required'),
      },
    ],
    { onCancel },
  );
  return model.trim();
}
