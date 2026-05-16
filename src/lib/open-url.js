import { spawn } from 'node:child_process';

/**
 * Best-effort cross-platform "open this URL in the default browser". The
 * caller is expected to also print the URL so a user on a headless or
 * permission-restricted shell can still copy it manually.
 */
export function openUrl(url) {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* swallow — the URL was already printed for fallback */
  }
}
