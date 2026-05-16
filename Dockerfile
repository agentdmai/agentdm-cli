# Container image for `agentdm start` (Ask My Agent runtime).
#
# Designed for Railway, Fly, Render, or any platform that runs a long-lived
# Node process from env vars. The runtime reads everything from process.env:
#   AGENTDM_API_KEY         — the AgentDM grid Bearer token
#   MODEL_PROVIDER          — anthropic | openai | huggingface
#   ANTHROPIC_API_KEY | OPENAI_API_KEY | HF_TOKEN  (one of)
#   HUGGINGFACE_MODEL       — required when MODEL_PROVIDER=huggingface
#   AGENTDM_STATE_JSON      — packed .agentdm state (provider, model,
#                             systemPrompt, tools[]). Container has no
#                             .agentdm on disk; start.js reads this env.
#   GITHUB_PERSONAL_ACCESS_TOKEN  — when the github tool is enabled
#
# Debian-slim (not Alpine) because Playwright MCP downloads Chromium on
# first use and needs glibc. The first wake of an agent that uses the
# browser tool will pay a one-time ~300MB download; subsequent restarts
# reuse the npx cache.

FROM node:20-slim

ENV NODE_ENV=production
ENV AGENTDM_AGENT_DIR=/app

# System packages Playwright/Chromium needs at runtime. Kept minimal — the
# rest of Chromium's deps get pulled by Playwright's own postinstall when
# it's first invoked via npx.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      libnss3 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libcups2 \
      libdrm2 \
      libxkbcommon0 \
      libxcomposite1 \
      libxdamage1 \
      libxrandr2 \
      libgbm1 \
      libpango-1.0-0 \
      libcairo2 \
      libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only production deps; layer caches well as long as package*.json
# don't change.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

# `start` exits if it can't find configuration; check env at boot.
CMD ["node", "src/index.js", "start"]
