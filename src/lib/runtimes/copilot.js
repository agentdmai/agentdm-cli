// GitHub Copilot CLI runtime adapter.
//
// Copilot does not support an interactive stream-json mode, so each tick
// spawns a fresh `copilot -p <prompt>` process. Continuity across ticks
// is maintained via --resume=<sessionId>; clear-session simply drops the
// stored session id so the next tick starts fresh.
//
// Per-tick token usage is parsed from ~/.copilot/session-state/<id>/events.jsonl
// (the session.shutdown event carries modelMetrics) and appended to
// .orchestrator/usage.jsonl for the dashboard's usage panel.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseAdapter } from './base.js';

export class CopilotAdapter extends BaseAdapter {
  /**
   * @param {object} ctx see BaseAdapter
   * @param {object} [options]
   * @param {string|null} [options.model=null]      --model
   * @param {string|null} [options.reasoning=null]  --effort low|medium|high|xhigh
   * @param {(record: object) => void} [options.onUsage]   per-tick usage record sink
   */
  constructor(ctx, options = {}) {
    super(ctx);
    this.model = options.model || null;
    this.reasoning = options.reasoning || null;
    this.onUsage = typeof options.onUsage === 'function' ? options.onUsage : null;

    this._proc = null;
    this._initialized = false;
    this._pendingResolve = null;
    this._currentBuffers = null;
    this._timeoutTimer = null;
  }

  supportsWarmSession() {
    // Copilot does not keep a long-lived process, but --resume preserves
    // conversation context, so a LIGHT tick prompt is still meaningful.
    return true;
  }

  supportsClearSession() {
    return true;
  }

  // ----------------------------------------------------------------------
  // simple-mode tick (used by end-user `npx agentdm start`)
  // ----------------------------------------------------------------------

  async runOneTick({ tickPrompt, onLine }) {
    return new Promise((resolve) => {
      const cmd = this._buildArgs(tickPrompt);
      let child;
      try {
        child = spawn('copilot', cmd, {
          cwd: this.agentDir,
          stdio: ['ignore', 'pipe', 'inherit'],
          env: this.env,
        });
      } catch (err) {
        process.stderr.write(`Could not start GitHub Copilot CLI: ${err.message}\n`);
        resolve(1);
        return;
      }

      let buf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          if (onLine) onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.stdout.on('end', () => {
        if (buf.trim() && onLine) onLine(buf);
      });
      child.on('exit', (code) => resolve(code ?? 0));
      child.on('error', (err) => {
        process.stderr.write(`Could not start GitHub Copilot CLI: ${err.message}\n`);
        resolve(1);
      });
    });
  }

  _buildArgs(prompt) {
    const cmd = [
      '-p',
      prompt,
      '--allow-all-tools',
      '--allow-all-paths',
      '--no-ask-user',
      '--output-format',
      'json',
    ];
    if (this._sessionId) cmd.push(`--resume=${this._sessionId}`);
    const mcpCfg = path.join(this.agentDir, '.mcp.json');
    if (existsSync(mcpCfg)) cmd.push('--additional-mcp-config', `@${mcpCfg}`);
    if (this.model) cmd.push('--model', this.model);
    if (this.reasoning) cmd.push('--effort', this.reasoning);
    return cmd;
  }

  // ----------------------------------------------------------------------
  // warm-style supervised lifecycle (BaseAdapter)
  // ----------------------------------------------------------------------

  async spawn(resumeId = null) {
    this._sessionId = resumeId;
    this._initialized = true;

    const agentsMd = path.join(this.agentDir, 'AGENTS.md');
    if (existsSync(agentsMd)) {
      this.log('CopilotAdapter: AGENTS.md found — will be auto-loaded as system prompt');
    } else {
      this.log(
        'CopilotAdapter: WARN — no AGENTS.md found; agent will run without a system prompt',
      );
    }
    if (resumeId) {
      this.log(`CopilotAdapter: will resume session ${resumeId}`);
    } else {
      this.log('CopilotAdapter: starting fresh session');
    }
  }

