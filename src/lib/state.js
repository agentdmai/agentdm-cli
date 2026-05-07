// .agentdm settings file (per-project, written by `init`).
//
// Schema versions:
//   v1 (legacy): { version, createdAt, agent, intervalSeconds, tickPrompt }
//   v2 (current): adds optional supervised-mode fields. End-user `start`
//                 with a v1 file behaves exactly as before.
//
// readState() always returns a v2-shaped object — v1 files are upgraded
// in memory and never rewritten unless writeState() is called.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const STATE_FILE = '.agentdm';
export const CURRENT_STATE_VERSION = 2;

export function stateFilePath(cwd) {
  return path.join(cwd, STATE_FILE);
}

const DEFAULT_TICK_PROMPT =
  "Read your inbox on agentdm. For each message, do what it asks and reply when you're done. " +
  'If the inbox is empty, exit quietly.';

export const DEFAULT_FULL_TICK_PROMPT = [
  'Polling tick (fresh session). Follow your instructions file (CLAUDE.md or AGENTS.md) — ',
  'that file owns what work you do.',
  '',
  'SETUP (silent):',
  '1. Read ./MEMORY.md if present. Keep it under 2 KB; consolidate, don\'t append.',
  '2. Check ./.orchestrator/tools.json. If missing or older than 60 minutes, ',
  'overwrite with a names-only snapshot of every mcp__* tool you can see, grouped ',
  'by server: {"generated_at":"<ISO>","total_tools":<int>,"servers":[{"name":"<server>",',
  '"tools":[{"name":"<full_tool_name>"}]}]}.',
  '',
  'Then run your polling loop per your instructions file.',
  '',
  'END OF TICK: overwrite ./status.json.',
  ' • If this task is FINISHED, `touch ./.orchestrator/clear-session` so the wrapper ',
  '   wipes conversation history before the next tick.',
  ' • If you took any meaningful action this tick, `touch ./.orchestrator/did-work` ',
  '   so the wrapper resets backoff to MIN_SLEEP. Idle ticks must NOT touch did-work.',
].join('\n');

export const DEFAULT_LIGHT_TICK_PROMPT = [
  'Next polling tick (instructions + MEMORY.md + tools already in context from the ',
  'prior tick of this session). Do NOT re-read them unless something changed. Follow ',
  'your instructions file.',
  '',
  'END OF TICK: overwrite ./status.json. If the task is FINISHED, `touch ./.orchestrator/clear-session`. ',
  'If you took any meaningful action, `touch ./.orchestrator/did-work`.',
].join('\n');

/**
 * Normalise any persisted state shape to v2 in memory. v1 files load
 * verbatim; missing v2 fields stay undefined so the caller can apply
 * defaults (env vars + supervised flag both can override).
 */
function upgrade(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (!parsed.version) parsed.version = 1;
  if (parsed.version === 1) {
    // No structural change — v2 only adds optional fields.
    return { ...parsed, version: 2, _upgradedFromV1: true };
  }
  return parsed;
}

export function readState(cwd) {
  const p = stateFilePath(cwd);
  if (!existsSync(p)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`failed to parse ${p}: ${err.message}`);
  }
  if (typeof parsed.version !== 'number' || parsed.version > CURRENT_STATE_VERSION) {
    throw new Error(
      `${p} has version ${parsed.version}, this CLI expects ${CURRENT_STATE_VERSION}. Re-run \`npx agentdm init\`.`,
    );
  }
  return upgrade(parsed);
}

export function writeState(cwd, state) {
  const p = stateFilePath(cwd);
  const payload = {
    version: CURRENT_STATE_VERSION,
    createdAt: new Date().toISOString(),
    ...state,
  };
  delete payload._upgradedFromV1;
  writeFileSync(p, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return p;
}

/** Default tick prompt the `init` wizard offers as the seed. */
export { DEFAULT_TICK_PROMPT };
