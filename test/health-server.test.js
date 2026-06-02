// Tests for the hosted-deploy health server.
//
// Run with: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHealthServer } from '../src/lib/health-server.js';

test('startHealthServer: returns null when no port is configured', async () => {
  assert.equal(await startHealthServer({}), null);
  assert.equal(await startHealthServer({ port: '' }), null);
  assert.equal(await startHealthServer({ port: undefined }), null);
});

test('startHealthServer: returns null for an invalid port', async () => {
  assert.equal(await startHealthServer({ port: 'nope' }), null);
  assert.equal(await startHealthServer({ port: -1 }), null);
});

test('startHealthServer: binds and answers 200', async () => {
  // Port 0 lets the OS assign a free port — avoids collisions in CI.
  const server = await startHealthServer({ port: 0, host: '127.0.0.1' });
  assert.ok(server, 'expected a server instance');
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.equal((await res.text()).trim(), 'ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
