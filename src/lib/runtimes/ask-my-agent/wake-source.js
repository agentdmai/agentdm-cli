// Wake source: subscribes to apps/web's SSE /api/agents/wake-stream and
// invokes onWake() on every push notification. Keeps a slow fallback poll
// (default 60s) so a dropped SSE never silently strands a message — if the
// stream is healthy, the fallback fires harmlessly into onWake() which is
// already idempotent (read_messages returns the same set).
//
// The EventSource npm package (unlike the browser built-in) supports
// custom request headers, which we need for Bearer auth.

import { EventSource } from 'eventsource';

export function startWakeSource({
  wakeUrl,
  apiKey,
  fallbackPollMs = 60_000,
  onWake,
  log = () => {},
}) {
  let closed = false;
  let es = null;
  let pollTimer = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;

  const scheduleReconnect = () => {
    if (closed) return;
    if (reconnectTimer) return;
    // Exponential backoff capped at 30s. Reset on a successful frame.
    const delay = Math.min(1000 * 2 ** reconnectAttempts, 30_000);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  };

  const open = () => {
    if (closed) return;
    try {
      es = new EventSource(wakeUrl, {
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${apiKey}` },
          }),
      });
    } catch (err) {
      log(`[wake] EventSource construction failed: ${err.message}; falling back to poll`);
      scheduleReconnect();
      return;
    }

    es.onopen = () => {
      reconnectAttempts = 0;
      log('[wake] connected');
    };

    es.onmessage = () => {
      reconnectAttempts = 0;
      Promise.resolve(onWake('sse')).catch((err) =>
        log(`[wake] onWake handler threw: ${err?.message ?? err}`),
      );
    };

    es.onerror = () => {
      // EventSource fires error on disconnect AND during connect attempts.
      // Close explicitly so we control reconnect timing instead of letting
      // the library reconnect at its own pace.
      try {
        es?.close();
      } catch {
        /* swallow */
      }
      es = null;
      scheduleReconnect();
    };
  };

  const startFallbackPoll = () => {
    pollTimer = setInterval(() => {
      if (closed) return;
      Promise.resolve(onWake('poll')).catch((err) =>
        log(`[wake] fallback poll handler threw: ${err?.message ?? err}`),
      );
    }, fallbackPollMs);
  };

  open();
  startFallbackPoll();

  return {
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (es) {
        try {
          es.close();
        } catch {
          /* swallow */
        }
        es = null;
      }
    },
  };
}
