import prompts from 'prompts';

async function pickAllowedOrigins({ onCancel }) {
  const { origins } = await prompts(
    [
      {
        type: 'text',
        name: 'origins',
        message:
          'Allowed origins (semicolon-separated, e.g. https://example.com;https://docs.foo.com; blank = anywhere)',
        initial: '',
      },
    ],
    { onCancel },
  );
  return (origins || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    // Bare domain? Prepend https:// so Playwright's allowlist matches.
    .map((s) => (/^https?:\/\//i.test(s) ? s : `https://${s}`));
}

export const webBrowserTool = {
  id: 'web-browser',
  label: 'Web Browser',
  description: 'Visit URLs and read pages to answer questions (Playwright, headless).',
  toolPrefix: 'web',

  // Playwright MCP needs no secrets — it just spawns a browser locally.
  secretEnvNames: [],

  async configure({ onCancel }) {
    const allowedOrigins = await pickAllowedOrigins({ onCancel });
    return {
      secrets: {},
      state: { allowedOrigins },
    };
  },

  // --headless: no Chrome window pops up during agent ticks.
  // --isolated: in-memory profile, no cookies/state persisted to disk.
  // --allowed-origins: per-tool domain allowlist; the user's chosen list is
  //   passed through. Note Playwright's docs warn this is NOT a hard
  //   security boundary (doesn't follow redirects), so treat as a hint.
  toMcpServer({ state }) {
    const args = ['-y', '@playwright/mcp@latest', '--headless', '--isolated'];
    const allowed = state?.allowedOrigins || [];
    if (allowed.length > 0) {
      args.push('--allowed-origins', allowed.join(';'));
    }
    return { command: 'npx', args, env: {} };
  },

  describeFor(state) {
    if (!state?.allowedOrigins?.length) return null;
    return `When using web browser tools, only visit these origins: ${state.allowedOrigins.join(', ')}.`;
  },
};
