// MCP aggregator. Opens an agentdm-grid MCP session (streamable HTTP) and,
// optionally, a github-mcp-server subprocess (stdio) running in read-only
// mode. Returns both sessions plus the union of their tool descriptors so
// the LLM can route tool calls back via the prefix.
//
// Read-only enforcement on the GitHub side (ported from the Python WR-05
// belt-and-suspenders):
//   1. spawn github-mcp-server with `--read-only` CLI flag.
//   2. set GITHUB_READ_ONLY=1 in the child env.
//   3. after initialize(), enumerate tools and refuse to start if any name
//      matches a mutating-verb regex (create_*, update_*, delete_*, …).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Mutating verb pattern. Matches a tool name like `create_issue`,
// `delete_repo`, `merge_pull_request` — but NOT read-only verbs (get_*,
// list_*, search_*).
const GITHUB_WRITE_TOOL_RE = new RegExp(
  '^(create|update|delete|patch|put|merge|push|fork|add|remove|' +
    'transfer|enable|disable|dispatch|cancel|approve|request_review|' +
    'submit|close|reopen|lock|unlock|invite|accept|decline|publish|' +
    'set|edit|rename|archive|unarchive)(_|$)',
  'i',
);

export class ReadOnlyEnforcementError extends Error {
  constructor(offenders) {
    super(
      'github-mcp-server exposed write-capable tools despite --read-only ' +
        'and GITHUB_READ_ONLY=1: ' +
        offenders.join(', ') +
        '. Upgrade or replace the binary, or run with a fine-grained PAT ' +
        'that has only read scopes.',
    );
    this.name = 'ReadOnlyEnforcementError';
    this.offenders = offenders;
  }
}

function findWriteTools(toolNames) {
  return toolNames.filter((n) => GITHUB_WRITE_TOOL_RE.test(n));
}

async function openGithub(pat) {
  const transport = new StdioClientTransport({
    command: 'github-mcp-server',
    args: ['stdio', '--read-only'],
    env: {
      ...process.env,
      GITHUB_PERSONAL_ACCESS_TOKEN: pat,
      GITHUB_READ_ONLY: '1',
    },
  });
  const client = new Client({ name: 'ask-my-agent', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);

  const resp = await client.listTools();
  const names = resp.tools.map((t) => t.name);
  const offenders = findWriteTools(names);
  if (offenders.length > 0) {
    await client.close().catch(() => {});
    throw new ReadOnlyEnforcementError(offenders);
  }
  return { client, tools: resp.tools };
}

async function openAgentdm(url, apiKey) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  });
  const client = new Client({ name: 'ask-my-agent', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);

  const resp = await client.listTools();
  return { client, tools: resp.tools };
}

/**
 * Open one or two MCP sessions and return them plus the unified tool list.
 * The github session is optional — if `githubPat` is empty/null, only the
 * agentdm session is opened.
 *
 * @returns {{ agentdm: Client, github: Client|null, tools: Array }} —
 *   tool entries are { name: "agentdm__<tool>" | "gh__<tool>", description,
 *   input_schema }.
 */
export async function openSessions({ agentdmUrl, agentdmApiKey, githubPat }) {
  const dm = await openAgentdm(agentdmUrl, agentdmApiKey);
  let gh = null;
  if (githubPat) {
    try {
      gh = await openGithub(githubPat);
    } catch (err) {
      // Surface read-only enforcement loudly; for everything else, log and
      // continue without github tools.
      if (err instanceof ReadOnlyEnforcementError) {
        await dm.client.close().catch(() => {});
        throw err;
      }
      process.stderr.write(`[warn] github-mcp-server unavailable: ${err.message}\n`);
      gh = null;
    }
  }

  const tools = [
    ...dm.tools.map((t) => ({
      name: `agentdm__${t.name}`,
      description: t.description ?? '',
      input_schema: t.inputSchema ?? {},
    })),
    ...(gh
      ? gh.tools.map((t) => ({
          name: `gh__${t.name}`,
          description: t.description ?? '',
          input_schema: t.inputSchema ?? {},
        }))
      : []),
  ];

  return {
    agentdm: dm.client,
    github: gh ? gh.client : null,
    tools,
    async close() {
      try {
        await dm.client.close();
      } catch {
        /* swallow */
      }
      if (gh) {
        try {
          await gh.client.close();
        } catch {
          /* swallow */
        }
      }
    },
  };
}
