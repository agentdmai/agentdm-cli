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
  let lastErrorDetail = '';

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
      lastErrorDetail = '';
      log('[wake] connected');
    };

    es.onmessage = () => {
      reconnectAttempts = 0;
      Promise.resolve(onWake('sse')).catch((err) =>
        log(`[wake] onWake handler threw: ${err?.message ?? err}`),
      );
    };

    es.onerror = (err) => {
      // EventSource fires error on disconnect AND during connect attempts.
      // The `eventsource` package's ErrorEvent carries `code` (the HTTP status
      // when the failure was an HTTP response) and `message`. Surface it: a
      // silently-failing wake stream looks identical to an idle one and strands
      // every message on the slow fallback poll. Dedupe so a persistent failure
      // (e.g. a 401) doesn't spam once per backoff attempt.
      const detail = err?.code
        ? `HTTP ${err.code}${err?.message ? ` ${err.message}` : ''}`
        : err?.message || 'disconnected';
      if (detail !== lastErrorDetail) {
        log(
          `[wake] stream error (${detail}); falling back to ${Math.round(
            fallbackPollMs / 1000,
          )}s poll, retrying`,
        );
        lastErrorDetail = detail;
      }
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
