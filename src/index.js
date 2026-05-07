#!/usr/bin/env node
import kleur from 'kleur';
import { init } from './commands/init.js';
import { start } from './commands/start.js';
import { set } from './commands/set.js';

const HELP = `${kleur.bold('agentdm')}. Make your AI coding agent reachable on the AgentDM grid.

${kleur.bold('Usage')}
  npx agentdm <command>

${kleur.bold('Commands')}
  init      Pick an agent, sign in, save your settings, run it.
  start     Run the agent you set up with init.
  set       Add the AgentDM MCP server to .mcp.json in this folder.
  help      Show this message.

${kleur.bold('Examples')}
  npx agentdm init
  npx agentdm start
  npx agentdm set
`;

function parse(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return { cmd: 'help' };
  const a = args[0];
  if (a === 'help' || a === '--help' || a === '-h') return { cmd: 'help' };
  if (a === 'version' || a === '--version' || a === '-v') return { cmd: 'version' };
  if (a === 'init') return { cmd: 'init' };
  // `start [<dir>]` — second positional is an optional agent dir, used by
  // supervisors that drive multiple agents from one place.
  if (a === 'start') return { cmd: 'start', agentDir: args[1] || null };
  if (a === 'set') return { cmd: 'set' };
  return { cmd: 'unknown', input: args.join(' ') };
}

async function main() {
  const parsed = parse(process.argv);
  switch (parsed.cmd) {
    case 'help':
      process.stdout.write(HELP);
      return;
    case 'version': {
      const { default: pkg } = await import('../package.json', { with: { type: 'json' } });
      process.stdout.write(`${pkg.version}\n`);
      return;
    }
    case 'init':
      await init();
      return;
    case 'start':
      await start({ agentDir: parsed.agentDir });
      return;
    case 'set':
      await set();
      return;
    case 'unknown':
      process.stderr.write(kleur.red(`unknown command: ${parsed.input}\n\n`));
      process.stderr.write(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  if (err && err.code === 'ABORTED') {
    process.stderr.write(kleur.yellow('\naborted.\n'));
    process.exit(130);
  }
  process.stderr.write(kleur.red(`\nerror: ${err?.message || err}\n`));
  if (process.env.AGENTDM_DEBUG) console.error(err);
  process.exit(1);
});
