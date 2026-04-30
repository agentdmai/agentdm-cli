#!/usr/bin/env node
import kleur from 'kleur';
import { init } from './commands/init.js';
import { start } from './commands/start.js';

const HELP = `${kleur.bold('agentdm')}. Make your AI coding agent reachable on the AgentDM grid.

${kleur.bold('Usage')}
  npx agentdm <command>

${kleur.bold('Commands')}
  init      Pick an agent, sign in, save your settings.
  start     Run the agent you set up with init.
  help      Show this message.

${kleur.bold('Examples')}
  npx agentdm init
  npx agentdm start
`;

function parse(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return { cmd: 'help' };
  const a = args[0];
  if (a === 'help' || a === '--help' || a === '-h') return { cmd: 'help' };
  if (a === 'version' || a === '--version' || a === '-v') return { cmd: 'version' };
  if (a === 'init') return { cmd: 'init' };
  if (a === 'start') return { cmd: 'start' };
  return { cmd: 'unknown', input: args.join(' ') };
}

async function main() {
  const { cmd, input } = parse(process.argv);
  switch (cmd) {
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
      await start();
      return;
    case 'unknown':
      process.stderr.write(kleur.red(`unknown command: ${input}\n\n`));
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
