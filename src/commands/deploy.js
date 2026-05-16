// `npx agentdm deploy`
//
// Ship the Ask My Agent runtime to a hosted environment (Railway today;
// more providers via src/lib/deploy/). Flow:
//
//   1. If .agentdm + .env exist locally, offer to reuse them — same
//      config you tested locally is what ships.
//   2. Otherwise, walk the same wizard as `init` for Ask My Agent
//      (AgentDM auth, provider, tools, system prompt) — answers stay in
//      memory only.
//   3. Pack all env vars (including the .agentdm state as
//      AGENTDM_STATE_JSON so the container doesn't need the file).
//   4. Hand off to the chosen deploy provider, which authenticates with
//      its own API and creates the service + variables.
//
// Coding-agent runtimes (Claude Code, Copilot, OpenCode) are NOT shipped
// here on purpose — they need installed binaries + interactive OAuth that
// doesn't map cleanly to a container. Ask My Agent is the long-running
// daemon shape Railway/Fly/Render want.

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import prompts from 'prompts';
import kleur from 'kleur';
import dotenv from 'dotenv';
import { readState } from '../lib/state.js';
import { pickAgentdmAuth } from '../lib/agentdm-auth.js';
import { getHuggingFaceToken } from '../lib/huggingface-token.js';
import { getAnthropicToken } from '../lib/anthropic-token.js';
import { getOpenAIToken } from '../lib/openai-token.js';
import { getProviderModel, modelEnvName } from '../lib/provider-model.js';
import { configureTools } from '../lib/tools/index.js';
import { PROVIDERS as DEPLOY_PROVIDERS, findProvider } from '../lib/deploy/index.js';

const ABORT = () => {
  const err = new Error('aborted');
  err.code = 'ABORTED';
  throw err;
};

export async function deploy() {
  process.stdout.write(kleur.bold('\nagentdm deploy\n'));
  process.stdout.write(
    kleur.dim('Ship the Ask My Agent runtime to a hosted environment.\n\n'),
  );

  const cwd = process.cwd();

  // Step 1: reuse local config if it exists.
  const bundle = (await offerLocalConfig(cwd)) ?? (await collectFresh());
  // bundle: { envEntries: { ... }, state: { ... } }

  // Step 2: pack the .agentdm state into a single env var so the container
  // doesn't need the file. Runtime (start.js) reads AGENTDM_STATE_JSON when
  // .agentdm isn't present.
  const stateForContainer = {
    agent: bundle.state.agent,
    provider: bundle.state.provider,
    ...(bundle.state.model ? { model: bundle.state.model } : {}),
    ...(bundle.state.systemPrompt ? { systemPrompt: bundle.state.systemPrompt } : {}),
    tools: bundle.state.tools || [],
  };
  const envForDeploy = {
    ...bundle.envEntries,
    AGENTDM_STATE_JSON: JSON.stringify(stateForContainer),
  };

  // Step 3: pick a deploy provider (only Railway today, but the registry
  // is the only place to add more).
  const provider = await pickDeployProvider();

  // Step 4: hand off.
  process.stdout.write(
    '\n' + kleur.bold(`Deploying via ${provider.label}.\n\n`),
  );
  await provider.deploy({
    envVars: envForDeploy,
    onCancel: ABORT,
  });
}

// ---------------------------------------------------------------------------

async function offerLocalConfig(cwd) {
  let localState;
  try {
    localState = readState(cwd);
  } catch {
    return null;
  }
  if (!localState || localState.agent !== 'ask-my-agent') return null;

  const envPath = path.join(cwd, '.env');
  if (!existsSync(envPath)) return null;

  const { reuse } = await prompts(
    [
      {
        type: 'confirm',
        name: 'reuse',
        message: `Found a local .agentdm (${localState.provider}) + .env in ${cwd}. Deploy with this config?`,
        initial: true,
      },
    ],
    { onCancel: ABORT },
  );
  if (!reuse) return null;

  const env = dotenv.parse(readFileSync(envPath, 'utf8'));
  return { envEntries: env, state: localState };
}

// ---------------------------------------------------------------------------
// Fresh wizard — mirrors the Ask My Agent block of `init` but persists
// nothing to disk. Kept inline (rather than refactoring init.js) because
// init has UX concerns specific to local use (working directory, "start
// now?", AGENTS.md, etc.) that don't apply here.
// ---------------------------------------------------------------------------

async function collectFresh() {
  process.stdout.write(
    kleur.dim(
      'No reusable local config — walking the same questions as `agentdm init`.\n\n',
    ),
  );

  const auth = await pickAgentdmAuth({ onCancel: ABORT });

  const { provider } = await prompts(
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

  let providerKey = '';
  if (provider === 'huggingface') {
    providerKey = await getHuggingFaceToken({ onCancel: ABORT });
  } else if (provider === 'anthropic') {
    providerKey = await getAnthropicToken({ onCancel: ABORT });
  } else {
    providerKey = await getOpenAIToken({ onCancel: ABORT });
  }
  const model = await getProviderModel(provider, { onCancel: ABORT });

  const enabledTools = await configureTools({ onCancel: ABORT });

  const sysDefault = defaultSystemPrompt(enabledTools);
  const sys = await prompts(
    [
      {
        type: 'text',
        name: 'systemPrompt',
        message: "System prompt (the agent's role + capabilities; edit to taste)",
        initial: sysDefault,
        validate: (v) => (v && v.trim().length > 0 ? true : 'system prompt is required'),
      },
    ],
    { onCancel: ABORT },
  );

  const envEntries = {
    AGENTDM_API_KEY: auth.token,
    MODEL_PROVIDER: provider,
  };
  if (provider === 'anthropic') envEntries.ANTHROPIC_API_KEY = providerKey;
  if (provider === 'openai') envEntries.OPENAI_API_KEY = providerKey;
  if (provider === 'huggingface') envEntries.HF_TOKEN = providerKey;
  const envName = modelEnvName(provider);
  if (envName) envEntries[envName] = model;
  for (const t of enabledTools) {
    for (const [k, v] of Object.entries(t.secrets)) {
      if (typeof v === 'string' && v.length > 0) envEntries[k] = v;
    }
  }

  const state = {
    agent: 'ask-my-agent',
    provider,
    model,
    systemPrompt: sys.systemPrompt.trim(),
    tools: enabledTools.map((t) => ({
      id: t.id,
      state: t.state,
      secretEnvNames: t.secretEnvNames,
    })),
  };

  return { envEntries, state };
}

function defaultSystemPrompt(enabledTools) {
  const parts = ['You are a web assistant. You answer anonymous questions.'];
  for (const t of enabledTools) {
    if (t.id === 'github') parts.push('You have access to GitHub.');
    else if (t.id === 'web-browser') parts.push('You have access to a browser.');
    else parts.push(`You have access to ${t.id}.`);
  }
  return parts.join(' ');
}

async function pickDeployProvider() {
  if (DEPLOY_PROVIDERS.length === 1) return DEPLOY_PROVIDERS[0];
  const { id } = await prompts(
    [
      {
        type: 'select',
        name: 'id',
        message: 'Where do you want to deploy?',
        choices: DEPLOY_PROVIDERS.map((p) => ({
          title: `${p.label} — ${p.description}`,
          value: p.id,
        })),
        initial: 0,
      },
    ],
    { onCancel: ABORT },
  );
  return findProvider(id);
}
