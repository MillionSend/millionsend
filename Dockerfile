# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

FROM node:26-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS deps
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
# The webpack cache is build-only (hundreds of MB), and the runtime never
# needs dev tooling (drizzle-kit, vitest, biome, typescript): a fresh
# prod-only install from the same store leaves none of it behind. (`pnpm
# prune --prod` is not workspace-aware — it empties the packages' own
# node_modules — and a re-link over the existing tree keeps the orphans.)
RUN rm -rf apps/*/.next/cache node_modules apps/*/node_modules packages/*/node_modules \
  && CI=true pnpm install --prod --frozen-lockfile --offline

# The runtime keeps the full workspace (source + node_modules): api and worker
# run TypeScript directly via tsx (which resolves NodeNext ".js" specifiers to
# .ts sources), and workspace packages export TS source, so there is no pruned
# "dist" to copy. The image is larger than a bundled build; that is the
# accepted tradeoff for zero build tooling in the backends.
FROM node:26-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS runtime
WORKDIR /app
ARG GIT_SHA=unknown
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV MILLIONSEND_REVISION=$GIT_SHA
RUN groupadd --system millionsend && useradd --system --gid millionsend millionsend
# Root-owned tree: the process that runs this source cannot rewrite it. Only
# Next's runtime caches (image optimizer, fetch cache) and the docs' MDX
# index, which fumadocs regenerates on every start, need to be writable.
# Mode 1777 rather than ownership: a tmpfs mounted over these paths (the
# compose files do, for a read-only rootfs) inherits the mode, not the owner.
COPY --from=build /app /app
RUN install -d -m 1777 apps/web/.next/cache apps/docs/.next/cache \
  && chown -R millionsend:millionsend apps/docs/.source && chmod 1777 apps/docs/.source
USER millionsend
EXPOSE 3000 3001 3002
# ENTRYPOINT (not CMD) so `docker compose run millionsend setup` reaches
# start.mjs as argv instead of replacing the command.
ENTRYPOINT ["node", "scripts/start.mjs"]
