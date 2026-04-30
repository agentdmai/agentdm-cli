import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import kleur from 'kleur';
import { AGENTDM_MCP_URL } from './mcp-config.js';

const MCP_AUTH_DIR = path.join(os.homedir(), '.mcp-auth');
const TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 500;
const SETTLE_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function snapshotTokenFiles() {
  if (!existsSync(MCP_AUTH_DIR)) return [];
  const out = [];
  for (const sub of readdirSync(MCP_AUTH_DIR)) {
    const subDir = path.join(MCP_AUTH_DIR, sub);
    let entries;
    try {
      if (!statSync(subDir).isDirectory()) continue;
      entries = readdirSync(subDir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('_tokens.json')) continue;
      const full = path.join(subDir, f);
      try {
        out.push({ path: full, mtime: statSync(full).mtimeMs });
      } catch {}
    }
  }
  return out;
}

export async function loginViaOAuth() {
  const before = snapshotTokenFiles();
  const beforePaths = new Set(before.map((f) => f.path));
  const startedAt = Date.now();

  const child = spawn('npx', ['-y', 'mcp-remote', AGENTDM_MCP_URL], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  let stopped = false;
  const stopChild = () => {
    if (stopped) return;
    stopped = true;
    try {
      child.kill('SIGTERM');
    } catch {}
  };

  if (process.env.AGENTDM_DEBUG) {
    child.stdout.on('data', (b) => process.stderr.write(kleur.dim(b.toString())));
    child.stderr.on('data', (b) => process.stderr.write(kleur.dim(b.toString())));
  } else {
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
  }

  const sigintHandler = () => {
    stopChild();
  };
  process.once('SIGINT', sigintHandler);

  let exitCode = null;
  let exitError = null;
  child.on('exit', (code) => {
    exitCode = code;
  });
  child.on('error', (err) => {
    exitError = err;
  });

  try {
    while (Date.now() - startedAt < TIMEOUT_MS) {
      await sleep(POLL_MS);

      if (exitError) throw exitError;

      const current = snapshotTokenFiles();
      const fresh = current.filter(
        (f) => !beforePaths.has(f.path) || f.mtime >= startedAt,
      );
      if (fresh.length > 0) {
        await sleep(SETTLE_MS);
        const newest = fresh.sort((a, b) => b.mtime - a.mtime)[0];
        const tokens = readTokens(newest.path);
        if (tokens?.access_token) return tokens.access_token;
      }

      if (exitCode != null && exitCode !== 0) {
        throw new Error(
          `Sign-in helper (mcp-remote) exited with code ${exitCode} before a token was issued. Try again, or use the paste-token option.`,
        );
      }
    }
    throw new Error('Sign-in timed out after 5 minutes. Try again.');
  } finally {
    process.removeListener('SIGINT', sigintHandler);
    stopChild();
  }
}

function readTokens(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}
