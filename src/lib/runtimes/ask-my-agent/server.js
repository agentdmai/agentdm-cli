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

/**
 * Flatten an MCP CallToolResult into a text string the LLM can read back
 * as a tool result. Concatenates every text block; falls back to a
 * JSON.stringify of the whole result for non-text content.
 */
export function extractToolText(callToolResult) {
  if (callToolResult?.isError) {
    const errText = extractTextBlocks(callToolResult);
    return `Tool reported error: ${errText || 'unknown'}`;
  }
  const text = extractTextBlocks(callToolResult);
  if (text) return text;
  try {
    return JSON.stringify(callToolResult ?? {});
  } catch {
    return '';
  }
}

function extractTextBlocks(result) {
  const blocks = result?.content ?? [];
  const texts = [];
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string' && b.text) {
      texts.push(b.text);
    }
  }
  return texts.join('\n');
}

/**
 * Build the tool-dispatcher the providers call when the LLM emits a
 * tool_use. Tool names are prefixed with the source ("agentdm__", "gh__",
 * "<custom>__") — the prefix maps to the corresponding MCP session.
 * Returns text suitable for feeding back into the LLM as a tool_result.
 *
 * @param {{
 *   agentdm: import('@modelcontextprotocol/sdk/client/index.js').Client,
 *   toolSessions: Record<string, import('@modelcontextprotocol/sdk/client/index.js').Client>,
 *   toolDescriptors: Record<string, { id: string, toolPrefix?: string }>,
 * }} args
 */
export function buildCallTool({ agentdm, toolSessions = {}, toolDescriptors = {} }) {
  const prefixToToolId = new Map();
  for (const [id, def] of Object.entries(toolDescriptors)) {
    prefixToToolId.set(def.toolPrefix || id, id);
  }
  return async (rawName, input) => {
    if (typeof rawName !== 'string') {
      throw new Error('tool name must be a string');
    }
    const args = input && typeof input === 'object' ? input : {};
    if (rawName.startsWith('agentdm__')) {
      const name = rawName.slice('agentdm__'.length);
      const result = await agentdm.callTool({ name, arguments: args });
      return extractToolText(result);
    }
    const splitIdx = rawName.indexOf('__');
    if (splitIdx > 0) {
      const prefix = rawName.slice(0, splitIdx);
      const id = prefixToToolId.get(prefix);
      const session = id ? toolSessions[id] : null;
      if (!session) {
        throw new Error(
          `Tool prefix "${prefix}" is not registered for this runner. ` +
            'Re-run init and enable the corresponding tool.',
        );
      }
      const name = rawName.slice(splitIdx + 2);
      const result = await session.callTool({ name, arguments: args });
      return extractToolText(result);
    }
    throw new Error(`Unknown tool name shape: ${rawName}`);
  };
}

async function handleOne(msg, provider, tools, agentdm, callTool, log, systemPrompt) {
  const replyTo = msg?.reply_to;
  const messageText = msg?.message;
  if (typeof replyTo !== 'string' || typeof messageText !== 'string') {
    log(`[skip] malformed message: ${JSON.stringify(msg)}`);
    return;
  }
  const channel = msg.channel ?? 'direct';
  const user = msg.user ?? 'unknown';
  log(`[recv] channel=${channel} from=${user} reply_to=${replyTo}`);

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: messageText });
  const chunks = [];
  try {
    for await (const evt of provider.chat(messages, tools, callTool)) {
      if (evt.type === 'token' && typeof evt.delta === 'string') {
        chunks.push(evt.delta);
      } else if (evt.type === 'tool_use') {
        // Log every tool call + result for visibility. The provider has
        // already executed the call via the callTool callback by the time
        // this event fires.
        const preview =
          typeof evt.result === 'string' && evt.result.length > 200
            ? `${evt.result.slice(0, 200)}…`
            : evt.result;
        log(`[tool] ${evt.name} input=${JSON.stringify(evt.input)} → ${preview}`);
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
  enabledTools = [],
  userSystemPrompt = '',
  provider,
  fallbackPollMs = 60_000,
  // Default logger writes operational lines ([runner], [recv], [send],
  // [wake:*], [info], [warn], [tool]) to stdout so platforms like Railway
  // and Fly don't paint every line red. Only [error]-prefixed lines are
  // routed to stderr so error indicators in dashboards stay meaningful.
  log = (m) => {
    const stream = /^\s*\[error\]/i.test(m) ? process.stderr : process.stdout;
    stream.write(`${m}\n`);
  },
  signal,
}) {
  if (!agentdmApiKey) throw new Error('agentdmApiKey is required');
  if (!provider) throw new Error('provider is required');

  const sessions = await openSessions({
    agentdmUrl,
    agentdmApiKey,
    enabledTools,
  });
  log(`[runner] online. Tools: ${sessions.tools.length}.`);

  // Assemble the system prompt: user-configured role + capabilities first,
  // tool-derived constraints (from describeFor) after.
  const systemPrompt =
    [userSystemPrompt.trim(), ...(sessions.toolSystemLines || [])]
      .filter(Boolean)
      .join('\n') || null;

  const callTool = buildCallTool({
    agentdm: sessions.agentdm,
    toolSessions: sessions.toolSessions,
    toolDescriptors: sessions.toolDescriptors,
  });

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
        await handleOne(
          msg,
          provider,
          sessions.tools,
          sessions.agentdm,
          callTool,
          log,
          systemPrompt,
        );
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
