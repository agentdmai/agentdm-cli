import prompts from 'prompts';
import kleur from 'kleur';
import { loginViaOAuth, exchangeOAuthForApiKey } from './oauth.js';

/**
 * Shared AgentDM sign-in flow used by every command that needs to attach an
 * agent runtime to the grid (init for each runtime, set, future commands).
 *
 * Returns `{ method: 'oauth' | 'token', token: string }`. Either way `token`
 * is a long-lived static API key (`agentdm_…`): pasted directly, or — for the
 * browser path — minted by exchanging the one-time OAuth access token for a
 * non-expiring key. Callers just persist `token`.
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
    const accessToken = await loginViaOAuth();
    process.stdout.write(kleur.green('signed in\n'));
    // Exchange the short-lived OAuth access token for a non-expiring static API
    // key, so every runtime stores and uses the same kind of credential and
    // nothing breaks after the access token's ~1h lifetime.
    process.stdout.write(kleur.dim('issuing a long-lived API key…\n'));
    const { apiKey, alias } = await exchangeOAuthForApiKey(accessToken, {
      gridUrl: process.env.AGENTDM_GRID_URL,
    });
    process.stdout.write(
      kleur.green(`issued API key${alias ? ` for @${alias}` : ''}\n`) +
        kleur.dim('(this replaces any previous key for that agent)\n\n'),
    );
    return { method: 'oauth', token: apiKey };
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
