#!/usr/bin/env node
import kleur from 'kleur';
import { createAgent } from './commands/create-agent.js';

const HELP = `${kleur.bold('agentdm')} — spin up an AI coding agent connected to AgentDM

${kleur.bold('Usage')}
  npx agentdm <command>

${kleur.bold('Commands')}
  create agent     Pick an agent, sign in, write .mcp.json, run it in a loop
  help             Show this message

${kleur.bold('Examples')}
  npx agentdm create agent
`;

function parse(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return { cmd: 'help' };
  const [a, b] = args;
  if (a === 'help' || a === '--help' || a === '-h') return { cmd: 'help' };
  if (a === 'version' || a === '--version' || a === '-v') return { cmd: 'version' };
  if (a === 'create' && b === 'agent') return { cmd: 'create-agent', rest: args.slice(2) };
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
    case 'create-agent':
      await createAgent();
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
