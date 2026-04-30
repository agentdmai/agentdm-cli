import path from 'node:path';
import prompts from 'prompts';
import kleur from 'kleur';
import { writeMcpConfigHttp } from '../lib/mcp-config.js';
import { loginViaOAuth } from '../lib/oauth.js';

const ABORT = () => {
  const err = new Error('aborted');
  err.code = 'ABORTED';
  throw err;
};

export async function set() {
  process.stdout.write(kleur.bold('\nagentdm set\n'));
  process.stdout.write(
    kleur.dim('Add the AgentDM MCP server to .mcp.json in this folder.\n\n'),
  );

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
    { onCancel: ABORT },
  );

  let token;
  if (choice.authMethod === 'oauth') {
    process.stdout.write(
      '\n' +
        kleur.bold('Opening your browser to sign in.\n') +
        kleur.dim('Approve the request, then come back here.\n\n'),
    );
    token = await loginViaOAuth();
    process.stdout.write(kleur.green('✓ signed in\n'));
  } else {
    const pasted = await prompts(
      [
        {
          type: 'password',
          name: 'token',
          message: 'AgentDM API token (get one at https://agentdm.ai)',
          validate: (v) => (v && v.trim().length > 0 ? true : 'token is required'),
        },
      ],
      { onCancel: ABORT },
    );
    token = pasted.token.trim();
  }

  const mcpPath = path.join(process.cwd(), '.mcp.json');
  const result = writeMcpConfigHttp(mcpPath, token);

  if (result.created) {
    process.stdout.write(kleur.green(`✓ wrote ${mcpPath}\n`));
  } else if (result.replaced) {
    process.stdout.write(kleur.green(`✓ updated agentdm entry in ${mcpPath}\n`));
  } else {
    process.stdout.write(kleur.green(`✓ added agentdm entry to ${mcpPath}\n`));
  }

  process.stdout.write(
    '\n' +
      kleur.yellow('heads up: ') +
      kleur.dim('your token is saved in .mcp.json. If this folder is a git repo, add it to .gitignore.\n'),
  );
}
