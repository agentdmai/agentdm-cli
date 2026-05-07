// Legacy compatibility shim. The runtime registry moved to
// src/lib/runtimes/index.js so the adapter classes can own their own
// argv construction. Keep AGENTS + whichAgent exported here so any
// out-of-tree importers (init, start, third-party scripts) still work.
//
// New code should import from './runtimes/index.js' directly.

export { AGENTS, RUNTIMES, whichAgent } from './runtimes/index.js';
