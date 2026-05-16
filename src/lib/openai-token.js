import prompts from 'prompts';
import kleur from 'kleur';
import { openUrl } from './open-url.js';

const TOKEN_URL = 'https://platform.openai.com/api-keys';

function fromEnv() {
  const v = process.env.OPENAI_API_KEY?.trim();
  if (v) return { token: v, source: 'OPENAI_API_KEY env var' };
  return null;
}

/**
 * Resolve an OpenAI API key through the friendliest path available:
 *   1. reuse a key from env (after asking),
 *   2. open the API keys page in the browser,
 *   3. paste a key the user already has.
 *
 * Returns the trimmed key string.
 */
export async function getOpenAIToken({ onCancel } = {}) {
  const existing = fromEnv();
  if (existing) {
    const { use } = await prompts(
      [
        {
          type: 'confirm',
          name: 'use',
          message: `Found an OpenAI API key in ${existing.source}. Use it?`,
          initial: true,
        },
      ],
      { onCancel },
    );
    if (use) return existing.token;
  }

  const { how } = await prompts(
    [
      {
        type: 'select',
        name: 'how',
        message: 'How do you want to provide your OpenAI API key?',
        choices: [
          { title: 'Open browser to create a new API key', value: 'browser' },
          { title: 'Paste a key I already have', value: 'paste' },
        ],
        initial: 0,
      },
    ],
    { onCancel },
  );

  if (how === 'browser') {
    process.stdout.write(
      '\n' +
        kleur.bold(`Opening ${TOKEN_URL} in your browser.\n`) +
        kleur.dim(
          'Sign in (or sign up), click "Create new secret key", then paste it here.\n',
        ) +
        kleur.dim(`If your browser didn't open, visit:\n  `) +
        kleur.cyan(TOKEN_URL) +
        '\n\n',
    );
    openUrl(TOKEN_URL);
  }

  const { token } = await prompts(
    [
      {
        type: 'password',
        name: 'token',
        message: 'OPENAI_API_KEY',
        validate: (v) => (v && v.trim().length > 0 ? true : 'key is required'),
      },
    ],
    { onCancel },
  );
  return token.trim();
}
