// Tests for the Pi extension installer and the runtime registry entry.
//
// Run with: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  renderPiExtension,
  installPiExtension,
  PI_EXTENSION_FILE,
} from '../src/lib/pi-extension.js';
import { AGENTDM_MCP_URL } from '../src/lib/mcp-config.js';
import { RUNTIMES } from '../src/lib/runtimes/index.js';

function tmpProject() {
  return mkdtempSync(path.join(os.tmpdir(), 'agentdm-pi-'));
}

test('renderPiExtension: embeds token and grid url, leaves no placeholders', () => {
  const out = renderPiExtension({ token: 'sk-test-123' });
  assert.ok(out.includes('"sk-test-123"'), 'token should be a quoted literal');
  assert.ok(out.includes(JSON.stringify(AGENTDM_MCP_URL)), 'grid url should be embedded');
  assert.ok(!out.includes('__AGENTDM_'), 'no template placeholders should remain');
});

test('renderPiExtension: empty token renders an empty string literal', () => {
  const out = renderPiExtension({});
  // Falls back to AGENTDM_API_KEY at runtime when the literal is empty.
  assert.ok(out.includes('const TOKEN = "" || process.env.AGENTDM_API_KEY'));
});

test('installPiExtension: writes the extension at the auto-discovered path', () => {
  const dir = tmpProject();
  try {
    const res = installPiExtension(dir, { token: 'tok-abc' });
    assert.equal(res.filePath, path.join(dir, PI_EXTENSION_FILE));
    assert.equal(res.embeddedToken, true);
    assert.ok(existsSync(res.filePath), 'index.ts should exist');
    const body = readFileSync(res.filePath, 'utf8');
    assert.ok(body.includes('"tok-abc"'));
    assert.ok(body.includes('export default'), 'should be a Pi extension module');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installPiExtension: no token still installs (runtime reads AGENTDM_API_KEY)', () => {
  const dir = tmpProject();
  try {
    const res = installPiExtension(dir, {});
    assert.equal(res.embeddedToken, false);
    assert.ok(existsSync(res.filePath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry: pi runtime is present and uses pi-extension wiring', () => {
  const pi = RUNTIMES.pi;
  assert.ok(pi, 'pi runtime should be registered');
  assert.equal(pi.bin, 'pi');
  assert.equal(pi.wiring, 'pi-extension');
  assert.equal(pi.supportsLoop, true);
  assert.equal(typeof pi.load, 'function');
});
