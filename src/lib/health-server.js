// Minimal HTTP health server for hosted deploys.
//
// The ask-my-agent worker is outbound-only: it subscribes to the grid wake
// stream over SSE and never accepts inbound requests. Platforms like Railway,
// Render, and Fly treat a service as a web app and will mark it crashed
// (failed port detection / healthcheck) — or sleep it — when nothing is
// listening on $PORT. Binding a tiny 200-OK server keeps that detection happy.
//
// This does NOT stop "App Sleeping" / serverless from sleeping an idle service
// that receives no inbound traffic — that is disabled on the platform side at
// deploy time (see src/lib/deploy/railway.js). The two fixes are complementary.

import http from 'node:http';

/**
 * Start a health server on `port` (typically process.env.PORT). Resolves once
 * it is listening, or with null when no usable port is configured or the bind
 * fails — a health-server problem must never take down the worker.
 *
 * Pass port 0 to let the OS assign a free port (handy in tests).
 *
 * @param {{ port?: string|number, host?: string, log?: (m: string) => void }} [opts]
 * @returns {Promise<import('node:http').Server | null>}
 */
export function startHealthServer({ port, host = '0.0.0.0', log = () => {} } = {}) {
  if (port === undefined || port === null || port === '') return Promise.resolve(null);
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 0) {
    log(`[health] ignoring invalid PORT: ${port}`);
    return Promise.resolve(null);
  }

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok\n');
  });

  return new Promise((resolve) => {
    const onInitialError = (err) => {
      log(`[health] could not bind ${host}:${portNum}: ${err?.message ?? err}`);
      resolve(null);
    };
    server.once('error', onInitialError);
    server.listen(portNum, host, () => {
      server.removeListener('error', onInitialError);
      // After a successful bind, keep listening for late errors but never
      // throw — the wake stream, not HTTP, is the worker's real job.
      server.on('error', (err) => log(`[health] server error: ${err?.message ?? err}`));
      log(`[health] listening on ${host}:${server.address().port}`);
      resolve(server);
    });
  });
}
