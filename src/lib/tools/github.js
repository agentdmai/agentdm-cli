import prompts from 'prompts';
import { getGitHubToken } from '../github-token.js';

// Mutating-verb pattern. Matches `create_issue`, `delete_repo`,
// `merge_pull_request` — not `get_*`, `list_*`, `search_*`.
const GITHUB_WRITE_TOOL_RE = new RegExp(
  '^(create|update|delete|patch|put|merge|push|fork|add|remove|' +
    'transfer|enable|disable|dispatch|cancel|approve|request_review|' +
    'submit|close|reopen|lock|unlock|invite|accept|decline|publish|' +
    'set|edit|rename|archive|unarchive)(_|$)',
  'i',
);

async function pickRepos({ onCancel }) {
  const { repos } = await prompts(
    [
      {
        type: 'text',
        name: 'repos',
        message:
          'Repos this agent may reference (comma-separated owner/repo, blank = anything the PAT can see)',
        initial: '',
      },
    ],
    { onCancel },
  );
  return (repos || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const githubTool = {
  id: 'github',
  label: 'GitHub',
  description: 'Search code, read repos, view issues/PRs (read-only).',
  // Prefix for tool names exposed to the LLM by the ask-my-agent runtime.
  toolPrefix: 'gh',

  // Names of env vars this tool's MCP server reads at runtime. Persisted in
  // .agentdm so the ask-my-agent runtime knows which process.env values to
  // pass through when spawning the server.
  secretEnvNames: ['GITHUB_PERSONAL_ACCESS_TOKEN'],

  async configure({ onCancel }) {
    const token = await getGitHubToken({ onCancel });
    const repos = await pickRepos({ onCancel });
    return {
      secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
      state: { repos },
    };
  },

  // Spawn descriptor (works for both .mcp.json and stdio child processes).
  // `secrets` is inlined into env so it works in both contexts — coding
  // agents don't propagate the parent process.env to MCP children.
  toMcpServer({ secrets }) {
    return {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { ...secrets },
    };
  },

  // Client-side allowlist for the ask-my-agent runtime. The deprecated
  // @modelcontextprotocol/server-github has no read-only flag, so we drop
  // write-verb tools before exposing the list to the LLM.
  filterTool(name) {
    return !GITHUB_WRITE_TOOL_RE.test(name);
  },

  // Optional helper the agent's system prompt can use to constrain itself
  // to the repos the user named at init time.
  describeFor(state) {
    if (!state?.repos || state.repos.length === 0) return null;
    return `When using GitHub tools, only reference these repositories: ${state.repos.join(', ')}.`;
  },
};
