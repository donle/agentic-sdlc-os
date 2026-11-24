FROM node:22-alpine

WORKDIR /app

# Install git for GitWorktreeSandboxManager and postgresql-client for psql-based PG sync/queries
RUN apk add --no-cache git postgresql-client

COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts || npm install --ignore-scripts

COPY tsconfig.json tsconfig.ui.json eslint.config.mjs .prettierrc.json ./
COPY configs ./configs
COPY src ./src
COPY tests ./tests

RUN npm run build:ui && npm run typecheck

EXPOSE 4300

ENV NODE_ENV=production
ENV PORT=4300

CMD ["npm", "start"]
