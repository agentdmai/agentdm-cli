// Two loops in one module.
//
//   simpleLoop      — end-user `npx agentdm start`. Spawns a fresh agent
//                     CLI per tick, prints kleur-rendered tool-call summaries,
//                     waits a fixed interval, repeats. SIGINT exits cleanly
//                     after the current tick.
//
//   supervisedLoop  — long-lived per-agent wrapper, equivalent to the
//                     agent-loop.py we used to ship with each consumer
//                     project. Persistent claude session with /clear,
//                     adaptive backoff, .orchestrator control files,
//                     SIGUSR1 wake, lifecycle hooks, per-tick cost.
//
// runLoop() picks one based on options.supervised.

import kleur from 'kleur';
import path from 'node:path';
import { Orchestrator, sourceEnv } from './orchestrator.js';
import { tickCostLine } from './cost.js';
import { RUNTIMES } from './runtimes/index.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runLoop(opts) {
  if (opts.supervised) return supervisedLoop(opts);
  return simpleLoop(opts);
}

// ---------------------------------------------------------------------------
// Simple loop (end-user CLI)
// ---------------------------------------------------------------------------

const sleep = (ms) =>
  new Promise((resolve, reject) => {
    const onSigint = () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
    };
    const t = setTimeout(() => {
      process.off('SIGINT', onSigint);
      resolve();
    }, ms);
    process.once('SIGINT', onSigint);
  });

async function simpleLoop({ runtime, cwd, intervalSeconds, tickPrompt }) {
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    process.stderr.write(kleur.yellow('\nctrl-c received. Finishing this run, then stopping.\n'));
  });

  const AdapterClass = await runtime.load();
  const adapter = new AdapterClass({ agentDir: cwd, log: () => {}, env: process.env });

  while (!stopping) {
    const now = new Date().toLocaleTimeString();
    process.stdout.write(kleur.dim(`\n[${now}] checking inbox with ${runtime.label}\n`));
    const code = await adapter.runOneTick({ tickPrompt, onLine: renderStreamLine });
    if (code !== 0) {
      process.stderr.write(kleur.red(`${runtime.label} exited with code ${code}.\n`));
    }
    if (stopping) break;
    try {
      await sleep(intervalSeconds * 1000);
    } catch (err) {
      if (err.code === 'ABORTED') break;
      throw err;
    }
  }
  process.stdout.write(kleur.dim('\nStopped.\n'));
}

// ---------------------------------------------------------------------------
// Pretty per-tool-call rendering for simple-loop stdout
// ---------------------------------------------------------------------------

function renderStreamLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let evt;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
    for (const c of evt.message.content) {
      if (c.type === 'tool_use') {
        const name = shortToolName(c.name || 'tool');
        const summary = summarizeToolInput(c.name, c.input);
        const out = summary ? `${name} ${kleur.dim(truncate(summary, 100))}` : name;
        process.stdout.write(kleur.dim('  · ') + out + '\n');
      }
    }
    return;
  }

  if (evt.type === 'user' && evt.message && Array.isArray(evt.message.content)) {
    for (const c of evt.message.content) {
      if (c.type === 'tool_result' && c.is_error) {
        const txt = stringifyToolResult(c.content);
        process.stdout.write(kleur.red('  ✗ ') + truncate(txt, 160) + '\n');
      }
    }
    return;
  }

  if (evt.type === 'result') {
    if (evt.result && typeof evt.result === 'string' && evt.result.trim()) {
      process.stdout.write(evt.result.endsWith('\n') ? evt.result : evt.result + '\n');
    } else if (evt.subtype && evt.subtype !== 'success') {
      process.stdout.write(kleur.red(`  (ended: ${evt.subtype})\n`));
    }
  }
}

function shortToolName(name) {
  const m = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name);
  return m ? m[1] : name;
}

function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const oneLine = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
  switch (name) {
    case 'Bash':
      return oneLine(input.command);
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return oneLine(input.file_path);
    case 'Grep':
    case 'Glob':
      return oneLine(input.pattern);
    case 'WebFetch':
      return oneLine(input.url);
    case 'WebSearch':
      return oneLine(input.query);
    case 'Task':
      return oneLine(input.description || input.subagent_type);
    case 'TodoWrite':
      return Array.isArray(input.todos) ? `${input.todos.length} todos` : '';
    default: {
      for (const v of Object.values(input)) {
        const s = oneLine(v);
        if (s) return s;
      }
      return '';
    }
  }
}

function stringifyToolResult(content) {
  if (typeof content === 'string') return content.replace(/\s+/g, ' ');
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
      .join(' ')
      .replace(/\s+/g, ' ');
  }
  return '';
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

// ---------------------------------------------------------------------------
// Supervised loop (long-lived per-agent wrapper)
// ---------------------------------------------------------------------------

