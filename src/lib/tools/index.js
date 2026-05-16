// Tool registry. Every entry in TOOLS is a self-contained module that
// describes (1) how to prompt the user for its config, (2) how to spawn its
// MCP server, and (3) optional client-side filters for runtimes that need
// them. Adding a new tool is a one-file change: write src/lib/tools/foo.js
// and append it to TOOLS below.

import prompts from 'prompts';
import { githubTool } from './github.js';
import { webBrowserTool } from './web-browser.js';

export const TOOLS = [githubTool, webBrowserTool];

export function findTool(id) {
  return TOOLS.find((t) => t.id === id) || null;
}

/**
 * Walk the registry, asking the user whether to configure each tool. For
 * each "yes", run the tool's configure() and collect the result.
 *
 * Returns an array of `{ id, secrets, state, secretEnvNames }` ready for
 * persistence. `secrets` is an object of env var names → values that should
 * land in .env (or be inlined into .mcp.json); `state` is non-secret config
 * persisted in .agentdm.
 */
export async function configureTools({ onCancel }) {
  const enabled = [];
  for (const tool of TOOLS) {
    const { yes } = await prompts(
      [
        {
          type: 'confirm',
          name: 'yes',
          message: tool.description
            ? `Configure ${tool.label}? — ${tool.description}`
            : `Configure ${tool.label}?`,
          initial: false,
        },
      ],
      { onCancel },
    );
    if (!yes) continue;
    const config = await tool.configure({ onCancel });
    enabled.push({
      id: tool.id,
      secrets: config.secrets || {},
      state: config.state || {},
      secretEnvNames: tool.secretEnvNames || Object.keys(config.secrets || {}),
    });
  }
  return enabled;
}
