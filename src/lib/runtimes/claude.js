// Claude Code runtime adapter.
//
// Two execution modes:
//
//   - simple (default for `npx agentdm start`): spawn `claude -p "<prompt>"`
//     fresh per tick. Stateless; no /clear; matches the original CLI.
//
//   - warm (supervised mode or `warmSession: true`): spawn `claude -p
//     --input-format stream-json` once and keep it alive across ticks.
//     /clear wipes conversation history without dropping the session.
//     MCP, skills, and the parsed CLAUDE.md stay hot.
//
// In supervised mode the adapter also writes session-settings.json and
// passes it via --settings, gating Skill() permissions so the harness
// can only invoke skills that live under .claude/skills/<name>/.

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { BaseAdapter } from './base.js';
import { enumerateSkills } from '../orchestrator.js';

export class ClaudeAdapter extends BaseAdapter {
  /**
   * @param {object} ctx see BaseAdapter
   * @param {object} [options]
   * @param {boolean} [options.warm=false]            persistent stream-json session
   * @param {string|null} [options.model=null]        --model override
   * @param {boolean} [options.chrome=false]          --chrome flag
   * @param {boolean} [options.includePartial=false]  --include-partial-messages
   * @param {boolean} [options.skillIsolation=false]  emit allow-list of skills
   * @param {boolean} [options.lifecycleHooks=false]  log SessionStart/UserPromptSubmit
   * @param {number} [options.clearMinGapSeconds=600] rate-limit /clear calls
   * @param {string} [options.sessionSettingsPath]    where to write session-settings.json
   * @param {string} [options.logPath]                where lifecycle hooks tee to
   * @param {string[]} [options.extraArgs=[]]
   */
  constructor(ctx, options = {}) {
    super(ctx);
    this.warm = !!options.warm;
    this.model = options.model || null;
    this.chrome = !!options.chrome;
    this.includePartial = !!options.includePartial;
    this.skillIsolation = !!options.skillIsolation;
    this.lifecycleHooks = !!options.lifecycleHooks;
    this.clearMinGapSeconds = options.clearMinGapSeconds ?? 600;
    this.sessionSettingsPath =
      options.sessionSettingsPath ||
      path.join(this.agentDir, '.orchestrator', 'session-settings.json');
    this.logPath = options.logPath || path.join(this.agentDir, '.orchestrator', 'agent-loop.log');
    this.extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs.slice() : [];

    this._proc = null;
    this._eventQueue = [];
    this._waiters = []; // queue of { resolve, reject, deadline, timer }
    this._sawEof = false;
    this._lastClearMonotonic = 0;
  }

  supportsWarmSession() {
    return this.warm;
  }

  supportsClearSession() {
    return this.warm;
  }

  // ----------------------------------------------------------------------
  // session-settings.json (warm mode only)
  // ----------------------------------------------------------------------

  _writeSessionSettings() {
    if (!this.skillIsolation && !this.lifecycleHooks) return null;

    /** @type {{ permissions: object, hooks: object }} */
    const settings = { permissions: {}, hooks: {} };

    if (this.skillIsolation) {
      const skills = enumerateSkills(this.agentDir);
      if (skills.length) {
        const allow = [];
        for (const n of skills) {
          allow.push(`Skill(${n})`);
          allow.push(`Skill(${n} *)`);
        }
        settings.permissions = { deny: ['Skill'], allow };
        this.log(`skill isolation active: only [${skills.join(' ')}] allowed`);
      }
    }

    if (this.lifecycleHooks) {
      const tpl = (event, note) =>
        `date -u "+[%FT%TZ] hook:${event} — ${note}" >> ${JSON.stringify(this.logPath)} 2>&1`;
      settings.hooks = {
        SessionStart: [
          {
            matcher: '*',
            hooks: [
              { type: 'command', command: tpl('SessionStart', 'context + MCP + skills loading…') },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: tpl(
                  'UserPromptSubmit',
                  'all loaded (CLAUDE.md + MCP + skills); running tick',
                ),
              },
            ],
          },
        ],
      };
    }

