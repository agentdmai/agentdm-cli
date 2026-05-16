import path from 'node:path';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import prompts from 'prompts';
import kleur from 'kleur';
import {
  buildAgentdmRemoteEntry,
  writeMcpServers,
} from '../lib/mcp-config.js';
import { writeState } from '../lib/state.js';
import { runLoop } from '../lib/loop.js';
import { whichAgent, RUNTIMES as AGENTS } from '../lib/runtimes/index.js';
import { pickAgentdmAuth } from '../lib/agentdm-auth.js';
import { getHuggingFaceToken } from '../lib/huggingface-token.js';
import { getAnthropicToken } from '../lib/anthropic-token.js';
import { getOpenAIToken } from '../lib/openai-token.js';
import { getProviderModel, modelEnvName } from '../lib/provider-model.js';
import { configureTools, findTool } from '../lib/tools/index.js';

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
  const auth = await pickAgentdmAuth({ onCancel: ABORT });
  // For OAuth, mcp-remote refreshes from its own ~/.mcp-auth cache, so we
  // intentionally leave the token out of .mcp.json. Pasted tokens are
  // long-lived and get embedded as a Bearer header.
  const token = auth.method === 'token' ? auth.token : null;

  // Walk the tool registry — same prompts every agent sees, same code path.
  const enabledTools = await configureTools({ onCancel: ABORT });

  // System prompt for the agent. Seeded with a default that mentions each
  // enabled tool. Coding agents read this from AGENTS.md (cross-agent
  // convention); Ask My Agent reads it from .agentdm. Either way the same
  // question is asked.
  const sysPromptDefault = buildDefaultSystemPrompt(enabledTools);
  const sys = await prompts(
    [
      {
        type: 'text',
        name: 'systemPrompt',
        message: "System prompt (the agent's role + capabilities; edit to taste)",
        initial: sysPromptDefault,
        validate: (v) => (v && v.trim().length > 0 ? true : 'system prompt is required'),
      },
    ],
    { onCancel: ABORT },
  );

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

  // Build the server map: agentdm always, plus every enabled tool. Each
  // tool inlines its own secrets into the entry's env because coding
  // agents don't forward the parent process.env to MCP children.
  const servers = { agentdm: buildAgentdmRemoteEntry(token) };
  for (const t of enabledTools) {
    const def = findTool(t.id);
    if (!def) continue;
    servers[t.id] = def.toMcpServer({ secrets: t.secrets, state: t.state });
  }

  const mcpPath = path.join(projectDir, '.mcp.json');
  const mcpResult = writeMcpServers(mcpPath, servers);
  if (mcpResult.fileCreated) {
    process.stdout.write(kleur.green(`wrote ${mcpPath}\n`));
  }
  if (mcpResult.created.length > 0) {
    process.stdout.write(
      kleur.green(`added MCP servers: ${mcpResult.created.join(', ')}\n`),
    );
  }
  if (mcpResult.replaced.length > 0) {
    process.stdout.write(
      kleur.green(`updated MCP servers: ${mcpResult.replaced.join(', ')}\n`),
    );
  }

  writeAgentsMd(projectDir, sys.systemPrompt.trim());

  const statePath = writeState(projectDir, {
    agent: agentDef.id,
    intervalSeconds: settings.interval,
    tickPrompt: settings.tickPrompt,
    systemPrompt: sys.systemPrompt.trim(),
    tools: enabledTools.map((t) => ({
      id: t.id,
      state: t.state,
      secretEnvNames: t.secretEnvNames,
    })),
  });
  process.stdout.write(kleur.green(`saved your settings to ${statePath}\n`));

  const inlinedSecrets =
    token || enabledTools.some((t) => Object.keys(t.secrets).length > 0);
  if (inlinedSecrets) {
    process.stdout.write(
      '\n' +
        kleur.yellow('heads up: ') +
        kleur.dim(
          'tokens are saved in .mcp.json. If this folder is a git repo, add it to .gitignore.\n',
        ),
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

// Writes the system prompt into AGENTS.md so coding agents (Claude Code,
// OpenCode, etc., which read instructions from a file in cwd) pick it up.
// Uses HTML-comment fenceposts so re-running init only rewrites our block
// and leaves any user-added sections alone. The state file (.agentdm) also
// keeps a copy so the runtime can render it back without parsing markdown.
const AGENTS_MD_FILE = 'AGENTS.md';
const AGENTS_MD_BEGIN = '<!-- agentdm:begin -->';
const AGENTS_MD_END = '<!-- agentdm:end -->';

function writeAgentsMd(projectDir, systemPrompt) {
  const filePath = path.join(projectDir, AGENTS_MD_FILE);
  const block = `${AGENTS_MD_BEGIN}\n${systemPrompt}\n${AGENTS_MD_END}\n`;
  let existing = '';
  if (existsSync(filePath)) existing = readFileSync(filePath, 'utf8');
  let next;
  if (existing.includes(AGENTS_MD_BEGIN) && existing.includes(AGENTS_MD_END)) {
    // Replace just our block; leave the rest of the file alone.
    next = existing.replace(
      new RegExp(`${AGENTS_MD_BEGIN}[\\s\\S]*?${AGENTS_MD_END}\\n?`),
      block,
    );
  } else if (existing.trim()) {
    next = `${existing.replace(/\n*$/, '\n\n')}${block}`;
  } else {
    next = block;
  }
  writeFileSync(filePath, next, 'utf8');
  process.stdout.write(kleur.green(`wrote system prompt to ${filePath}\n`));
}

// Builds the seed text the user sees in the system-prompt prompt. Only
// mentions tools the user actually enabled — that's why this lives here
// (after the registry loop) rather than as a static string.
function buildDefaultSystemPrompt(enabledTools) {
  const parts = ['You are a web assistant. You answer anonymous questions.'];
  for (const t of enabledTools) {
    if (t.id === 'github') parts.push('You have access to GitHub.');
    else if (t.id === 'web-browser') parts.push('You have access to a browser.');
    else parts.push(`You have access to ${t.id}.`);
  }
  return parts.join(' ');
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

  const where = await prompts(
    [
      {
        type: 'text',
        name: 'cwd',
        message: 'Working directory (where to store config)',
        initial: cwd,
        validate: (v) => (existsSync(v) ? true : `path does not exist: ${v}`),
      },
    ],
    { onCancel: ABORT },
  );

  const auth = await pickAgentdmAuth({ onCancel: ABORT });

  const settings = await prompts(
    [
      {
        type: 'select',
        name: 'provider',
        message: 'Which LLM provider should the agent use?',
        choices: [
          { title: 'HuggingFace (any inference endpoint)', value: 'huggingface' },
          { title: 'Anthropic (Claude)', value: 'anthropic' },
          { title: 'OpenAI (GPT)', value: 'openai' },
        ],
        initial: 0,
      },
    ],
    { onCancel: ABORT },
  );
  settings.cwd = where.cwd;
  settings.agentdmApiKey = auth.token;

  const providerKey = { apiKey: '', model: '' };
  if (settings.provider === 'huggingface') {
    providerKey.apiKey = await getHuggingFaceToken({ onCancel: ABORT });
  } else if (settings.provider === 'anthropic') {
    providerKey.apiKey = await getAnthropicToken({ onCancel: ABORT });
  } else {
    providerKey.apiKey = await getOpenAIToken({ onCancel: ABORT });
  }
  providerKey.model = await getProviderModel(settings.provider, { onCancel: ABORT });

  // Walk the tool registry — same prompts every agent sees, same code path.
  const enabledTools = await configureTools({ onCancel: ABORT });

  // System prompt seeded with a sensible default that mentions each tool the
  // user just enabled, so the model knows what capabilities it has.
  const sysPromptDefault = buildDefaultSystemPrompt(enabledTools);
  const sys = await prompts(
    [
      {
        type: 'text',
        name: 'systemPrompt',
        message: "System prompt (the agent's role + capabilities; edit to taste)",
        initial: sysPromptDefault,
        validate: (v) => (v && v.trim().length > 0 ? true : 'system prompt is required'),
      },
    ],
    { onCancel: ABORT },
  );

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

  // Persist secrets to .env. Each tool contributes its own secret env vars
  // (via configure() → secrets). .agentdm gets non-secret tool state + the
  // env var names so the runtime can re-pair them later.
  const envEntries = {
    AGENTDM_API_KEY: settings.agentdmApiKey.trim(),
    MODEL_PROVIDER: settings.provider,
  };
  if (settings.provider === 'anthropic') envEntries.ANTHROPIC_API_KEY = providerKey.apiKey.trim();
  if (settings.provider === 'openai') envEntries.OPENAI_API_KEY = providerKey.apiKey.trim();
  if (settings.provider === 'huggingface') envEntries.HF_TOKEN = providerKey.apiKey.trim();
  const envName = modelEnvName(settings.provider);
  if (envName) envEntries[envName] = providerKey.model.trim();
  for (const t of enabledTools) {
    for (const [k, v] of Object.entries(t.secrets)) {
      envEntries[k] = typeof v === 'string' ? v.trim() : v;
    }
  }
  writeEnvFile(envPath, envEntries);
  process.stdout.write(kleur.green(`wrote secrets to ${envPath}\n`));

  const statePath = writeState(projectDir, {
    agent: 'ask-my-agent',
    provider: settings.provider,
    model: providerKey.model.trim(),
    systemPrompt: sys.systemPrompt.trim(),
    tools: enabledTools.map((t) => ({
      id: t.id,
      state: t.state,
      secretEnvNames: t.secretEnvNames,
    })),
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
