import path from 'node:path';
import kleur from 'kleur';
import { writeMcpConfig } from '../lib/mcp-config.js';
import { pickAgentdmAuth } from '../lib/agentdm-auth.js';

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

  const auth = await pickAgentdmAuth({ onCancel: ABORT });
  // `auth.token` is a long-lived static API key for both paths (pasted, or
  // minted from the browser sign-in), so embed it as a Bearer header.
  const token = auth.token;

  const mcpPath = path.join(process.cwd(), '.mcp.json');
  const result = writeMcpConfig(mcpPath, token);

  if (result.created) {
    process.stdout.write(kleur.green(`✓ wrote ${mcpPath}\n`));
  } else if (result.replaced) {
    process.stdout.write(kleur.green(`✓ updated agentdm entry in ${mcpPath}\n`));
  } else {
    process.stdout.write(kleur.green(`✓ added agentdm entry to ${mcpPath}\n`));
  }

  if (token) {
    process.stdout.write(
      '\n' +
        kleur.yellow('heads up: ') +
        kleur.dim('your token is saved in .mcp.json. If this folder is a git repo, add it to .gitignore.\n'),
    );
  }
}
