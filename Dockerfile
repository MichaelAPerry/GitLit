# One Dockerfile, four images. `--target` picks the service; the install and
# build stages are shared, so a four-service deploy resolves the lockfile once
# instead of four times and the images cannot drift apart.
#
#   docker build --target api  -t gitlit-api  .
#   docker build --target gitd -t gitlit-gitd .
#   docker build --target web  -t gitlit-web  .
#   docker build --target mcp  -t gitlit-mcp  .

# --------------------------------------------------------------- base
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# --------------------------------------------------------------- deps
# Manifests only, so editing source does not invalidate the install layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/core/package.json        packages/core/
COPY packages/prose/package.json       packages/prose/
COPY packages/diff/package.json        packages/diff/
COPY packages/embed/package.json       packages/embed/
COPY packages/provenance/package.json  packages/provenance/
COPY packages/auth/package.json        packages/auth/
COPY packages/db/package.json          packages/db/
COPY packages/mail/package.json        packages/mail/
COPY packages/observability/package.json packages/observability/
COPY apps/api/package.json             apps/api/
COPY apps/gitd/package.json            apps/gitd/
COPY apps/web/package.json             apps/web/
COPY apps/mcp/package.json             apps/mcp/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --------------------------------------------------------------- build
FROM deps AS build
COPY . .
RUN pnpm turbo run build --filter=!@gitlit/web

# Prune each service to just what it needs at runtime. `pnpm deploy` follows
# the workspace graph, so a service that does not depend on a package does not
# carry it — and no service carries the dev toolchain.
RUN pnpm deploy --filter=@gitlit/api  --prod --legacy /out/api  && \
    pnpm deploy --filter=@gitlit/gitd --prod --legacy /out/gitd && \
    pnpm deploy --filter=@gitlit/mcp  --prod --legacy /out/mcp  && \
    pnpm deploy --filter=@gitlit/db   --prod --legacy /out/db

# --------------------------------------------------------------- runtime base
FROM node:22-slim AS runtime
ENV NODE_ENV=production
# Fail fast and loudly rather than leaving a wedged process behind a health
# check that never goes green.
ENV NODE_OPTIONS=--unhandled-rejections=strict
WORKDIR /app
USER node

# --------------------------------------------------------------- api
FROM runtime AS api
# The API runs migrations in the release step, so it carries @gitlit/db's
# migration runner alongside its own tree.
COPY --from=build --chown=node:node /out/api /app
COPY --from=build --chown=node:node /out/db  /migrate
EXPOSE 4000
ENV API_PORT=4000
CMD ["node", "dist/index.js"]

# --------------------------------------------------------------- gitd
FROM runtime AS gitd
USER root
# gitd shells out to real git: upload-pack and receive-pack for smart HTTP,
# and `git bundle` for backups. There is no pure-JS substitute for either, and
# a missing binary here fails at clone time, not at boot.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /out/gitd /app
# Both live on the persistent volume. Created here so the mount inherits an
# owner the unprivileged user can write to.
RUN mkdir -p /data/repos /data/backups && chown -R node:node /data
USER node
ENV REPO_ROOT=/data/repos
ENV BACKUP_DIR=/data/backups
ENV GITD_PORT=4001
EXPOSE 4001
VOLUME ["/data"]
CMD ["node", "dist/index.js"]

# --------------------------------------------------------------- mcp
FROM runtime AS mcp
COPY --from=build --chown=node:node /out/mcp /app
EXPOSE 4002
CMD ["node", "dist/http.js"]

# --------------------------------------------------------------- web
# Next.js is built in its own stage: it needs the dev toolchain to compile and
# emits a standalone bundle that already contains the modules it uses.
FROM build AS web-build
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm --filter @gitlit/web build

FROM runtime AS web
COPY --from=web-build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]
