// Runtime registry. Maps an agent id ("claude" | "copilot" | "opencode" |
// "pi" | "ask-my-agent") to its metadata used by `whichAgent`, the `init`
// wizard, and the `start` dispatcher.
//
// `wiring` says how the agent reaches the grid: "mcp" agents read a .mcp.json
// the CLI writes; "pi-extension" agents (Pi has no MCP) load a generated
// extension from .pi/extensions/. Self-driving runtimes need no wiring.
//
// Adapter classes are imported lazily so we never pay the side-effect
// cost of loading e.g. the copilot module when the user only runs claude.

import { execFileSync } from 'node:child_process';

export const RUNTIMES = {
  'ask-my-agent': {
    id: 'ask-my-agent',
    label: 'Ask My Agent (built-in)',
    // Self-driving runtime, lives in this CLI. No external binary.
    bin: null,
    supportsLoop: true,
    installHint: null,
    selfDriving: true,
    async load() {
      const { runAskMyAgent } = await import('./ask-my-agent/index.js');
      return { runAskMyAgent };
    },
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    supportsLoop: true,
    wiring: 'mcp',
    installHint: 'npm i -g @anthropic-ai/claude-code',
    async load() {
      const { ClaudeAdapter } = await import('./claude.js');
      return ClaudeAdapter;
    },
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    bin: 'copilot',
    supportsLoop: true,
    wiring: 'mcp',
    installHint: 'brew install gh && gh extension install github/gh-copilot && copilot login',
    async load() {
      const { CopilotAdapter } = await import('./copilot.js');
      return CopilotAdapter;
    },
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    bin: 'pi',
    supportsLoop: true,
    // Pi has no .mcp.json — the grid is wired in via a generated extension
    // dropped into .pi/extensions/agentdm/ (see lib/pi-extension.js).
    wiring: 'pi-extension',
    installHint: 'npm i -g @mariozechner/pi-coding-agent',
    async load() {
      const { PiAdapter } = await import('./pi.js');
      return PiAdapter;
    },
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    supportsLoop: false,
    wiring: 'mcp',
    installHint: 'curl -fsSL https://opencode.ai/install | bash',
    async load() {
      throw new Error('OpenCode adapter not implemented');
    },
  },
};

// Back-compat alias. The previous CLI used `AGENTS`; keep both names so
// downstream importers (init, start) don't break during the transition.
export const AGENTS = RUNTIMES;

export function whichAgent(agent) {
  // Self-driving runtimes (no external binary) are always "available".
  if (!agent || agent.bin == null) return 'built-in';
  try {
    const out = execFileSync('which', [agent.bin], { encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}
