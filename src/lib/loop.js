import { spawn } from 'node:child_process';
import kleur from 'kleur';

const sleep = (ms) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    process.once('SIGINT', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
    });
  });

function runOnce({ agent, cwd, tickPrompt }) {
  return new Promise((resolve) => {
    const args = agent.buildArgs({ tickPrompt });
    const child = spawn(agent.bin, args, {
      cwd,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      process.stderr.write(kleur.red(`agent spawn error: ${err.message}\n`));
      resolve(1);
    });
  });
}

export async function runLoop({ agent, cwd, intervalSeconds, tickPrompt }) {
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    process.stderr.write(kleur.yellow('\nctrl-c — finishing this tick then exiting...\n'));
  });

  while (!stopping) {
    const now = new Date().toLocaleTimeString();
    process.stdout.write(kleur.dim(`\n[${now}] tick — ${agent.label}\n`));
    const code = await runOnce({ agent, cwd, tickPrompt });
    if (code !== 0) {
      process.stderr.write(kleur.red(`tick exited with code ${code}\n`));
    }
    if (stopping) break;
    try {
      await sleep(intervalSeconds * 1000);
    } catch (err) {
      if (err.code === 'ABORTED') break;
      throw err;
    }
  }
  process.stdout.write(kleur.dim('\nloop stopped.\n'));
}
