// Installer for the agentdm Pi extension.
//
// Pi (pi.dev) has no .mcp.json — it loads TypeScript extensions auto-discovered
// from `.pi/extensions/*/index.ts`. So where the coding-agent flow writes an
// MCP server entry, the Pi flow drops a generated extension here instead.
//
// The extension source is kept as a placeholder template (shipped verbatim in
// the npm package) so its TypeScript stays readable. We substitute the grid URL
// and the agent's token at install time. The token is embedded the same way a
// coding agent inlines it into .mcp.json — callers warn the user to gitignore.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTDM_MCP_URL } from './mcp-config.js';

const TEMPLATE_PATH = fileURLToPath(new URL('./pi-extension-template.ts', import.meta.url));

// Auto-discovered location, relative to the project dir. Pi loads any
// `.pi/extensions/<name>/index.ts` once the project is trusted (PiAdapter
// passes `-a` so trust is granted non-interactively).
export const PI_EXTENSION_DIR = path.join('.pi', 'extensions', 'agentdm');
export const PI_EXTENSION_FILE = path.join(PI_EXTENSION_DIR, 'index.ts');

/**
 * Render the extension source with the grid URL and token baked in.
 * Values are JSON-encoded so they land as valid TS string literals (an empty
 * token becomes `""`, which makes the extension fall back to AGENTDM_API_KEY).
 */
export function renderPiExtension({ token = '', gridUrl = AGENTDM_MCP_URL } = {}) {
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  return template
    .replaceAll('__AGENTDM_GRID_URL__', JSON.stringify(gridUrl))
    .replaceAll('__AGENTDM_TOKEN__', JSON.stringify(token || ''));
}

/**
 * Write `.pi/extensions/agentdm/index.ts` under projectDir.
 * @returns {{ filePath: string, dir: string, embeddedToken: boolean }}
 */
export function installPiExtension(projectDir, { token = '', gridUrl = AGENTDM_MCP_URL } = {}) {
  const dir = path.join(projectDir, PI_EXTENSION_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = path.join(projectDir, PI_EXTENSION_FILE);
  writeFileSync(filePath, renderPiExtension({ token, gridUrl }), 'utf8');
  return { filePath, dir, embeddedToken: !!token };
}
