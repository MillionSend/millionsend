# syntax=docker/dockerfile:1

FROM node:24-slim AS deps
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm fetch populates the store from the lockfile alone, so this layer only
# invalidates when dependencies change, not on every source edit.
RUN pnpm fetch

FROM deps AS build
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm --filter @millionsend/web build
RUN pnpm --filter @millionsend/docs build

# The runtime keeps the full workspace (source + node_modules): api and worker
# run TypeScript directly via tsx (which resolves NodeNext ".js" specifiers to
# .ts sources), and workspace packages export TS source, so there is no pruned
# "dist" to copy. The image is larger than a bundled build; that is the
# accepted tradeoff for zero build tooling in the backends.
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system millionsend && useradd --system --gid millionsend millionsend
COPY --from=build --chown=millionsend:millionsend /app /app
USER millionsend
EXPOSE 3000 3001 3002
# ENTRYPOINT (not CMD) so `docker compose run millionsend setup` reaches
# start.mjs as argv instead of replacing the command.
ENTRYPOINT ["node", "scripts/start.mjs"]
