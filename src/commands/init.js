import path from 'node:path';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import prompts from 'prompts';
import kleur from 'kleur';
import { writeMcpConfig } from '../lib/mcp-config.js';
import { writeState } from '../lib/state.js';
import { runLoop } from '../lib/loop.js';
import { whichAgent, RUNTIMES as AGENTS } from '../lib/runtimes/index.js';
import { loginViaOAuth } from '../lib/oauth.js';

const ABORT = () => {
  const err = new Error('aborted');
  err.code = 'ABORTED';
  throw err;
};

export async function init() {
  process.stdout.write(kleur.bold('\nagentdm init\n'));
  process.stdout.write(
    kleur.dim('Set up an agent connected to AgentDM.\n\n'),
  );

  const cwd = process.cwd();

  const choice = await prompts(
    [
      {
        type: 'select',
        name: 'agent',
        message: 'Which agent runtime?',
        choices: [
          { title: 'Ask My Agent (built-in, hosted LLM)', value: 'ask-my-agent' },
          { title: 'Claude Code (your coding agent)', value: 'claude' },
          { title: 'GitHub Copilot CLI', value: 'copilot' },
          { title: 'OpenCode', value: 'opencode' },
        ],
        initial: 0,
      },
    ],
    { onCancel: ABORT },
  );

  // ask-my-agent has its own setup flow (provider config + .env), separate
  // from the coding-agent .mcp.json flow.
  if (choice.agent === 'ask-my-agent') {
    return initAskMyAgent({ cwd });
  }

  return initCodingAgent({ cwd, agentId: choice.agent });
}

// ---------------------------------------------------------------------------
// Coding-agent flow (Claude Code, Copilot, OpenCode)
// ---------------------------------------------------------------------------

