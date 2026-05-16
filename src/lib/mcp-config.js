import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const AGENTDM_MCP_URL = 'https://api.agentdm.ai/mcp/v1/grid';

// When token is null/undefined, mcp-remote handles OAuth itself (refreshing
// from ~/.mcp-auth). When a static API token is supplied, embed it as a header.
export function buildAgentdmRemoteEntry(token) {
  const args = ['-y', 'mcp-remote', AGENTDM_MCP_URL];
  if (token) {
    args.push('--header', `Authorization: Bearer ${token}`);
  }
  return { command: 'npx', args };
}

/**
 * Merge a map of MCP server entries into .mcp.json. Existing servers not in
 * `servers` are preserved. Servers in `servers` overwrite any same-name
 * entry. Returns the set of names that were created vs replaced so callers
 * can report clearly.
 */
export function writeMcpServers(filePath, servers) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let raw = { mcpServers: {} };
  let fileExisted = existsSync(filePath);
  if (fileExisted) {
    try {
      raw = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new Error(`failed to parse ${filePath}: ${err.message}`);
    }
    raw.mcpServers ||= {};
  }

  const created = [];
  const replaced = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (raw.mcpServers[name]) replaced.push(name);
    else created.push(name);
    raw.mcpServers[name] = entry;
  }

  writeFileSync(filePath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return { fileCreated: !fileExisted, created, replaced };
}

// Back-compat wrappers — keep the old single-server API working for the
// `set` command and any caller that only writes the agentdm entry.
export function writeAgentdmEntry(filePath, entry) {
  return writeMcpServers(filePath, { agentdm: entry });
}

export function writeMcpConfig(filePath, token) {
  return writeAgentdmEntry(filePath, buildAgentdmRemoteEntry(token));
}
