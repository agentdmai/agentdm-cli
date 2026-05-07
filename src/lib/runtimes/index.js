// Runtime registry. Maps an agent id ("claude" | "copilot" | "opencode")
// to its adapter class plus the metadata used by `whichAgent` and the
// `init` and `start` commands (label, bin, install hint, supportsLoop).
//
// Adapter classes are imported lazily so we never pay the side-effect
// cost of loading e.g. the copilot module when the user only runs claude.

import { execFileSync } from 'node:child_process';

export const RUNTIMES = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    supportsLoop: true,
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
    installHint: 'brew install gh && gh extension install github/gh-copilot && copilot login',
    async load() {
      const { CopilotAdapter } = await import('./copilot.js');
      return CopilotAdapter;
    },
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    supportsLoop: false,
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
  try {
    const out = execFileSync('which', [agent.bin], { encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null;
  }
}
