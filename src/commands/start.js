// `npx agentdm start [<agent-dir>]`
//
// End-user mode: run from a directory that has been `init`'d. Reads
// `.agentdm` for the runtime, interval, and tick prompt, spawns a fresh
// agent CLI per tick.
//
// Supervised mode: a parent supervisor (e.g. agents-web) sets
// AGENTDM_SUPERVISED=1 and supplies the agent dir as argv. Runs the
// long-lived adapter loop with adaptive backoff, /clear, SIGUSR1 wake,
// .orchestrator/* control files, and per-tick cost reporting. `.agentdm`
// is optional in this mode — env vars provide everything needed.

import path from 'node:path';
import { existsSync } from 'node:fs';
import kleur from 'kleur';
import {
  readState,
  DEFAULT_FULL_TICK_PROMPT,
  DEFAULT_LIGHT_TICK_PROMPT,
  DEFAULT_TICK_PROMPT,
} from '../lib/state.js';
import { runLoop } from '../lib/loop.js';
import { RUNTIMES, whichAgent } from '../lib/runtimes/index.js';

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

  // .agentdm is required for end-user mode, optional for supervised mode.
  const state = readState(cwd);
  if (!state && !supervised) {
    process.stderr.write(
      kleur.red('No .agentdm file in this folder.\n') +
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
// End-user mode
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
// Supervised mode
// ---------------------------------------------------------------------------

async function runSupervised({ cwd, runtime, runtimeId, state }) {
  const backoff = {
    minSeconds: intEnv('MIN_SLEEP', state?.backoff?.minSeconds ?? 60),
    stepSeconds: intEnv('IDLE_STEP', state?.backoff?.stepSeconds ?? 60),
    maxSeconds: intEnv('MAX_SLEEP', state?.backoff?.maxSeconds ?? 3600),
  };
  const timeoutSeconds = intEnv('TIMEOUT_SECS', state?.timeoutSeconds ?? 600);
  const stateDir = process.env.STATE_DIR || state?.stateDir || '.orchestrator';

  // Skill isolation, lifecycle hooks, and cost tracking default ON in
  // supervised mode (this matches the previous Python wrapper). Each can
  // be turned off explicitly via env or .agentdm.
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
