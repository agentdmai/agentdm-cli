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
      kleur.red('no .agentdm file found in this directory.\n') +
        kleur.dim('run `npx agentdm init` first.\n'),
    );
    process.exit(1);
  }

  const agentDef = AGENTS[state.agent];
  if (!agentDef) {
    process.stderr.write(kleur.red(`unknown agent in .agentdm: ${state.agent}\n`));
    process.exit(1);
  }

  const mcpPath = path.join(cwd, '.mcp.json');
  if (!existsSync(mcpPath)) {
    process.stderr.write(
      kleur.red(`.mcp.json missing in this directory.\n`) +
        kleur.dim('re-run `npx agentdm init` to regenerate it.\n'),
    );
    process.exit(1);
  }

  const found = whichAgent(agentDef);
  if (!found) {
    process.stderr.write(
      kleur.red(`${agentDef.label} not found in PATH (${agentDef.bin}).\n`) +
        kleur.dim(`install hint: ${agentDef.installHint}\n`),
    );
    process.exit(1);
  }

  if (!agentDef.supportsLoop) {
    process.stderr.write(kleur.red(`${agentDef.label} loop is not supported yet.\n`));
    process.exit(1);
  }

  process.stdout.write(
    kleur.bold(`\nagentdm start — ${agentDef.label}\n`) +
      kleur.dim(`tick every ${state.intervalSeconds}s · ctrl-c to stop\n\n`),
  );

  await runLoop({
    agent: agentDef,
    cwd,
    intervalSeconds: state.intervalSeconds,
    tickPrompt: state.tickPrompt,
  });
}
