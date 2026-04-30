import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const AGENTDM_MCP_URL = 'https://api.agentdm.ai/mcp/v1/grid';

export function buildAgentdmEntry(token) {
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

export function writeMcpConfig(filePath, token) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const entry = buildAgentdmEntry(token);

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
