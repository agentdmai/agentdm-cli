import { execFileSync } from 'node:child_process';

export const AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    supportsLoop: true,
    installHint: 'npm i -g @anthropic-ai/claude-code',
    buildArgs: ({ tickPrompt }) => [
      '-p',
      '--mcp-config',
      '.mcp.json',
      '--strict-mcp-config',
      '--dangerously-skip-permissions',
      '--verbose',
      '--output-format',
      'stream-json',
      tickPrompt,
    ],
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    bin: 'gh',
    supportsLoop: false,
    installHint: 'brew install gh && gh extension install github/gh-copilot',
    buildArgs: () => [],
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    supportsLoop: false,
    installHint: 'curl -fsSL https://opencode.ai/install | bash',
    buildArgs: () => [],
  },
};

export function whichAgent(agent) {
  try {
    const out = execFileSync('which', [agent.bin], { encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}
