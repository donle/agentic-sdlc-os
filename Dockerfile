# Stage 1: Build UI bundle and validate TypeScript without skipping esbuild postinstall scripts
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY tsconfig.json tsconfig.ui.json eslint.config.mjs .prettierrc.json ./
COPY configs ./configs
COPY deploy ./deploy
COPY src ./src

RUN npm run build:ui && npm run typecheck

# Stage 2: Minimal non-root runtime image with prebuilt UI bundle
FROM node:22-alpine AS runtime

WORKDIR /app

# Install git for GitWorktreeSandboxManager, postgresql-client for psql PG sync/queries, and wget for HEALTHCHECK
RUN apk add --no-cache git postgresql-client wget

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts

COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/configs ./configs
COPY --from=builder /app/deploy ./deploy
COPY --from=builder /app/src ./src

RUN mkdir -p /var/lib/agentic-sdlc/runtime-data /var/lib/agentic-sdlc/worktrees /app/.runtime-data \
  && chown -R node:node /app /var/lib/agentic-sdlc

ENV NODE_ENV=production
ENV PORT=4300
ENV LOCAL_PERSISTENCE_DIR=/var/lib/agentic-sdlc/runtime-data
ENV SANDBOX_WORKTREE_ROOT=/var/lib/agentic-sdlc/worktrees

USER node

EXPOSE 4300

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4300}/api/health" >/dev/null 2>&1 || exit 1

CMD ["npm", "run", "start:server"]
