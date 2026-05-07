// Supervised-mode control-file contract.
//
// Files written and consumed under <agentDir>/<stateDir>/ (default
// .orchestrator/) so a parent supervisor can observe and steer the loop:
//
//   sleep.json         wrapper writes; supervisor reads (sleep state badge)
//   agent-loop.log     wrapper appends; supervisor tails
//   session-settings.json  claude adapter writes; passed via --settings
//   tools.json         agent writes (mcp tool snapshot); wrapper just cleans on start
//   did-work           agent touches => reset backoff to MIN_SLEEP
//   clear-session      agent touches => /clear (or respawn) before next tick
//   reset-session      agent or supervisor touches => full adapter respawn
//   last-start.json    supervisor writes on spawn; wrapper does not touch
//   usage.jsonl        copilot adapter appends per-tick token counts
//
// End-user mode (`npx agentdm start` without a supervisor) does not touch
// any of these. The Orchestrator instance is only created when supervised
// mode is active.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

function utcIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class Orchestrator {
  /**
   * @param {string} agentDir absolute path to the agent's working directory
   * @param {string} stateDir relative state-dir name (default ".orchestrator")
   */
  constructor(agentDir, stateDir = '.orchestrator') {
    this.agentDir = agentDir;
    this.stateDir = path.join(agentDir, stateDir);
    mkdirSync(this.stateDir, { recursive: true });

    this.logPath = path.join(this.stateDir, 'agent-loop.log');
    this.didWorkPath = path.join(this.stateDir, 'did-work');
    this.clearFlagPath = path.join(this.stateDir, 'clear-session');
    this.resetFlagPath = path.join(this.stateDir, 'reset-session');
    this.sleepJsonPath = path.join(this.stateDir, 'sleep.json');
    this.toolsJsonPath = path.join(this.stateDir, 'tools.json');
    this.sessionSettingsPath = path.join(this.stateDir, 'session-settings.json');
    this.usageJsonlPath = path.join(this.stateDir, 'usage.jsonl');
  }

  // ---- logging ------------------------------------------------------------

  log(line) {
    const stamp = utcIso();
    const s = `[${stamp}] ${line}\n`;
    try {
      process.stdout.write(s);
    } catch {
      /* ignore broken pipe on shutdown */
    }
    try {
      appendFileSync(this.logPath, s, { encoding: 'utf8' });
    } catch {
      /* best-effort */
    }
  }

  // ---- sleep.json ---------------------------------------------------------

  publishSleep(state, seconds, reason) {
    const now = Math.floor(Date.now() / 1000);
    const data = {
      state,
      current_sleep_seconds: seconds,
      reason,
      updated_at_epoch: now,
    };
    if (state === 'sleeping') data.sleep_until_epoch = now + seconds;
    try {
      writeFileSync(this.sleepJsonPath, JSON.stringify(data, null, 2));
    } catch {
      /* best-effort */
    }
  }

  // ---- flag files ---------------------------------------------------------

  consumeFlag(flagPath) {
    if (!existsSync(flagPath)) return false;
    try {
      unlinkSync(flagPath);
    } catch {
      /* race with another reader is fine */
    }
    return true;
  }

  cleanStaleFlags() {
    for (const p of [
      this.didWorkPath,
      this.clearFlagPath,
      this.resetFlagPath,
      this.toolsJsonPath,
    ]) {
      try {
        unlinkSync(p);
      } catch {
        /* not present */
      }
    }
  }

  // ---- usage.jsonl --------------------------------------------------------

  appendUsage(record) {
    try {
      appendFileSync(this.usageJsonlPath, JSON.stringify(record) + '\n');
    } catch (err) {
      this.log(`appendUsage failed: ${err.message}`);
    }
  }
}

/**
 * Source a dotenv-style file into process.env. Lines like KEY=value or
 * KEY="value with spaces" are accepted; comments and blanks are skipped.
 * Existing env vars are NOT overwritten (so supervisor-supplied vars win).
 */
export function sourceEnv(envPath) {
  if (!existsSync(envPath)) return false;
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    return false;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value.endsWith('"')) ||
        (value[0] === "'" && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return true;
}

/**
 * Enumerate skill names under <agentDir>/.claude/skills/<name>/SKILL.md.
 * Used by the claude adapter to write a permissions allow-list that
 * prevents agents from invoking unrelated skills via the harness.
 */
export function enumerateSkills(agentDir) {
  const skillsDir = path.join(agentDir, '.claude', 'skills');
  if (!existsSync(skillsDir)) return [];
  const out = [];
  let entries;
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }
  for (const name of entries.sort()) {
    const skillMd = path.join(skillsDir, name, 'SKILL.md');
    try {
      if (statSync(path.join(skillsDir, name)).isDirectory() && existsSync(skillMd)) {
        out.push(name);
      }
    } catch {
      /* skip unreadable entry */
    }
  }
  return out;
}
