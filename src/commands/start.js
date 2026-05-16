// `npx agentdm start [<agent-dir>]`
//
// Three modes:
//
// 1. ask-my-agent — self-driving worker (in-tree). Reads .agentdm + .env,
//    spawns the runner in this process, blocks until SIGINT/SIGTERM.
//
// 2. End-user mode (coding agents): runs from a directory that has been
//    `init`'d. Reads `.agentdm`, spawns a fresh agent CLI per tick.
//
// 3. Supervised mode: a parent supervisor (e.g. agents-web) sets
//    AGENTDM_SUPERVISED=1. Runs the long-lived adapter loop with adaptive
//    backoff, /clear, SIGUSR1 wake, .orchestrator/* control files, and
//    per-tick cost reporting.

import path from 'node:path';
import { existsSync } from 'node:fs';
import kleur from 'kleur';
import dotenv from 'dotenv';
import {
  readState,
  DEFAULT_FULL_TICK_PROMPT,
  DEFAULT_LIGHT_TICK_PROMPT,
  DEFAULT_TICK_PROMPT,
} from '../lib/state.js';
import { runLoop } from '../lib/loop.js';
import { RUNTIMES, whichAgent } from '../lib/runtimes/index.js';
import { modelEnvName } from '../lib/provider-model.js';

function isTruthyEnv(v) {
  if (!v) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {{ agentDir?: string }} [argv]
 */
export async function start(argv = {}) {
  const supervised = isTruthyEnv(process.env.AGENTDM_SUPERVISED);

  const cwd = path.resolve(argv.agentDir || process.env.AGENTDM_AGENT_DIR || process.cwd());
  if (!existsSync(cwd)) {
    process.stderr.write(kleur.red(`directory does not exist: ${cwd}\n`));
    process.exit(1);
  }

  // Containers (Railway, Fly, etc.) don't ship a .agentdm — let the deploy
  // wizard pack the same shape into AGENTDM_STATE_JSON instead.
  let state = readState(cwd);
  if (!state && process.env.AGENTDM_STATE_JSON) {
    try {
      state = JSON.parse(process.env.AGENTDM_STATE_JSON);
    } catch (err) {
      process.stderr.write(
        kleur.red(`AGENTDM_STATE_JSON is set but not valid JSON: ${err.message}\n`),
      );
      process.exit(1);
    }
  }
  if (!state && !supervised) {
    process.stderr.write(
      kleur.red('No .agentdm file in this folder and no AGENTDM_STATE_JSON env.\n') +
        kleur.dim(`Run \`npx agentdm init\` here first (cwd=${cwd}).\n`),
    );
    process.exit(1);
  }

  const runtimeId = (process.env.RUNTIME || state?.agent || 'claude').toLowerCase();
  const runtime = RUNTIMES[runtimeId];
  if (!runtime) {
    process.stderr.write(kleur.red(`Unknown runtime: ${runtimeId}\n`));
    process.exit(1);
  }

  // ask-my-agent is the self-driving worker — it does not go through the
  // BaseAdapter tick loop. Branch off here.
  if (runtime.selfDriving) {
    return runSelfDriving({ cwd, runtime, runtimeId, state });
  }

  const found = whichAgent(runtime);
  if (!found) {
    process.stderr.write(
      kleur.red(`${runtime.label} is not installed (no ${runtime.bin} on PATH).\n`) +
        kleur.dim(`To install: ${runtime.installHint}\n`),
    );
    process.exit(1);
  }

  if (!runtime.supportsLoop) {
    process.stderr.write(
      kleur.red(`Running ${runtime.label} on a schedule isn't supported yet.\n`),
    );
    process.exit(1);
  }

  if (supervised) {
    return runSupervised({ cwd, runtime, runtimeId, state });
  }
  return runEndUser({ cwd, runtime, state });
}

// ---------------------------------------------------------------------------
// ask-my-agent (self-driving worker)
// ---------------------------------------------------------------------------

async function runSelfDriving({ cwd, runtime, runtimeId, state }) {
  // Load .env from the agent directory so the runner sees credentials.
  // dotenv.config() does NOT overwrite already-set process.env, so a
  // shell-level export still wins — useful for one-off overrides.
  const envPath = path.join(cwd, '.env');
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }

  if (runtimeId !== 'ask-my-agent') {
    // Defensive: only ask-my-agent currently uses the self-driving path.
    process.stderr.write(kleur.red(`Self-driving runtime not implemented: ${runtimeId}\n`));
    process.exit(1);
  }

  const apiKey = process.env.AGENTDM_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      kleur.red('AGENTDM_API_KEY is not set.\n') +
        kleur.dim(`Re-run \`npx agentdm init\` here, or add AGENTDM_API_KEY to ${envPath}.\n`),
    );
    process.exit(1);
  }

  const providerId = state?.provider || process.env.MODEL_PROVIDER || 'anthropic';
  const { runAskMyAgent } = await runtime.load();
  const { buildProvider } = await import('../lib/runtimes/ask-my-agent/providers/index.js');

  // Model resolution is identical for every provider: state.model (set by
  // init/deploy) wins; otherwise the provider-specific env var; otherwise
  // the provider class's built-in default. HuggingFace is the only one
  // that errors when nothing resolves — its InferenceClient needs an
  // explicit model.
  const providerOpts = {};
  const envName = modelEnvName(providerId);
  const model = state?.model || (envName ? process.env[envName] : null);
  if (model) providerOpts.model = model;
  if (providerId === 'huggingface' && !providerOpts.model) {
    process.stderr.write(
      kleur.red('HuggingFace provider needs a model.\n') +
        kleur.dim(`Set HUGGINGFACE_MODEL in ${envPath} or re-run \`npx agentdm init\`.\n`),
    );
    process.exit(1);
  }

  const provider = buildProvider(providerId, providerOpts);

  process.stdout.write(
    '\n' +
      kleur.bold(`Starting ${runtime.label}.\n`) +
      kleur.dim(`Provider: ${providerId}${provider.model ? ` (${provider.model})` : ''}\n`) +
      kleur.dim('Press ctrl-c to stop.\n\n'),
  );

  const controller = new AbortController();
  const onSig = () => {
    process.stdout.write('\n' + kleur.dim('stopping…\n'));
    controller.abort();
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  await runAskMyAgent({
    agentdmUrl: process.env.AGENTDM_GRID_URL,
    agentdmApiKey: apiKey,
    wakeUrl: process.env.AGENTDM_WAKE_URL,
    enabledTools: state?.tools || [],
    userSystemPrompt: state?.systemPrompt || '',
    provider,
    fallbackPollMs: intEnv('FALLBACK_POLL_MS', 60_000),
    signal: controller.signal,
  });
}

