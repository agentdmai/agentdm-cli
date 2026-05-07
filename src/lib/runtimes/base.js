// Base adapter interface for agent runtimes.
//
// Each runtime (Claude Code, GitHub Copilot, …) implements BaseAdapter so
// the supervised loop can drive any of them through the same lifecycle.

export class BaseAdapter {
  /**
   * @param {{ agentDir: string, log: (msg: string) => void, env?: Record<string, string|undefined> }} ctx
   */
  constructor(ctx) {
    this.agentDir = ctx.agentDir;
    this.log = ctx.log;
    this.env = ctx.env || process.env;
    this._sessionId = null;
  }

  // ---- lifecycle ----------------------------------------------------------

  // Start the underlying process or session. resumeId is an opaque token
  // from a previous run (adapter may ignore if resumption is not supported).
  // eslint-disable-next-line no-unused-vars
  async spawn(_resumeId = null) {
    throw new Error('spawn() not implemented');
  }

  // Shut down the session gracefully, then forcefully if needed.
  async terminate() {
    throw new Error('terminate() not implemented');
  }

  // True if the session process is still running.
  isAlive() {
    throw new Error('isAlive() not implemented');
  }

  // ---- communication ------------------------------------------------------

  // Send a tick prompt to the agent. Returns true on successful delivery.
  // eslint-disable-next-line no-unused-vars
  async send(_prompt) {
    throw new Error('send() not implemented');
  }

  // Block until the agent signals turn completion or timeout. Returns the
  // result event dict on success, null on timeout/error.
  // eslint-disable-next-line no-unused-vars
  async waitForResult(_timeoutSeconds) {
    throw new Error('waitForResult() not implemented');
  }

  // ---- optional capabilities ---------------------------------------------

  get sessionId() {
    return this._sessionId;
  }

  set sessionId(value) {
    this._sessionId = value;
  }

  // True if the runtime can wipe conversation history mid-session.
  // When false, the loop treats clear-session as a full respawn.
  supportsClearSession() {
    return false;
  }

  // Send the runtime-specific clear command. Only called when
  // supportsClearSession() is true. Returns true on success.
  async clearSession() {
    return false;
  }

  // True if this runtime keeps a warm session across ticks (so a LIGHT
  // tick prompt makes sense). Stateless-per-tick runtimes return false.
  supportsWarmSession() {
    return false;
  }
}
