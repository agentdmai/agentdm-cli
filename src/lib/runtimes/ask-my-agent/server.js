// ask-my-agent worker. Self-driving runner that:
//
//   1. Opens MCP sessions (agentdm grid + optional read-only GitHub MCP).
//   2. Subscribes to apps/web /api/agents/wake-stream for push notifications.
//   3. On every wake (plus a slow fallback poll), calls
//      agentdm.read_messages, dispatches a single LLM turn per message,
//      and replies via agentdm.send_message(to=reply_to, message=text).
//
// The runner does not care whether a message is a DM, channel post, or
// public-chat visitor question — the grid sets `channel` and `reply_to`
// uniformly. The runner just sends the reply back to whatever the grid
// gave it as `reply_to`.

import { openSessions } from './mcp.js';
import { startWakeSource } from './wake-source.js';
import { buildProvider } from './providers/index.js';

const DEFAULT_GRID_URL = 'https://api.agentdm.ai/mcp/v1/grid';

function defaultWakeUrlFor(gridUrl) {
  // The wake endpoint lives on apps/web, not the grid. Derive a sensible
  // default from the grid URL — production maps api.agentdm.ai →
  // app.agentdm.ai; localhost maps :3001 → :3000. Operators can override
  // explicitly via AGENTDM_WAKE_URL.
  try {
    const u = new URL(gridUrl);
    if (u.host.startsWith('api.agentdm.ai')) {
      return 'https://app.agentdm.ai/api/agents/wake-stream';
    }
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      return `http://${u.hostname}:3000/api/agents/wake-stream`;
    }
    // Last resort: same origin with the wake path. Probably wrong in
    // multi-host topologies, but better than nothing.
    return `${u.protocol}//${u.host}/api/agents/wake-stream`;
  } catch {
    return 'https://app.agentdm.ai/api/agents/wake-stream';
  }
}

function extractMessages(callToolResult) {
  // The MCP SDK shape: { content: [{ type: "text", text: "<json>" }] }
  // The grid serializes read_messages output as a JSON object
  // { messages: [...], hasMore: bool } or a bare array (older shapes).
  const content = callToolResult?.content ?? [];
  for (const block of content) {
    const text = block?.text;
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.messages)) return parsed.messages;
      if (parsed && typeof parsed === 'object') return [parsed];
    } catch {
      /* malformed text — skip */
    }
  }
  return [];
}

async function handleOne(msg, provider, tools, agentdm, log) {
  const replyTo = msg?.reply_to;
  const messageText = msg?.message;
  if (typeof replyTo !== 'string' || typeof messageText !== 'string') {
    log(`[skip] malformed message: ${JSON.stringify(msg)}`);
    return;
  }
  const channel = msg.channel ?? 'direct';
  const user = msg.user ?? 'unknown';
  log(`[recv] channel=${channel} from=${user} reply_to=${replyTo}`);

  const messages = [{ role: 'user', content: messageText }];
  const chunks = [];
  try {
    for await (const evt of provider.chat(messages, tools)) {
      if (evt.type === 'token' && typeof evt.delta === 'string') {
        chunks.push(evt.delta);
      } else if (evt.type === 'tool_call') {
        // v1 stub: log tool calls; future patch routes gh_* back to the
        // github-mcp-server session and feeds results in.
        log(`[tool] ${JSON.stringify(evt.tool_call)}`);
      }
    }
  } catch (err) {
    log(`[error] provider.chat: ${err?.message ?? err}`);
    try {
      await agentdm.callTool({
        name: 'send_message',
        arguments: { to: replyTo, message: `Sorry, I hit an error: ${err?.message ?? err}` },
      });
    } catch {
      /* best-effort */
    }
    return;
  }

  const replyText = chunks.join('').trim() || '(no reply)';
  try {
    await agentdm.callTool({
      name: 'send_message',
      arguments: { to: replyTo, message: replyText },
    });
    log(`[send] reply_to=${replyTo} chars=${replyText.length}`);
  } catch (err) {
    log(`[error] send_message: ${err?.message ?? err}`);
  }
}

/**
 * Run the worker until aborted. Honors the AbortSignal so the caller (CLI
 * Ctrl+C handler) can stop the loop and clean up.
 */
export async function runAskMyAgent({
  agentdmUrl = DEFAULT_GRID_URL,
  agentdmApiKey,
  wakeUrl,
  githubPat,
  provider,
  fallbackPollMs = 60_000,
  log = (m) => process.stderr.write(`${m}\n`),
  signal,
}) {
  if (!agentdmApiKey) throw new Error('agentdmApiKey is required');
  if (!provider) throw new Error('provider is required');

  const sessions = await openSessions({
    agentdmUrl,
    agentdmApiKey,
    githubPat,
  });
  log(`[runner] online. Tools: ${sessions.tools.length}.`);

  let inFlight = Promise.resolve();
  let stopped = false;

  const onWake = async (source) => {
    if (stopped) return;
    // Serialize ticks so a wake during a long LLM turn doesn't fan out
    // into concurrent read_messages calls.
    await inFlight;
    if (stopped) return;
    inFlight = (async () => {
      let result;
      try {
        result = await sessions.agentdm.callTool({
          name: 'read_messages',
          arguments: {},
        });
      } catch (err) {
        log(`[error] read_messages failed (${source}): ${err?.message ?? err}`);
        return;
      }
      const messages = extractMessages(result);
      if (messages.length === 0) return;
      log(`[wake:${source}] ${messages.length} message(s)`);
      for (const msg of messages) {
        if (stopped) return;
        await handleOne(msg, provider, sessions.tools, sessions.agentdm, log);
      }
    })();
    await inFlight;
  };

  const wake = startWakeSource({
    wakeUrl: wakeUrl ?? defaultWakeUrlFor(agentdmUrl),
    apiKey: agentdmApiKey,
    fallbackPollMs,
    onWake,
    log,
  });
  log(`[runner] subscribed to wake stream.`);

  // Fire one initial drain so a runner that started after the visitor
  // sent a message doesn't sit idle until the next wake.
  await onWake('startup');

  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    wake.close();
    try {
      await inFlight;
    } catch {
      /* swallow */
    }
    await sessions.close();
    log('[runner] stopped.');
  };

  if (signal) {
    if (signal.aborted) {
      await cleanup();
      return;
    }
    signal.addEventListener('abort', () => {
      void cleanup();
    });
  }

  // Block until aborted. The wake source drives all work via its callbacks.
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      if (stopped) {
        clearInterval(tick);
        resolve();
      }
    }, 1000);
  });
}

export { defaultWakeUrlFor, extractMessages };
