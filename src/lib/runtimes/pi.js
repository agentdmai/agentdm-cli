// Pi (pi.dev) runtime adapter.
//
// Pi is a minimal, extensible coding agent. It has no .mcp.json; instead it
// auto-loads TypeScript extensions from `.pi/extensions/`. `agentdm init`
// installs the agentdm extension there (see lib/pi-extension.js), which mirrors
// the grid's tools as native Pi tools. This adapter just drives Pi headlessly.
//
// End-user mode (`npx agentdm start`) goes through runOneTick(): a fresh
// `pi -p "<prompt>"` per tick, stateless, matching the original loop model.
// `-a` trusts the project for this run so the extension and AGENTS.md load
// without an interactive prompt.
//
// The BaseAdapter lifecycle methods (spawn/send/waitForResult) are implemented
// stateless on top of the same print mode, so a future supervised loop can
// drive Pi too. Pi keeps no warm process between ticks, so supportsWarmSession
// is false and the supervisor always sends the full tick prompt.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BaseAdapter } from './base.js';

export class PiAdapter extends BaseAdapter {
  /**
   * @param {object} ctx see BaseAdapter
   * @param {object} [options]
   * @param {string|null} [options.model=null]   --model override (e.g. "sonnet:high")
   * @param {string[]} [options.extraArgs=[]]     extra flags appended verbatim
   */
  constructor(ctx, options = {}) {
    super(ctx);
    this.model = options.model || null;
    this.extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs.slice() : [];

    this._proc = null;
    this._initialized = false;
  }

  supportsWarmSession() {
    return false;
  }

  supportsClearSession() {
    return false;
  }

  // Build the headless argv. Prompt is positional and goes last so it can't be
  // mistaken for a flag value.
  _buildArgs(prompt) {
    const args = ['-p', '-a'];
    if (this.model) args.push('--model', this.model);
    args.push(...this.extraArgs);
    args.push(prompt);
    return args;
  }

  // ----------------------------------------------------------------------
  // simple-mode tick (used by end-user `npx agentdm start`)
  // ----------------------------------------------------------------------

  // onLine is accepted for signature parity with the other adapters but unused:
  // Pi's print mode emits human-readable text, so we stream its stdout/stderr
  // straight to the terminal rather than re-parsing it through the Claude
  // stream-json renderer.
  // eslint-disable-next-line no-unused-vars
  async runOneTick({ tickPrompt, onLine }) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn('pi', this._buildArgs(tickPrompt), {
          cwd: this.agentDir,
          stdio: ['ignore', 'inherit', 'inherit'],
          env: this.env,
        });
      } catch (err) {
        process.stderr.write(`Could not start Pi: ${err.message}\n`);
        resolve(1);
        return;
      }
      child.on('exit', (code) => resolve(code ?? 0));
      child.on('error', (err) => {
        process.stderr.write(`Could not start Pi: ${err.message}\n`);
        resolve(1);
      });
    });
  }

  // ----------------------------------------------------------------------
  // stateless lifecycle (BaseAdapter) — fresh `pi -p` per send
  // ----------------------------------------------------------------------

  async spawn(_resumeId = null) {
    this._initialized = true;
    const agentsMd = path.join(this.agentDir, 'AGENTS.md');
    if (existsSync(agentsMd)) {
      this.log('PiAdapter: AGENTS.md found — Pi will load it as project instructions');
    } else {
      this.log('PiAdapter: WARN — no AGENTS.md; Pi will run without a system prompt');
    }
    const ext = path.join(this.agentDir, '.pi', 'extensions', 'agentdm', 'index.ts');
    if (!existsSync(ext)) {
      this.log('PiAdapter: WARN — agentdm extension missing; run `npx agentdm init` to install it');
    }
  }

  async terminate() {
    if (this._proc && this._proc.exitCode === null) {
      try {
        this._proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            this._proc?.kill('SIGKILL');
          } catch {
            /* gone */
          }
          resolve();
        }, 10000);
        this._proc?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this._proc = null;
    this._initialized = false;
  }

  isAlive() {
    // No persistent process between ticks; "alive" while initialised.
    return this._initialized;
  }

  async send(prompt) {
    try {
      this._proc = spawn('pi', this._buildArgs(prompt), {
        cwd: this.agentDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.env,
      });
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        this.log('PiAdapter: ERROR — `pi` not found. Install with `npm i -g @mariozechner/pi-coding-agent`.');
      } else {
        this.log(`PiAdapter: spawn error: ${err.message}`);
      }
      return false;
    }
    return true;
  }

  async waitForResult(timeoutSeconds) {
    if (!this._proc) return null;
    const proc = this._proc;
    const stdoutChunks = [];
    const stderrChunks = [];
    proc.stdout.on('data', (b) => stdoutChunks.push(b));
    proc.stderr.on('data', (b) => stderrChunks.push(b));

    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.log(`PiAdapter: turn timeout after ${timeoutSeconds}s`);
        try {
          proc.kill('SIGKILL');
        } catch {
          /* gone */
        }
        resolve('timeout');
      }, timeoutSeconds * 1000);
      proc.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ code });
      });
      proc.once('error', () => {
        clearTimeout(timer);
        resolve('error');
      });
    });

    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    if (stderr) {
      for (const line of stderr.split('\n')) this.log(`pi stderr: ${line}`);
    }
    this._proc = null;
    if (exited === 'timeout' || exited === 'error') return null;
    if (exited.code !== 0) {
      this.log(`PiAdapter: pi exited with code ${exited.code}`);
      return null;
    }
    const output = Buffer.concat(stdoutChunks).toString('utf8').trim();
    return { type: 'result', output };
  }
}
