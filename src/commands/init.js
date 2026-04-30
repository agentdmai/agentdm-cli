import path from 'node:path';
import { existsSync } from 'node:fs';
import prompts from 'prompts';
import kleur from 'kleur';
import { writeMcpConfig } from '../lib/mcp-config.js';
import { writeState } from '../lib/state.js';
import { runLoop } from '../lib/loop.js';
import { whichAgent, AGENTS } from '../lib/agents.js';
import { loginViaOAuth } from '../lib/oauth.js';

const ABORT = () => {
  const err = new Error('aborted');
  err.code = 'ABORTED';
  throw err;
};

export async function init() {
  process.stdout.write(kleur.bold('\nagentdm init\n'));
  process.stdout.write(
    kleur.dim('Set up a lightweight coding agent connected to AgentDM.\n\n'),
  );

  const cwd = process.cwd();

  const choice = await prompts(
    [
      {
        type: 'select',
        name: 'agent',
        message: 'Which AI coding agent?',
        choices: [
          { title: 'Claude Code', value: 'claude' },
          { title: 'GitHub Copilot CLI', value: 'copilot' },
          { title: 'OpenCode', value: 'opencode' },
        ],
        initial: 0,
      },
      {
        type: 'select',
        name: 'authMethod',
        message: 'How do you want to sign in to AgentDM?',
        choices: [
          { title: 'Open browser to sign in', value: 'oauth' },
          { title: 'Paste an API token', value: 'token' },
        ],
        initial: 0,
      },
    ],
    { onCancel: ABORT },
  );

  let token;
  if (choice.authMethod === 'oauth') {
    process.stdout.write(
      '\n' +
        kleur.bold('Opening your browser to sign in.\n') +
        kleur.dim('Approve the request, then come back here.\n\n'),
    );
    token = await loginViaOAuth();
    process.stdout.write(kleur.green('✓ signed in\n\n'));
  } else {
    const pasted = await prompts(
      [
        {
          type: 'password',
          name: 'token',
          message: 'AgentDM API token (get one at https://agentdm.ai)',
          validate: (v) => (v && v.trim().length > 0 ? true : 'token is required'),
        },
      ],
      { onCancel: ABORT },
    );
    token = pasted.token.trim();
  }

  const settings = await prompts(
    [
      {
        type: 'text',
        name: 'cwd',
        message: 'Working directory',
        initial: cwd,
        validate: (v) => (existsSync(v) ? true : `path does not exist: ${v}`),
      },
      {
        type: 'number',
        name: 'interval',
        message: 'Check for new messages every (seconds)',
        initial: 60,
        min: 5,
      },
      {
        type: 'text',
        name: 'tickPrompt',
        message: 'What should it do each time it checks?',
        initial:
          'Read your inbox on agentdm. For each message, do what it asks and reply when you\'re done. If the inbox is empty, exit quietly.',
      },
      {
        type: 'confirm',
        name: 'startNow',
        message: 'Start it now?',
        initial: true,
      },
    ],
    { onCancel: ABORT },
  );

  const agentDef = AGENTS[choice.agent];
  const projectDir = path.resolve(settings.cwd);

  process.stdout.write('\n');
  const found = whichAgent(agentDef);
  if (found) {
    process.stdout.write(kleur.green(`✓ ${agentDef.label} found: ${found}\n`));
  } else {
    process.stdout.write(
      kleur.yellow(`! ${agentDef.label} is not installed (no ${agentDef.bin} on PATH).\n`),
    );
    process.stdout.write(kleur.dim(`  to install: ${agentDef.installHint}\n`));
  }

  const mcpPath = path.join(projectDir, '.mcp.json');
  const mcpResult = writeMcpConfig(mcpPath, token);
  if (mcpResult.created) {
    process.stdout.write(kleur.green(`✓ wrote ${mcpPath}\n`));
  } else if (mcpResult.replaced) {
    process.stdout.write(kleur.green(`✓ updated agentdm entry in ${mcpPath}\n`));
  } else {
    process.stdout.write(kleur.green(`✓ added agentdm entry to ${mcpPath}\n`));
  }

  const statePath = writeState(projectDir, {
    agent: agentDef.id,
    intervalSeconds: settings.interval,
    tickPrompt: settings.tickPrompt,
  });
  process.stdout.write(kleur.green(`✓ saved your settings to ${statePath}\n`));

  process.stdout.write(
    '\n' +
      kleur.yellow('heads up: ') +
      kleur.dim('your token is saved in .mcp.json. If this folder is a git repo, add it to .gitignore.\n'),
  );

  if (!settings.startNow) {
    process.stdout.write('\n' + kleur.bold('Done.') + kleur.dim(' Run it later from this folder:\n'));
    process.stdout.write(kleur.cyan('  npx agentdm start\n'));
    return;
  }

  if (!found) {
    process.stdout.write(
      '\n' + kleur.yellow(`Skipping the run because ${agentDef.label} is not installed.\n`),
    );
    process.stdout.write(kleur.dim('Once it\'s installed, run:  npx agentdm start\n'));
    return;
  }

  if (!agentDef.supportsLoop) {
    process.stdout.write(
      '\n' + kleur.yellow(`Running ${agentDef.label} on a schedule isn't supported yet. Your config is ready, though.\n`),
    );
    return;
  }

  process.stdout.write('\n' + kleur.bold(`Starting ${agentDef.label}.\n`));
  process.stdout.write(
    kleur.dim(`Checks for new messages every ${settings.interval} seconds. Press ctrl-c to stop.\n\n`),
  );

  await runLoop({
    agent: agentDef,
    cwd: projectDir,
    intervalSeconds: settings.interval,
    tickPrompt: settings.tickPrompt,
  });
}
