import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

// mcp-remote keys cached OAuth state by md5(serverUrl). When the user picks
// "Open browser to sign in", any cached token would silently bypass the browser
// and the poll loop would time out waiting for a fresh token file. Wipe just
// the entries for our URL so other servers' caches stay intact.
function clearCachedAuthForAgentdm() {
  const hash = createHash('md5').update(AGENTDM_MCP_URL).digest('hex');
  for (const sub of listMcpRemoteSubdirs()) {
    let entries;
    try {
      entries = readdirSync(sub);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.startsWith(hash + '_')) continue;
      try {
        rmSync(path.join(sub, f), { force: true });
      } catch {}
    }
  }
}

export async function loginViaOAuth() {
  cleanStaleLocks();
  clearCachedAuthForAgentdm();

  const before = snapshotTokenFiles();
  const beforePaths = new Set(before.map((f) => f.path));
  const startedAt = Date.now();

  const child = spawn('npx', ['-y', 'mcp-remote', AGENTDM_MCP_URL], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    // Own process group so we can kill npx + its mcp-remote grandchild together.
    detached: true,
  });

  const debug = !!process.env.AGENTDM_DEBUG;
  let stopped = false;
  const stopChild = () => {
    if (stopped) return;
    stopped = true;
    // Stop reading from the child so its remaining output can't ref the loop.
    try { child.stdout?.removeAllListeners('data'); } catch {}
    try { child.stderr?.removeAllListeners('data'); } catch {}
    // Kill the whole process group (npx + mcp-remote grandchild) so neither
    // lingers as an orphan holding the OAuth callback port.
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
    // Unref every handle the spawn created so the parent's event loop doesn't
    // wait on them — close stdin (write end) so libuv can release that pipe,
    // unref the read pipes, and unref the ChildProcess wrapper itself.
    try { child.stdin?.end(); } catch {}
    try { child.stdin?.unref(); } catch {}
    try { child.stdout?.unref(); } catch {}
    try { child.stderr?.unref(); } catch {}
    try { child.unref(); } catch {}
  };

  let stdioReady = false;
  let urlPrinted = false;
  const onStderr = (buf) => {
    const text = buf.toString();
    if (debug) process.stderr.write(kleur.dim(text));
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
            kleur.dim('If your browser didn\'t open, visit:\n  ') +
            kleur.cyan(authUrl) +
            '\n\n',
        );
      }
    }
  };
  child.stderr.on('data', onStderr);
  child.stdout.on('data', (buf) => {
    if (debug) process.stderr.write(kleur.dim('[stdout] ' + buf.toString()));
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
  // Calling an auth-required tool forces 401 -> OAuth flow.
  // list_channels is read-only and takes no args.
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'list_channels', arguments: {} },
  });
}

function readTokens(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The web app origin that hosts the OAuth + REST API, derived from the grid
 * URL without any network call: production api.agentdm.ai → app.agentdm.ai;
 * localhost :3001 → :3000.
 *
 * @param {string} [gridUrl] defaults to the built-in grid URL.
 * @returns {string}
 */
export function deriveWebAppOrigin(gridUrl) {
  try {
    const u = new URL(gridUrl || AGENTDM_MCP_URL);
    if (u.host.startsWith('api.agentdm.ai')) return 'https://app.agentdm.ai';
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      return `http://${u.hostname}:3000`;
    }
    return `${u.protocol}//${u.host}`;
  } catch {
    return 'https://app.agentdm.ai';
  }
}

/**
 * Exchange a freshly-minted OAuth access token for a long-lived static API
 * key (POST /api/oauth/api-key). This is what lets a one-time browser sign-in
 * produce a non-expiring credential we can store and reuse forever — the same
 * shape as a pasted API token. Returns { apiKey, alias, agentId }.
 *
 * @param {string} accessToken OAuth access token from loginViaOAuth().
 * @param {{ gridUrl?: string, fetchImpl?: typeof fetch }} [opts]
 */
export async function exchangeOAuthForApiKey(accessToken, { gridUrl, fetchImpl = fetch } = {}) {
  const url = `${deriveWebAppOrigin(gridUrl)}/api/oauth/api-key`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
  } catch (err) {
    throw new Error(`Could not reach ${url} to issue an API key: ${err?.message ?? err}`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.message || j?.error || '';
    } catch {
      detail = (await res.text().catch(() => '')).slice(0, 200);
    }
    throw new Error(
      `Could not exchange sign-in for an API key (HTTP ${res.status})${detail ? `: ${detail}` : ''}.`,
    );
  }
  const body = await res.json();
  if (!body?.apiKey) throw new Error('API key exchange returned no key.');
  return { apiKey: body.apiKey, alias: body.alias ?? null, agentId: body.agentId ?? null };
}