  async terminate() {
    if (this._proc && this._proc.exitCode === null) {
      try {
        this._proc.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      try {
        // best-effort wait
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            try {
              this._proc?.kill('SIGKILL');
            } catch {
              /* gone */
            }
            resolve();
          }, 10000);
          this._proc.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } catch {
        /* ignore */
      }
    }
    this._proc = null;
    this._initialized = false;
  }

  isAlive() {
    // Always "alive" while initialised — there's no persistent process to die.
    return this._initialized;
  }

  async send(prompt) {
    const cmd = this._buildArgs(prompt);
    this.log(`CopilotAdapter: spawning copilot (session=${this._sessionId || 'new'})`);
    try {
      this._proc = spawn('copilot', cmd, {
        cwd: this.agentDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.env,
      });
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        this.log(
          'CopilotAdapter: ERROR — `copilot` not found. Install the GitHub Copilot CLI and run `copilot login`.',
        );
      } else {
        this.log(`CopilotAdapter: spawn error: ${err.message}`);
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
        this.log(`CopilotAdapter: turn timeout after ${timeoutSeconds}s`);
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
      for (const line of stderr.split('\n')) this.log(`copilot stderr: ${line}`);
    }
    this._proc = null;
    if (exited === 'timeout' || exited === 'error') return null;
    if (exited.code !== 0) {
      this.log(`CopilotAdapter: CLI exited with code ${exited.code}`);
      return null;
    }

    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    let resultEvent = null;
    let assistantText = '';
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === 'assistant.message') {
        assistantText = ev.data?.content || '';
      } else if (ev.type === 'result') {
        resultEvent = ev;
      }
    }
    if (!resultEvent) {
      this.log('CopilotAdapter: no result event in output');
      return null;
    }
    const newSid = resultEvent.sessionId;
    if (newSid) {
      this._sessionId = newSid;
      this.log(`CopilotAdapter: session_id=${newSid}`);
      this._appendUsage(newSid, resultEvent.timestamp || '');
    }
    this.log(`CopilotAdapter: tick ok (response ${assistantText.length} chars)`);
    if (assistantText) {
      for (const line of assistantText.split('\n')) this.log(`  > ${line}`);
    }
    return { type: 'result', output: assistantText, raw: resultEvent };
  }

  async clearSession() {
    this.log('CopilotAdapter: clearing session (next tick will start fresh)');
    this._sessionId = null;
    return true;
  }

  // ----------------------------------------------------------------------
  // Usage parsing — reads ~/.copilot/session-state/<id>/events.jsonl after
  // the session ends. The session.shutdown event has modelMetrics with
  // exact input/output/cacheRead/cacheWrite token counts per model.
  // ----------------------------------------------------------------------

  _appendUsage(sessionId, tickTs) {
    if (!this.onUsage) return;
    const statePath = path.join(
      os.homedir(),
      '.copilot',
      'session-state',
      sessionId,
      'events.jsonl',
    );
    let raw;
    try {
      raw = readFileSync(statePath, 'utf8');
    } catch {
      this.log(`CopilotAdapter: session state not found for ${sessionId} — no usage recorded`);
      return;
    }
    let shutdown = null;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let ev;
      try {
        ev = JSON.parse(t);
      } catch {
        continue;
      }
      if (ev.type === 'session.shutdown') {
        shutdown = ev;
        break;
      }
    }
    if (!shutdown) {
      this.log(`CopilotAdapter: no session.shutdown event for ${sessionId}`);
      return;
    }
    const modelMetrics = shutdown.data?.modelMetrics || {};
    const ts = tickTs || shutdown.timestamp || '';
    let totalIn = 0;
    let totalOut = 0;
    for (const [model, metrics] of Object.entries(modelMetrics)) {
      const u = metrics.usage || {};
      const record = {
        ts,
        session_id: sessionId,
        model,
        input_tokens: u.inputTokens || 0,
        output_tokens: u.outputTokens || 0,
        cache_read_tokens: u.cacheReadTokens || 0,
        cache_write_tokens: u.cacheWriteTokens || 0,
        reasoning_tokens: u.reasoningTokens || 0,
        premium_requests: metrics.requests?.cost || 0,
      };
      totalIn += record.input_tokens;
      totalOut += record.output_tokens;
      this.onUsage(record);
    }
    this.log(`CopilotAdapter: usage recorded (in=${totalIn} out=${totalOut})`);
  }
}
