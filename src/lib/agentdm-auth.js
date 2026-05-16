import prompts from 'prompts';
import kleur from 'kleur';
import { loginViaOAuth } from './oauth.js';

/**
 * Shared AgentDM sign-in flow used by every command that needs to attach an
 * agent runtime to the grid (init for each runtime, set, future commands).
 *
 * Returns `{ method: 'oauth' | 'token', token: string }`. The caller decides
 * how to persist the token — coding agents leave the OAuth token out of
 * .mcp.json (mcp-remote refreshes from ~/.mcp-auth); other runtimes embed it
 * directly.
 *
 * `onCancel` is the same ABORT callback `prompts()` callers use elsewhere so
 * Ctrl-C behavior stays consistent with the surrounding command.
 */
export async function pickAgentdmAuth({ onCancel } = {}) {
  const choice = await prompts(
    [
      {
        type: 'select',
        name: 'authMethod',
        message: 'How do you want to sign in to AgentDM?',
        choices: [
          { title: 'Open browser to sign in', value: 'oauth' },
          { title: 'Paste an API token', value: 'token' },
        ],
        initial: 0,
      },
    ],
    { onCancel },
  );

  if (choice.authMethod === 'oauth') {
    process.stdout.write(
      '\n' +
        kleur.bold('Opening your browser to sign in.\n') +
        kleur.dim('Approve the request, then come back here.\n\n'),
    );
    const token = await loginViaOAuth();
    process.stdout.write(kleur.green('signed in\n\n'));
    return { method: 'oauth', token };
  }

  const pasted = await prompts(
    [
      {
        type: 'password',
        name: 'token',
        message: 'AgentDM API token (get one at https://agentdm.ai)',
        validate: (v) => (v && v.trim().length > 0 ? true : 'token is required'),
      },
    ],
    { onCancel },
  );
  return { method: 'token', token: pasted.token.trim() };
}
