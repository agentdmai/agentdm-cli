import prompts from 'prompts';
import kleur from 'kleur';
import { openUrl } from './open-url.js';

// Railway recently moved their primary domain to railway.com but
// railway.app still resolves. The account-tokens page lives on the marketing
// host; the GraphQL API lives on backboard.* (handled in deploy/railway.js).
const TOKEN_URL = 'https://railway.com/account/tokens';

function fromEnv() {
  const candidates = [
    ['RAILWAY_TOKEN', process.env.RAILWAY_TOKEN],
    ['RAILWAY_API_TOKEN', process.env.RAILWAY_API_TOKEN],
  ];
  for (const [name, value] of candidates) {
    const v = value?.trim();
    if (v) return { token: v, source: `${name} env var` };
  }
  return null;
}

/**
 * Resolve a Railway API token through the friendliest path available:
 *   1. reuse a token from env (after asking),
 *   2. open the account-tokens page in the browser,
 *   3. paste a token the user already has.
 *
 * Returns the trimmed token string.
 */
export async function getRailwayToken({ onCancel } = {}) {
  const existing = fromEnv();
  if (existing) {
    const { use } = await prompts(
      [
        {
          type: 'confirm',
          name: 'use',
          message: `Found a Railway token in ${existing.source}. Use it?`,
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
        message: 'How do you want to provide your Railway API token?',
        choices: [
          {
            title: 'Open browser to create an Account Token',
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
        kleur.bold(`Opening ${TOKEN_URL} in your browser.\n`) +
        kleur.dim('Click "Create New Token", give it a name.\n') +
        kleur.yellow(
          'Important: leave the workspace dropdown as "No scope" (or your personal account).\n',
        ) +
        kleur.dim(
          'Workspace- or project-scoped tokens cannot create new projects — the deploy will fail with "Not Authorized".\n',
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
        message: 'Railway API token',
        validate: (v) => (v && v.trim().length > 0 ? true : 'token is required'),
      },
    ],
    { onCancel },
  );
  return token.trim();
}
