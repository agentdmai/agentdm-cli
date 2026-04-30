import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const AGENTDM_MCP_URL = 'https://api.agentdm.ai/mcp/v1/grid';

export function buildAgentdmRemoteEntry(token) {
  return {
    command: 'npx',
    args: [
      '-y',
      'mcp-remote',
      AGENTDM_MCP_URL,
      '--header',
      `Authorization: Bearer ${token}`,
    ],
  };
}

export function buildAgentdmHttpEntry(token) {
  return {
    url: AGENTDM_MCP_URL,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
}

export function writeAgentdmEntry(filePath, entry) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (!existsSync(filePath)) {
    writeFileSync(
      filePath,
      JSON.stringify({ mcpServers: { agentdm: entry } }, null, 2) + '\n',
      'utf8',
    );
    return { created: true, replaced: false };
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`failed to parse ${filePath}: ${err.message}`);
  }

  raw.mcpServers ||= {};
  const existed = !!raw.mcpServers.agentdm;
  raw.mcpServers.agentdm = entry;
  writeFileSync(filePath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return { created: false, replaced: existed };
}

export function writeMcpConfig(filePath, token) {
  return writeAgentdmEntry(filePath, buildAgentdmRemoteEntry(token));
}

export function writeMcpConfigHttp(filePath, token) {
  return writeAgentdmEntry(filePath, buildAgentdmHttpEntry(token));
}
