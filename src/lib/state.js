import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const STATE_FILE = '.agentdm';
export const STATE_VERSION = 1;

export function stateFilePath(cwd) {
  return path.join(cwd, STATE_FILE);
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
  if (parsed.version !== STATE_VERSION) {
    throw new Error(
      `${p} has version ${parsed.version}, this CLI expects ${STATE_VERSION}. Re-run \`npx agentdm init\`.`,
    );
  }
  return parsed;
}

export function writeState(cwd, state) {
  const p = stateFilePath(cwd);
  const payload = {
    version: STATE_VERSION,
    createdAt: new Date().toISOString(),
    ...state,
  };
  writeFileSync(p, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return p;
}
