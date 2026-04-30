import path from 'node:path';
import { existsSync } from 'node:fs';
import kleur from 'kleur';
import { readState } from '../lib/state.js';
import { runLoop } from '../lib/loop.js';
import { AGENTS, whichAgent } from '../lib/agents.js';

export async function start() {
  const cwd = process.cwd();
  const state = readState(cwd);

  if (!state) {
    process.stderr.write(
      kleur.red('No .agentdm file in this folder.\n') +
        kleur.dim('Run `npx agentdm init` here first.\n'),
    );
    process.exit(1);
  }

  const agentDef = AGENTS[state.agent];
  if (!agentDef) {
    process.stderr.write(kleur.red(`Unknown agent in .agentdm: ${state.agent}\n`));
    process.exit(1);
  }

  const mcpPath = path.join(cwd, '.mcp.json');
  if (!existsSync(mcpPath)) {
    process.stderr.write(
      kleur.red(`.mcp.json is missing in this folder.\n`) +
        kleur.dim('Run `npx agentdm init` again to recreate it.\n'),
    );
    process.exit(1);
  }

  const found = whichAgent(agentDef);
  if (!found) {
    process.stderr.write(
      kleur.red(`${agentDef.label} is not installed (no ${agentDef.bin} on PATH).\n`) +
        kleur.dim(`To install: ${agentDef.installHint}\n`),
    );
    process.exit(1);
  }

  if (!agentDef.supportsLoop) {
    process.stderr.write(
      kleur.red(`Running ${agentDef.label} on a schedule isn't supported yet.\n`),
    );
    process.exit(1);
  }

  process.stdout.write(
    '\n' +
      kleur.bold(`Starting ${agentDef.label}.\n`) +
      kleur.dim(
        `Checks for new messages every ${state.intervalSeconds} seconds. Press ctrl-c to stop.\n\n`,
      ),
  );

  await runLoop({
    agent: agentDef,
    cwd,
    intervalSeconds: state.intervalSeconds,
    tickPrompt: state.tickPrompt,
  });
}