async function supervisedLoop(opts) {
  const {
    runtime,
    runtimeId, // "claude" | "copilot" | …
    cwd,
    backoff,
    timeoutSeconds,
    fullTickPrompt,
    lightTickPrompt,
    stateDir,
    skillIsolation,
    lifecycleHooks,
    trackCost,
    runtimeOptions = {},
  } = opts;

  const orch = new Orchestrator(cwd, stateDir);
  const log = (msg) => orch.log(msg);

  // Source the agent's .env (does not overwrite supervisor-supplied env vars).
  const envPath = path.join(cwd, '.env');
  if (sourceEnv(envPath)) {
    log('sourced .env');
  } else {
    log('no .env in agent dir (MCP servers requiring tokens may fail)');
  }

  // First-run cleanup: remove stale flags, but do NOT touch sleep.json /
  // session-settings.json / agent-loop.log (the dashboard tails those).
  orch.cleanStaleFlags();

  log(
    `agent-loop start pid=${process.pid} cwd=${cwd} runtime=${runtimeId} ` +
      `min=${backoff.minSeconds}s step=${backoff.stepSeconds}s max=${backoff.maxSeconds}s ` +
      `timeout=${timeoutSeconds}s`,
  );

  let stopping = false;
  const wakeQueue = [];
  let wakeWaiter = null;

  process.on('SIGUSR1', () => {
    if (wakeWaiter) {
      const w = wakeWaiter;
      wakeWaiter = null;
      clearTimeout(w.timer);
      w.resolve('woken');
    } else {
      wakeQueue.push(true);
    }
  });
  process.on('SIGTERM', onShutdownSignal);
  process.on('SIGINT', onShutdownSignal);

  function onShutdownSignal() {
    log('received SIGTERM/SIGINT — shutting down');
    stopping = true;
    if (wakeWaiter) {
      const w = wakeWaiter;
      wakeWaiter = null;
      clearTimeout(w.timer);
      w.resolve('stopped');
    }
  }

  const AdapterClass = await runtime.load();
  const sessionSettingsPath = path.join(orch.stateDir, 'session-settings.json');

  const buildAdapter = () => {
    if (runtimeId === 'claude') {
      return new AdapterClass(
        { agentDir: cwd, log, env: process.env },
        {
          warm: true,
          model: runtimeOptions.model || null,
          chrome: !!runtimeOptions.chrome,
          includePartial: !!runtimeOptions.includePartial,
          skillIsolation: !!skillIsolation,
          lifecycleHooks: !!lifecycleHooks,
          clearMinGapSeconds: runtimeOptions.clearMinGapSeconds ?? 600,
          sessionSettingsPath,
          logPath: orch.logPath,
          extraArgs: runtimeOptions.extraArgs || [],
        },
      );
    }
    if (runtimeId === 'copilot') {
      return new AdapterClass(
        { agentDir: cwd, log, env: process.env },
        {
          model: runtimeOptions.model || null,
          reasoning: runtimeOptions.reasoning || null,
          onUsage: (record) => orch.appendUsage(record),
        },
      );
    }
    throw new Error(`supervised mode: runtime not supported: ${runtimeId}`);
  };

  let adapter = buildAdapter();
  await adapter.spawn();

  let currentSleep = backoff.minSeconds;
  let freshContext = true;
  let consecutiveFailures = 0;

  while (!stopping) {
    if (!adapter.isAlive()) {
      log('adapter process gone — respawning');
      const resumeId = adapter.sessionId;
      adapter = buildAdapter();
      await adapter.spawn(resumeId || null);
      freshContext = true;
      await delay(2000);
      continue;
    }

    if (orch.consumeFlag(orch.clearFlagPath)) {
      if (adapter.supportsClearSession()) {
        log('clear-session flag → clearing history (runtime supports in-session clear)');
        await adapter.clearSession();
        freshContext = true;
      } else {
        log('clear-session flag → full respawn (runtime is stateless per-tick)');
        await adapter.terminate();
        adapter = buildAdapter();
        await adapter.spawn();
        freshContext = true;
      }
    }

    if (orch.consumeFlag(orch.resetFlagPath)) {
      log('reset-session flag → full adapter respawn');
      await adapter.terminate();
      adapter = buildAdapter();
      await adapter.spawn();
      freshContext = true;
      continue;
    }

    const tickStart = Date.now() / 1000;
    const useFull = freshContext || !adapter.supportsWarmSession();
    const prompt = useFull ? fullTickPrompt : lightTickPrompt;
    log(`tick begin (fresh_context=${freshContext}, runtime=${runtimeId})`);

    const sent = await adapter.send(prompt);
    if (!sent) {
      consecutiveFailures += 1;
      log(`send failed; respawning (fails=${consecutiveFailures})`);
      await adapter.terminate();
      adapter = buildAdapter();
      await adapter.spawn();
      freshContext = true;
      await delay(Math.min(5000 * consecutiveFailures, 60000));
      continue;
    }

    const result = await adapter.waitForResult(timeoutSeconds);
    freshContext = false;

    if (result === null) {
      log('tick did not complete (timeout or EOF)');
      consecutiveFailures += 1;
    } else {
      log('tick ok');
      consecutiveFailures = 0;
      if (trackCost && runtimeId === 'claude') {
        try {
          const line = tickCostLine(cwd, tickStart);
          if (line) log(line);
        } catch (err) {
          log(`tick-cost error: ${err.message}`);
        }
      }
    }

    if (orch.consumeFlag(orch.didWorkPath)) {
      currentSleep = backoff.minSeconds;
    } else {
      currentSleep = Math.min(currentSleep + backoff.stepSeconds, backoff.maxSeconds);
    }
    const reason =
      currentSleep === backoff.minSeconds
        ? 'work done → MIN_SLEEP'
        : `idle (+${backoff.stepSeconds}s, cap ${backoff.maxSeconds}s)`;

    const elapsed = Math.floor(Date.now() / 1000 - tickStart);
    log(`tick took ${elapsed}s; sleeping ${currentSleep}s — ${reason}`);
    await sleepWithWake(currentSleep, reason);
  }

  log('shutting down adapter session');
  await adapter.terminate();
  log('agent-loop exit');

  // ---- inner helpers ----------------------------------------------------

  async function sleepWithWake(seconds, reason) {
    orch.publishSleep('sleeping', seconds, reason);
    if (wakeQueue.length) {
      wakeQueue.length = 0;
      orch.publishSleep('tick', seconds, reason);
      return;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeWaiter = null;
        resolve('timer');
      }, seconds * 1000);
      wakeWaiter = { resolve, timer };
    });
    orch.publishSleep('tick', seconds, reason);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
