# syntax=docker/dockerfile:1

###############################################################################
# Builder: install all deps, compile TypeScript -> dist/
###############################################################################
FROM node:20-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production dependencies only for the runtime image.
RUN npm prune --omit=dev

###############################################################################
# Runtime: slim image with compiled output + production node_modules
###############################################################################
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The bundled Claude CLI writes config/auth state under $HOME and
# $CLAUDE_CONFIG_DIR; point them at a writable path inside the container.
ENV HOME=/app
ENV CLAUDE_CONFIG_DIR=/app/.claude

# The Claude Agent SDK spawns a bundled `claude` CLI subprocess at runtime which
# talks to the Anthropic API over TLS and may shell out to git. Install the OS
# packages it needs (ca-certificates for TLS, git for repo probing). ripgrep is
# not required while agentic tools are disabled.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Container App ingress target_port = 80; the app listens on 80.
EXPOSE 80
CMD ["node", "dist/index.js"]