    writeFileSync(this.sessionSettingsPath, JSON.stringify(settings, null, 2));
    return this.sessionSettingsPath;
  }

  _baseArgs() {
    const args = ['--print', '--dangerously-skip-permissions'];
    const mcpCfg = path.join(this.agentDir, '.mcp.json');
    if (existsSync(mcpCfg)) {
      args.push('--mcp-config', '.mcp.json', '--strict-mcp-config');
    }
    if (this.model) args.push('--model', this.model);
    if (this.chrome) args.push('--chrome');
    args.push(...this.extraArgs);
    return args;
  }

  // ----------------------------------------------------------------------
  // simple-mode tick (matches original CLI behavior)
  // ----------------------------------------------------------------------

  /**
   * Run one tick in simple mode. Spawns `claude -p <prompt>`, drains stdout
   * line-by-line into onLine, returns the process exit code. Used by the
   * end-user loop — supervised mode goes through spawn()/send() instead.
   */
  async runOneTick({ tickPrompt, onLine }) {
    const args = [
      ...this._baseArgs(),
      '--verbose',
      '--output-format',
      'stream-json',
      tickPrompt,
    ];

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn('claude', args, {
          cwd: this.agentDir,
          stdio: ['ignore', 'pipe', 'inherit'],
          env: this.env,
        });
      } catch (err) {
        process.stderr.write(`Could not start Claude Code: ${err.message}\n`);
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
        process.stderr.write(`Could not start Claude Code: ${err.message}\n`);
        resolve(1);
      });
    });
  }

  // ----------------------------------------------------------------------
  // warm-mode lifecycle (BaseAdapter implementation)
  // ----------------------------------------------------------------------

  async spawn(resumeId = null) {
    if (!this.warm) {
      throw new Error('ClaudeAdapter.spawn() requires warm mode; use runOneTick() instead');
    }

    const settingsPath = this._writeSessionSettings();

    const args = [
      ...this._baseArgs(),
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ];
    if (this.includePartial) args.push('--include-partial-messages');
    if (settingsPath) args.push('--settings', settingsPath);
    if (resumeId) args.push('--resume', resumeId);

    this.log(`spawning claude: claude ${args.join(' ')}`);
    this._proc = spawn('claude', args, {
      cwd: this.agentDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
    });
    this.log(`claude pid=${this._proc.pid}`);
    this._sawEof = false;

    // Drain stdout line-by-line; queue parsed events for waitForResult.
    const rl = readline.createInterface({ input: this._proc.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        this.log(`claude stdout (non-json): ${trimmed.slice(0, 200)}`);
        return;
      }
      this._dispatchEvent(ev);
    });
    rl.on('close', () => {
      this._sawEof = true;
      this._dispatchEvent({ type: '__eof__' });
    });

    const errRl = readline.createInterface({ input: this._proc.stderr });
    errRl.on('line', (line) => {
      if (line) this.log(`claude stderr: ${line}`);
    });

    this._proc.on('exit', (code) => {
      this.log(`claude exited rc=${code ?? '?'}`);
      this._sawEof = true;
      this._dispatchEvent({ type: '__eof__' });
    });
  }

  _dispatchEvent(ev) {
    const t = ev.type;
    if (t === 'system' && ev.subtype === 'init' && ev.session_id) {
      this._sessionId = ev.session_id;
      this.log(`session_id=${ev.session_id}`);
    }
    if (t === 'result' || t === '__eof__') {
      const w = this._waiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.resolve(t === '__eof__' ? null : ev);
        return;
      }
      // No waiter yet: buffer the result for the next call.
      this._eventQueue.push(ev);
    }
  }

  async terminate() {
    if (!this._proc) return;
    try {
      this._proc.stdin?.end();
    } catch {
      /* already closed */
    }
    const proc = this._proc;
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, 30000);
    await exited;
    clearTimeout(timer);
    this._proc = null;
  }

  isAlive() {
    return !!(this._proc && this._proc.exitCode === null && !this._sawEof);
  }

  async send(prompt) {
    if (!this._proc || !this._proc.stdin || !this._proc.stdin.writable) return false;
    const msg = { type: 'user', message: { role: 'user', content: prompt } };
    try {
      return await new Promise((resolve) => {
        this._proc.stdin.write(JSON.stringify(msg) + '\n', (err) => resolve(!err));
      });
    } catch (err) {
      this.log(`send failed: ${err.message}`);
      return false;
    }
  }

  async waitForResult(timeoutSeconds) {
    // First drain any queued result.
    while (this._eventQueue.length) {
      const ev = this._eventQueue.shift();
      if (ev.type === '__eof__') return null;
      if (ev.type === 'result') return ev;
    }
    if (!this.isAlive() && this._sawEof) {
      this.log('claude already exited before waitForResult');
      return null;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.log(`turn timeout after ${timeoutSeconds}s`);
        const idx = this._waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this._waiters.splice(idx, 1);
        resolve(null);
      }, timeoutSeconds * 1000);
      this._waiters.push({
        resolve,
        timer,
        deadline: Date.now() + timeoutSeconds * 1000,
      });
    });
  }

  async clearSession() {
    if (!this.warm) return false;
    const sinceLast = (Date.now() - this._lastClearMonotonic) / 1000;
    if (this._lastClearMonotonic > 0 && sinceLast < this.clearMinGapSeconds) {
      const remaining = Math.max(0, Math.ceil(this.clearMinGapSeconds - sinceLast));
      this.log(`clear-session rate-limited (${remaining}s remaining until next allowed clear)`);
      return false;
    }
    if (!(await this.send('/clear'))) return false;
    const result = await this.waitForResult(30);
    if (result) {
      this._lastClearMonotonic = Date.now();
      return true;
    }
    return false;
  }
}
