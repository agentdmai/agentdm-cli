import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const AGENTDM_MCP_URL = 'https://api.agentdm.ai/mcp/v1/grid';

export const AGENTDM_MCP_ENTRY = {
  command: 'npx',
  args: ['-y', 'mcp-remote', AGENTDM_MCP_URL],
};

export function writeMcpConfig(filePath) {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (!existsSync(filePath)) {
    const config = { mcpServers: { agentdm: AGENTDM_MCP_ENTRY } };
    writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    return { created: true, added: true };
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`failed to parse ${filePath}: ${err.message}`);
  }

  raw.mcpServers ||= {};
  if (raw.mcpServers.agentdm) {
    return { created: false, added: false };
  }
  raw.mcpServers.agentdm = AGENTDM_MCP_ENTRY;
  writeFileSync(filePath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  return { created: false, added: true };
}
