import { spawn } from 'node:child_process';
import kleur from 'kleur';
import { AGENTDM_MCP_URL } from './mcp-config.js';

const CONNECTED_RE = /(connected to remote server|proxy established|listening for messages)/i;
const TIMEOUT_MS = 5 * 60 * 1000;

export async function runOauth() {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['-y', 'mcp-remote', AGENTDM_MCP_URL], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch {}
      fn();
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error('OAuth flow timed out after 5 min — re-run `npx agentdm create agent`.')),
      );
    }, TIMEOUT_MS);

    const onData = (buf) => {
      const text = buf.toString();
      if (process.env.AGENTDM_DEBUG) process.stderr.write(kleur.dim(text));
      if (CONNECTED_RE.test(text)) {
        clearTimeout(timer);
        finish(resolve);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      clearTimeout(timer);
      finish(() => reject(err));
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code === 0) finish(resolve);
      else finish(() => reject(new Error(`mcp-remote exited with code ${code}`)));
    });

    process.once('SIGINT', () => finish(() => reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }))));
  });
}