async function initCodingAgent({ cwd, agentId }) {
  const choice = await prompts(
    [
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

  let token = null;
  if (choice.authMethod === 'oauth') {
    process.stdout.write(
      '\n' +
        kleur.bold('Opening your browser to sign in.\n') +
        kleur.dim('Approve the request, then come back here.\n\n'),
    );
    await loginViaOAuth();
    process.stdout.write(kleur.green('signed in\n\n'));
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
          "Read your inbox on agentdm. For each message, do what it asks and reply when you're done. If the inbox is empty, exit quietly.",
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

  const agentDef = AGENTS[agentId];
  const projectDir = path.resolve(settings.cwd);

  process.stdout.write('\n');
  const found = whichAgent(agentDef);
  if (found) {
    process.stdout.write(kleur.green(`${agentDef.label} found: ${found}\n`));
  } else {
    process.stdout.write(
      kleur.yellow(`${agentDef.label} is not installed (no ${agentDef.bin} on PATH).\n`),
    );
    process.stdout.write(kleur.dim(`  to install: ${agentDef.installHint}\n`));
  }

  const mcpPath = path.join(projectDir, '.mcp.json');
  const mcpResult = writeMcpConfig(mcpPath, token);
  if (mcpResult.created) {
    process.stdout.write(kleur.green(`wrote ${mcpPath}\n`));
  } else if (mcpResult.replaced) {
    process.stdout.write(kleur.green(`updated agentdm entry in ${mcpPath}\n`));
  } else {
    process.stdout.write(kleur.green(`added agentdm entry to ${mcpPath}\n`));
  }

  const statePath = writeState(projectDir, {
    agent: agentDef.id,
    intervalSeconds: settings.interval,
    tickPrompt: settings.tickPrompt,
  });
  process.stdout.write(kleur.green(`saved your settings to ${statePath}\n`));

  if (token) {
    process.stdout.write(
      '\n' +
        kleur.yellow('heads up: ') +
        kleur.dim('your token is saved in .mcp.json. If this folder is a git repo, add it to .gitignore.\n'),
    );
  }

  if (!settings.startNow) {
    process.stdout.write('\n' + kleur.bold('Done.') + kleur.dim(' Run it later from this folder:\n'));
    process.stdout.write(kleur.cyan('  npx agentdm start\n'));
    return;
  }

  if (!found) {
    process.stdout.write(
      '\n' + kleur.yellow(`Skipping the run because ${agentDef.label} is not installed.\n`),
    );
    process.stdout.write(kleur.dim("Once it's installed, run:  npx agentdm start\n"));
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
    runtime: agentDef,
    cwd: projectDir,
    intervalSeconds: settings.interval,
    tickPrompt: settings.tickPrompt,
  });
}

// ---------------------------------------------------------------------------
// ask-my-agent flow
// ---------------------------------------------------------------------------

const ENV_FILE = '.env';

function readEnvFile(envPath) {
  if (!existsSync(envPath)) return {};
  const out = {};
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[m[1]] = val;
  }
  return out;
}

function writeEnvFile(envPath, entries) {
  const existing = readEnvFile(envPath);
  const merged = { ...existing, ...entries };
  const body =
    Object.entries(merged)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n';
  writeFileSync(envPath, body, 'utf8');
}

async function initAskMyAgent({ cwd }) {
  process.stdout.write(
    '\n' +
      kleur.dim(
        "Ask My Agent is a hosted-LLM runner. It listens on AgentDM and replies to any message it gets using the LLM provider you pick below.\n\n",
      ),
  );

  const settings = await prompts(
    [
      {
        type: 'text',
        name: 'cwd',
        message: 'Working directory (where to store config)',
        initial: cwd,
        validate: (v) => (existsSync(v) ? true : `path does not exist: ${v}`),
      },
      {
        type: 'password',
        name: 'agentdmApiKey',
        message: 'AgentDM agent API key (from https://agentdm.ai)',
        validate: (v) => (v && v.trim().length > 0 ? true : 'API key is required'),
      },
      {
        type: 'select',
        name: 'provider',
        message: 'Which LLM provider should the agent use?',
        choices: [
          { title: 'Anthropic (Claude)', value: 'anthropic' },
          { title: 'OpenAI (GPT)', value: 'openai' },
          { title: 'HuggingFace (any inference endpoint)', value: 'huggingface' },
        ],
        initial: 0,
      },
    ],
    { onCancel: ABORT },
  );

  const providerKey = await prompts(
    [
      {
        type: 'password',
        name: 'apiKey',
        message:
          settings.provider === 'anthropic'
            ? 'ANTHROPIC_API_KEY'
            : settings.provider === 'openai'
              ? 'OPENAI_API_KEY'
              : 'HF_TOKEN',
        validate: (v) => (v && v.trim().length > 0 ? true : 'API key is required'),
      },
      {
        type: settings.provider === 'huggingface' ? 'text' : null,
        name: 'model',
        message: 'HuggingFace model id (e.g. meta-llama/Llama-3.3-70B-Instruct)',
        validate: (v) => (v && v.trim().length > 0 ? true : 'model is required'),
      },
    ],
    { onCancel: ABORT },
  );

  const extras = await prompts(
    [
      {
        type: 'confirm',
        name: 'enableGithub',
        message: 'Give the agent read-only GitHub access (via github-mcp-server)?',
        initial: false,
      },
    ],
    { onCancel: ABORT },
  );

  let githubPat = null;
  if (extras.enableGithub) {
    const ghPrompt = await prompts(
      [
        {
          type: 'password',
          name: 'pat',
          message: 'GitHub Personal Access Token (read scopes only)',
          validate: (v) => (v && v.trim().length > 0 ? true : 'PAT is required'),
        },
      ],
      { onCancel: ABORT },
    );
    githubPat = ghPrompt.pat.trim();
  }

  const confirm = await prompts(
    [
      {
        type: 'confirm',
        name: 'startNow',
        message: 'Start the agent now?',
        initial: true,
      },
    ],
    { onCancel: ABORT },
  );

  const projectDir = path.resolve(settings.cwd);
  const envPath = path.join(projectDir, ENV_FILE);

  // Persist secrets to .env. .agentdm gets the non-secret config (runtime
  // id, provider id, model). Secrets live in .env so it's natural to
  // gitignore that file specifically.
  const envEntries = {
    AGENTDM_API_KEY: settings.agentdmApiKey.trim(),
    MODEL_PROVIDER: settings.provider,
  };
  if (settings.provider === 'anthropic') envEntries.ANTHROPIC_API_KEY = providerKey.apiKey.trim();
  if (settings.provider === 'openai') envEntries.OPENAI_API_KEY = providerKey.apiKey.trim();
  if (settings.provider === 'huggingface') {
    envEntries.HF_TOKEN = providerKey.apiKey.trim();
    envEntries.HUGGINGFACE_MODEL = providerKey.model.trim();
  }
  if (githubPat) envEntries.GITHUB_PERSONAL_ACCESS_TOKEN = githubPat;
  writeEnvFile(envPath, envEntries);
  process.stdout.write(kleur.green(`wrote secrets to ${envPath}\n`));

  const statePath = writeState(projectDir, {
    agent: 'ask-my-agent',
    provider: settings.provider,
    ...(settings.provider === 'huggingface' ? { model: providerKey.model.trim() } : {}),
    enableGithub: !!githubPat,
  });
  process.stdout.write(kleur.green(`saved settings to ${statePath}\n`));

  process.stdout.write(
    '\n' +
      kleur.yellow('heads up: ') +
      kleur.dim(`secrets are in ${ENV_FILE}. Add ${ENV_FILE} to .gitignore if this is a git repo.\n`),
  );

  if (!confirm.startNow) {
    process.stdout.write('\n' + kleur.bold('Done.') + kleur.dim(' Start the agent later:\n'));
    process.stdout.write(kleur.cyan('  npx agentdm start\n'));
    return;
  }

  // Hand off to start.js which knows how to run the ask-my-agent worker.
  const { start } = await import('./start.js');
  await start({ agentDir: projectDir });
}
