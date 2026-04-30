import path from 'node:path';
import { existsSync } from 'node:fs';
import prompts from 'prompts';
import kleur from 'kleur';
import { writeMcpConfig } from '../lib/mcp-config.js';
import { writeState } from '../lib/state.js';
import { runLoop } from '../lib/loop.js';
import { whichAgent, AGENTS } from '../lib/agents.js';

const ABORT = () => {
  const err = new Error('aborted');
  err.code = 'ABORTED';
  throw err;
};

export async function init() {
  process.stdout.write(kleur.bold('\nagentdm — init\n'));
  process.stdout.write(
    kleur.dim('Set up an AI coding agent that runs in a loop and is reachable on the AgentDM grid.\n\n'),
  );

  const cwd = process.cwd();

  const answers = await prompts(
    [
      {
        type: 'select',
        name: 'agent',
        message: 'Which agent should drive this loop?',
        choices: [
          { title: 'Claude Code', value: 'claude', description: 'Anthropic Claude Code CLI' },
          { title: 'GitHub Copilot CLI', value: 'copilot', description: 'gh copilot' },
          { title: 'OpenCode', value: 'opencode', description: 'sst/opencode' },
        ],
        initial: 0,
      },
      {
        type: 'password',
        name: 'token',
        message: 'AgentDM API token (get one at https://agentdm.ai)',
        validate: (v) => (v && v.trim().length > 0 ? true : 'token is required'),
      },
      {
        type: 'text',
        name: 'cwd',
        message: 'Working directory for the agent loop',
        initial: cwd,
        validate: (v) => (existsSync(v) ? true : `path does not exist: ${v}`),
      },
      {
        type: 'number',
        name: 'interval',
        message: 'Tick interval (seconds between loop runs)',
        initial: 60,
        min: 5,
      },
      {
        type: 'text',
        name: 'tickPrompt',
        message: 'Tick prompt',
        initial:
          'Call read_messages on agentdm. For every message, follow the instructions and reply when done. If the inbox is empty, exit quietly.',
      },
      {
        type: 'confirm',
        name: 'startNow',
        message: 'Start the loop now?',
        initial: true,
      },
    ],
    { onCancel: ABORT },
  );

  const agentDef = AGENTS[answers.agent];
  const projectDir = path.resolve(answers.cwd);

  process.stdout.write('\n');
  const found = whichAgent(agentDef);
  if (found) {
    process.stdout.write(kleur.green(`✓ ${agentDef.label} found: ${found}\n`));
  } else {
    process.stdout.write(kleur.yellow(`! ${agentDef.label} not found in PATH (${agentDef.bin}).\n`));
    process.stdout.write(kleur.dim(`  install hint: ${agentDef.installHint}\n`));
  }

  const mcpPath = path.join(projectDir, '.mcp.json');
  const mcpResult = writeMcpConfig(mcpPath, answers.token.trim());
  if (mcpResult.created) {
    process.stdout.write(kleur.green(`✓ wrote ${mcpPath}\n`));
  } else if (mcpResult.replaced) {
    process.stdout.write(kleur.green(`✓ updated agentdm entry in ${mcpPath}\n`));
  } else {
    process.stdout.write(kleur.green(`✓ added agentdm entry to ${mcpPath}\n`));
  }

  const statePath = writeState(projectDir, {
    agent: agentDef.id,
    intervalSeconds: answers.interval,
    tickPrompt: answers.tickPrompt,
  });
  process.stdout.write(kleur.green(`✓ wrote ${statePath}\n`));

  process.stdout.write(
    '\n' +
      kleur.yellow('note: ') +
      kleur.dim('your token lives in .mcp.json — add it to .gitignore if this dir is a repo.\n'),
  );

  if (!answers.startNow) {
    process.stdout.write('\n' + kleur.bold('Done. ') + kleur.dim('Start the loop later with:\n'));
    process.stdout.write(kleur.cyan('  npx agentdm start\n'));
    return;
  }

  if (!found) {
    process.stdout.write(
      kleur.yellow('\nagent CLI is not installed; not starting the loop.\n'),
    );
    process.stdout.write(kleur.dim(`once installed:  npx agentdm start\n`));
    return;
  }

  if (!agentDef.supportsLoop) {
    process.stdout.write(
      kleur.yellow(`\n${agentDef.label} loop is not supported yet — config is ready.\n`),
    );
    return;
  }

  process.stdout.write('\n' + kleur.bold('Starting agent loop\n'));
  process.stdout.write(kleur.dim(`tick every ${answers.interval}s · ctrl-c to stop\n\n`));

  await runLoop({
    agent: agentDef,
    cwd: projectDir,
    intervalSeconds: answers.interval,
    tickPrompt: answers.tickPrompt,
  });
}
