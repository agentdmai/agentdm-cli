import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveWebAppOrigin, exchangeOAuthForApiKey } from '../src/lib/oauth.js';

test('deriveWebAppOrigin: prod grid → app.agentdm.ai', () => {
  assert.equal(
    deriveWebAppOrigin('https://api.agentdm.ai/mcp/v1/grid'),
    'https://app.agentdm.ai',
  );
});

test('deriveWebAppOrigin: localhost :3001 → :3000', () => {
  assert.equal(
    deriveWebAppOrigin('http://localhost:3001/mcp/v1/grid'),
    'http://localhost:3000',
  );
});

test('deriveWebAppOrigin: unset/garbage falls back to prod', () => {
  assert.equal(deriveWebAppOrigin(undefined), 'https://app.agentdm.ai');
  assert.equal(deriveWebAppOrigin('not a url'), 'https://app.agentdm.ai');
});

test('exchangeOAuthForApiKey: POSTs the bearer to /api/oauth/api-key and returns the key', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ apiKey: 'agentdm_static_minted', alias: 'my-agent', agentId: 'a-1' }),
    };
  };

  const out = await exchangeOAuthForApiKey('agentdm_oauth_access', {
    gridUrl: 'https://api.agentdm.ai/mcp/v1/grid',
    fetchImpl,
  });

  assert.deepEqual(out, { apiKey: 'agentdm_static_minted', alias: 'my-agent', agentId: 'a-1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://app.agentdm.ai/api/oauth/api-key');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer agentdm_oauth_access');
});

test('exchangeOAuthForApiKey: surfaces server error detail', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'agent_token_required', message: 'pick an agent, not admin' }),
  });
  await assert.rejects(
    () => exchangeOAuthForApiKey('agentdm_oauth_admin', { fetchImpl }),
    /HTTP 400.*pick an agent, not admin/s,
  );
});

test('exchangeOAuthForApiKey: rejects a 2xx with no apiKey', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  await assert.rejects(
    () => exchangeOAuthForApiKey('agentdm_oauth_access', { fetchImpl }),
    /returned no key/,
  );
});
