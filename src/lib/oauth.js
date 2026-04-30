import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import kleur from 'kleur';
import { AGENTDM_MCP_URL } from './mcp-config.js';

const MCP_AUTH_DIR = path.join(os.homedir(), '.mcp-auth');
const TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 500;
const SETTLE_MS = 500;
const STALE_LOCK_MS = 30 * 1000;
const READY_TIMEOUT_MS = 60 * 1000;
const URL_RE = /https?:\/\/[^\s'"`]+/g;
const READY_RE = /Local STDIO server running|Proxy established/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function listMcpRemoteSubdirs() {
  if (!existsSync(MCP_AUTH_DIR)) return [];
  const out = [];
  for (const sub of readdirSync(MCP_AUTH_DIR)) {
    const full = path.join(MCP_AUTH_DIR, sub);
    try {
      if (statSync(full).isDirectory()) out.push(full);
    } catch {}
  }
  return out;
}

function snapshotTokenFiles() {
  const out = [];
  for (const sub of listMcpRemoteSubdirs()) {
    let entries;
    try {
      entries = readdirSync(sub);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('_tokens.json')) continue;
      const full = path.join(sub, f);
      try {
        out.push({ path: full, mtime: statSync(full).mtimeMs });
      } catch {}
    }
  }
  return out;
}

function cleanStaleLocks() {
  for (const sub of listMcpRemoteSubdirs()) {
    let entries;
    try {
      entries = readdirSync(sub);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('_lock.json')) continue;
      const full = path.join(sub, f);
      try {
        const age = Date.now() - statSync(full).mtimeMs;
        if (age > STALE_LOCK_MS) rmSync(full, { force: true });
      } catch {}
    }
  }
}

export async function loginViaOAuth() {
  cleanStaleLocks();

  const before = snapshotTokenFiles();
  const beforePaths = new Set(before.map((f) => f.path));
  const startedAt = Date.now();

  const child = spawn('npx', ['-y', 'mcp-remote', AGENTDM_MCP_URL], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  let stopped = false;
  const stopChild = () => {
    if (stopped) return;
    stopped = true;
    try {
      child.stdin.end();
    } catch {}
    try {
      child.kill('SIGTERM');
    } catch {}
  };

  let stdioReady = false;
  let urlPrinted = false;
  const onStderr = (buf) => {
    const text = buf.toString();
    process.stderr.write(kleur.dim(text));
    if (READY_RE.test(text)) stdioReady = true;
    if (!urlPrinted) {
      const matches = text.match(URL_RE) || [];
      const authUrl = matches.find(
        (u) =>
          /authorize|oauth|login|signin|sign-in/i.test(u) &&
          !u.startsWith(AGENTDM_MCP_URL),
      );
      if (authUrl) {
        urlPrinted = true;
        process.stderr.write(
          '\n' +
            kleur.bold('If your browser didn\'t open, visit:\n  ') +
            kleur.cyan(authUrl) +
            '\n\n',
        );
      }
    }
  };
  child.stderr.on('data', onStderr);
  child.stdout.on('data', (buf) => {
    if (process.env.AGENTDM_DEBUG) {
      process.stderr.write(kleur.dim('[stdout] ' + buf.toString()));
    }
  });

  const sigintHandler = () => stopChild();
  process.once('SIGINT', sigintHandler);

  let exitCode = null;
  let exitError = null;
  child.on('exit', (code) => {
    exitCode = code;
  });
  child.on('error', (err) => {
    exitError = err;
  });

  const send = (msg) => {
    if (!child.stdin.writable) return;
    try {
      child.stdin.write(JSON.stringify(msg) + '\n');
    } catch {}
  };

  triggerAuth(child, () => stdioReady, send).catch(() => {});

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

async function triggerAuth(child, isReady, send) {
  const start = Date.now();
  while (!isReady() && Date.now() - start < READY_TIMEOUT_MS) {
    await sleep(200);
    if (child.exitCode != null) return;
  }
  if (!isReady()) return;

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agentdm-cli', version: '0.3.0' },
    },
  });
  await sleep(800);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await sleep(300);
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
}

function readTokens(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}