// ---------------------------------------------------------------------------
// End-user mode (coding agents)
// ---------------------------------------------------------------------------

async function runEndUser({ cwd, runtime, state }) {
  const mcpPath = path.join(cwd, '.mcp.json');
  if (!existsSync(mcpPath)) {
    process.stderr.write(
      kleur.red(`.mcp.json is missing in this folder.\n`) +
        kleur.dim('Run `npx agentdm init` again to recreate it.\n'),
    );
    process.exit(1);
  }

  process.stdout.write(
    '\n' +
      kleur.bold(`Starting ${runtime.label}.\n`) +
      kleur.dim(
        `Checks for new messages every ${state.intervalSeconds} seconds. Press ctrl-c to stop.\n\n`,
      ),
  );

  await runLoop({
    runtime,
    cwd,
    intervalSeconds: state.intervalSeconds,
    tickPrompt: state.tickPrompt || DEFAULT_TICK_PROMPT,
  });
}

// ---------------------------------------------------------------------------
// Supervised mode (coding agents)
// ---------------------------------------------------------------------------

async function runSupervised({ cwd, runtime, runtimeId, state }) {
  const backoff = {
    minSeconds: intEnv('MIN_SLEEP', state?.backoff?.minSeconds ?? 60),
    stepSeconds: intEnv('IDLE_STEP', state?.backoff?.stepSeconds ?? 60),
    maxSeconds: intEnv('MAX_SLEEP', state?.backoff?.maxSeconds ?? 3600),
  };
  const timeoutSeconds = intEnv('TIMEOUT_SECS', state?.timeoutSeconds ?? 600);
  const stateDir = process.env.STATE_DIR || state?.stateDir || '.orchestrator';

  const skillIsolation = state?.skillIsolation ?? true;
  const lifecycleHooks = state?.lifecycleHooks ?? true;
  const trackCost = state?.trackCost ?? true;

  const fullTickPrompt = state?.fullTickPrompt || DEFAULT_FULL_TICK_PROMPT;
  const lightTickPrompt = state?.lightTickPrompt || DEFAULT_LIGHT_TICK_PROMPT;

  /** @type {Record<string, any>} */
  const runtimeOptions = {};
  if (runtimeId === 'claude') {
    runtimeOptions.chrome = isTruthyEnv(process.env.CHROME) || !!state?.claude?.chrome;
    runtimeOptions.model = process.env.CLAUDE_MODEL || state?.claude?.model || null;
    runtimeOptions.includePartial =
      isTruthyEnv(process.env.CLAUDE_INCLUDE_PARTIAL) || !!state?.claude?.includePartial;
    runtimeOptions.clearMinGapSeconds = intEnv(
      'CLEAR_MIN_GAP',
      state?.claude?.clearMinGapSeconds ?? 600,
    );
    runtimeOptions.extraArgs = state?.claude?.extraArgs || [];
  } else if (runtimeId === 'copilot') {
    runtimeOptions.model = process.env.COPILOT_MODEL || state?.copilot?.model || null;
    runtimeOptions.reasoning =
      process.env.COPILOT_REASONING || state?.copilot?.reasoning || null;
  }

  await runLoop({
    supervised: true,
    runtime,
    runtimeId,
    cwd,
    backoff,
    timeoutSeconds,
    stateDir,
    skillIsolation,
    lifecycleHooks,
    trackCost,
    fullTickPrompt,
    lightTickPrompt,
    runtimeOptions,
  });
}
