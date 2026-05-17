// MCP aggregator for ask-my-agent.
//
// Opens the agentdm-grid MCP session (streamable HTTP) plus one stdio MCP
// session per enabled tool from src/lib/tools. The tools list comes from
// the `.agentdm` state file (written by init) — each entry names a tool id
// + non-secret state; secrets live in process.env (loaded from .env).
//
// Each tool descriptor owns its own spawn config (toMcpServer), its tool
// name prefix (toolPrefix), and an optional client-side filter (filterTool)
// for runtimes that need an extra read-only layer (e.g., the deprecated
// @modelcontextprotocol/server-github exposes write tools by default).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { findTool } from '../../tools/index.js';

async function openToolMcp(tool, entry) {
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: { ...process.env, ...(entry.env || {}) },
  });
  const client = new Client(
    { name: 'ask-my-agent', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(transport);

  const resp = await client.listTools();
  const safeTools =
    typeof tool.filterTool === 'function'
      ? resp.tools.filter((t) => tool.filterTool(t.name))
      : resp.tools;
  const filteredCount = resp.tools.length - safeTools.length;
  return { client, tools: safeTools, filteredCount };
}

async function openAgentdm(url, apiKey) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  });
  const client = new Client(
    { name: 'ask-my-agent', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(transport);

  const resp = await client.listTools();
  return { client, tools: resp.tools };
}

/**
 * Open the agentdm session plus one MCP session per enabled tool. Returns
 * the agentdm client, a map of tool-id → MCP client, and the unified tool
 * list (with prefix-routed names) that the LLM provider sees.
 *
 * @param {{
 *   agentdmUrl: string,
 *   agentdmApiKey: string,
 *   enabledTools?: Array<{ id: string, state?: object, secretEnvNames?: string[] }>,
 * }} args
 */
export async function openSessions({ agentdmUrl, agentdmApiKey, enabledTools = [] }) {
  const dm = await openAgentdm(agentdmUrl, agentdmApiKey);
  const toolSessions = {};
  const toolDescriptors = {};
  const aggregatedTools = [
    ...dm.tools.map((t) => ({
      name: `agentdm__${t.name}`,
      description: t.description ?? '',
      input_schema: t.inputSchema ?? {},
    })),
  ];

  for (const t of enabledTools) {
    const def = findTool(t.id);
    if (!def) {
      process.stdout.write(
        `[warn] tool "${t.id}" is enabled in .agentdm but not registered in src/lib/tools/. Skipping.\n`,
      );
      continue;
    }
    // Re-pair secrets at runtime from process.env (loaded by dotenv from
    // .env). Each tool persists its env-var names in state so we know what
    // to look up here.
    const secrets = {};
    for (const k of t.secretEnvNames || []) {
      if (process.env[k]) secrets[k] = process.env[k];
    }
    const entry = def.toMcpServer({ secrets, state: t.state || {} });

    try {
      const session = await openToolMcp(def, entry);
      toolSessions[t.id] = session.client;
      toolDescriptors[t.id] = def;
      if (session.filteredCount > 0) {
        process.stdout.write(
          `[info] ${t.id}: filtered ${session.filteredCount} write-capable tool(s); ` +
            'underlying credentials are the real boundary.\n',
        );
      }
      const prefix = def.toolPrefix || t.id;
      for (const tool of session.tools) {
        aggregatedTools.push({
          name: `${prefix}__${tool.name}`,
          description: tool.description ?? '',
          input_schema: tool.inputSchema ?? {},
        });
      }
    } catch (err) {
      process.stdout.write(
        `[warn] ${t.id} MCP server unavailable: ${err.message}\n`,
      );
    }
  }

  // Per-tool constraint lines (e.g., "only reference these repos"). The
  // caller appends these after the user-configured system prompt so the
  // model sees role + capabilities first, then the concrete constraints
  // captured at init time.
  const toolSystemLines = [];
  for (const t of enabledTools) {
    const def = toolDescriptors[t.id];
    if (!def?.describeFor) continue;
    const line = def.describeFor(t.state || {});
    if (line) toolSystemLines.push(line);
  }

  return {
    agentdm: dm.client,
    toolSessions,
    toolDescriptors,
    tools: aggregatedTools,
    toolSystemLines,
    async close() {
      try {
        await dm.client.close();
      } catch {
        /* swallow */
      }
      for (const client of Object.values(toolSessions)) {
        try {
          await client.close();
        } catch {
          /* swallow */
        }
      }
    },
  };
}
