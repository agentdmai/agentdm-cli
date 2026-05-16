import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import prompts from 'prompts';
import kleur from 'kleur';
import { openUrl } from './open-url.js';

const TOKENS_URL = 'https://huggingface.co/settings/tokens';

// huggingface_hub (Python) writes the active token to
// ~/.cache/huggingface/token; older releases used ~/.huggingface/token. We
// check both so a user who already ran `huggingface-cli login` doesn't have
// to dig their token out a second time.
const CACHED_TOKEN_PATHS = [
  path.join(os.homedir(), '.cache', 'huggingface', 'token'),
  path.join(os.homedir(), '.huggingface', 'token'),
];

function findExistingToken() {
  const envValue = process.env.HF_TOKEN?.trim();
  if (envValue) return { token: envValue, source: 'HF_TOKEN env var' };
  for (const p of CACHED_TOKEN_PATHS) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8').trim();
      if (raw) return { token: raw, source: p };
    } catch {
      /* unreadable — skip */
    }
  }
  return null;
}

/**
 * Resolve a HuggingFace token through the friendliest path available:
 *   1. reuse a token from env or the huggingface_hub cache (after asking),
 *   2. open huggingface.co/settings/tokens in the browser, then paste,
 *   3. paste a token the user already has.
 *
 * Returns the trimmed token string.
 */
export async function getHuggingFaceToken({ onCancel } = {}) {
  const existing = findExistingToken();
  if (existing) {
    const { use } = await prompts(
      [
        {
          type: 'confirm',
          name: 'use',
          message: `Found a HuggingFace token in ${existing.source}. Use it?`,
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
        message: 'How do you want to provide your HuggingFace token?',
        choices: [
          {
            title: 'Open browser to sign in / sign up and create a token',
            value: 'browser',
          },
          { title: 'Paste a token I already have', value: 'paste' },
        ],
        initial: 0,
      },
    ],
    { onCancel },
  );

  if (how === 'browser') {
    process.stdout.write(
      '\n' +
        kleur.bold(`Opening ${TOKENS_URL} in your browser.\n`) +
        kleur.dim(
          'Sign in (or sign up), create a Read token, then paste it here.\n',
        ) +
        kleur.dim(`If your browser didn't open, visit:\n  `) +
        kleur.cyan(TOKENS_URL) +
        '\n\n',
    );
    openUrl(TOKENS_URL);
  }

  const { token } = await prompts(
    [
      {
        type: 'password',
        name: 'token',
        message: 'HF_TOKEN',
        validate: (v) => (v && v.trim().length > 0 ? true : 'token is required'),
      },
    ],
    { onCancel },
  );
  return token.trim();
}
