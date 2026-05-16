# Container image for `agentdm start` (Ask My Agent runtime).
#
# Designed for Railway, Fly, Render, or any platform that runs a long-lived
# Node process from env vars. The image installs the published `agentdm`
# package from npm at build time — no source from this repo is baked in —
# so each rebuild picks up the latest release without re-tagging the image.
#
# Required env at container start (set on the platform side; `agentdm
# deploy` does this for you on Railway):
#   AGENTDM_API_KEY     — the AgentDM grid Bearer token
#   MODEL_PROVIDER      — anthropic | openai | huggingface
#   ANTHROPIC_API_KEY | OPENAI_API_KEY | HF_TOKEN  (one of)
#   ANTHROPIC_MODEL | OPENAI_MODEL | HUGGINGFACE_MODEL (one of)
#   AGENTDM_STATE_JSON  — packed .agentdm state (provider, model,
#                         systemPrompt, tools[]). Container has no
#                         .agentdm on disk; start.js reads this env.
#   GITHUB_PERSONAL_ACCESS_TOKEN — when the github tool is enabled
#
# Debian-slim (not Alpine) because Playwright MCP downloads Chromium on
# first use and needs glibc. The first wake of an agent that uses the
# browser tool will pay a one-time ~300 MB download; subsequent restarts
# reuse the npx cache.

FROM node:20-slim

ENV NODE_ENV=production
ENV AGENTDM_AGENT_DIR=/app

# System packages Playwright/Chromium needs at runtime. Pulled at image
# build so the first agent wake doesn't have to apt-install at runtime.
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

# Install agentdm from npm. Re-running the platform's image build fetches
# whatever's tagged `latest` on npm — no source from this repo is needed.
# To pin to a specific release for reproducibility, change `agentdm@latest`
# to `agentdm@<version>` and rebuild.
RUN npm install -g agentdm@latest && npm cache clean --force

CMD ["agentdm", "start"]
