// ask-my-agent runtime metadata + worker entry.
//
// Unlike claude / copilot (which wrap an external CLI), ask-my-agent is a
// self-driving worker implemented in-tree. The runtime registry advertises
// it; `start.js` dispatches directly to runAskMyAgent() instead of going
// through the BaseAdapter tick loop.

export { runAskMyAgent } from './server.js';

export const ASK_MY_AGENT_META = {
  id: 'ask-my-agent',
  label: 'Ask My Agent (built-in)',
  // No external binary — the runtime is in this CLI.
  bin: null,
  supportsLoop: true,
  installHint: null,
  selfDriving: true,
};
