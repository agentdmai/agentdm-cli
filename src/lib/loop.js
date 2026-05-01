import { spawn } from 'node:child_process';
import kleur from 'kleur';

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

function runOnce({ agent, cwd, tickPrompt }) {
  return new Promise((resolve) => {
    const args = agent.buildArgs({ tickPrompt });
    const child = spawn(agent.bin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: process.env,
    });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        renderStreamLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stdout.on('end', () => {
      if (buf.trim()) renderStreamLine(buf);
    });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      process.stderr.write(kleur.red(`Could not start ${agent.label}: ${err.message}\n`));
      resolve(1);
    });
  });
}

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
        process.stdout.write(kleur.dim('  · ') + shortToolName(c.name || 'tool') + '\n');
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

export async function runLoop({ agent, cwd, intervalSeconds, tickPrompt }) {
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    process.stderr.write(kleur.yellow('\nctrl-c received. Finishing this run, then stopping.\n'));
  });

  while (!stopping) {
    const now = new Date().toLocaleTimeString();
    process.stdout.write(kleur.dim(`\n[${now}] checking inbox with ${agent.label}\n`));
    const code = await runOnce({ agent, cwd, tickPrompt });
    if (code !== 0) {
      process.stderr.write(kleur.red(`${agent.label} exited with code ${code}.\n`));
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
