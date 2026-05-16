import { spawnSync } from 'node:child_process';
import prompts from 'prompts';
import kleur from 'kleur';
import { openUrl } from './open-url.js';

// Fine-grained PATs are GitHub's recommended path now and let the user
// scope to specific repos with read-only permissions, which matches our
// read-only enforcement on the MCP side.
const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

function fromEnv() {
  const candidates = [
    ['GITHUB_PERSONAL_ACCESS_TOKEN', process.env.GITHUB_PERSONAL_ACCESS_TOKEN],
    ['GITHUB_TOKEN', process.env.GITHUB_TOKEN],
    ['GH_TOKEN', process.env.GH_TOKEN],
  ];
  for (const [name, value] of candidates) {
    const trimmed = value?.trim();
    if (trimmed) return { token: trimmed, source: `${name} env var` };
  }
  return null;
}

function fromGhCli() {
  const result = spawnSync('gh', ['auth', 'token'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  const token = result.stdout.trim();
  if (!token) return null;
  return { token, source: '`gh auth token`' };
}

function findExistingToken() {
  return fromEnv() ?? fromGhCli();
}

/**
 * Resolve a GitHub Personal Access Token through the friendliest path:
 *   1. reuse a token from env or the `gh` CLI (after asking),
 *   2. open github.com/settings/personal-access-tokens/new in the browser,
 *      then paste,
 *   3. paste a token the user already has.
 *
 * The token is used by github-mcp-server, which we run with --read-only.
 * Users should still create a read-only token so a leak can't write.
 *
 * Returns the trimmed token string.
 */
export async function getGitHubToken({ onCancel } = {}) {
  const existing = findExistingToken();
  if (existing) {
    const { use } = await prompts(
      [
        {
          type: 'confirm',
          name: 'use',
          message: `Found a GitHub token via ${existing.source}. Use it?`,
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
        message: 'How do you want to provide your GitHub Personal Access Token?',
        choices: [
          {
            title: 'Open browser to create a fine-grained read-only token',
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
        kleur.bold(`Opening ${NEW_TOKEN_URL} in your browser.\n`) +
        kleur.dim(
          'Pick the repos the agent should see and grant only Read permissions, then paste the token here.\n',
        ) +
        kleur.dim(`If your browser didn't open, visit:\n  `) +
        kleur.cyan(NEW_TOKEN_URL) +
        '\n\n',
    );
    openUrl(NEW_TOKEN_URL);
  }

  const { token } = await prompts(
    [
      {
        type: 'password',
        name: 'token',
        message: 'GitHub Personal Access Token (read scopes only)',
        validate: (v) => (v && v.trim().length > 0 ? true : 'token is required'),
      },
    ],
    { onCancel },
  );
  return token.trim();
}
