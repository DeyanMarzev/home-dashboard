# syntax=docker/dockerfile:1
# One Dockerfile, two targets: `api` (also serves the built web app) and `collector`.
# Built on the Pi (linux/arm64) by `docker compose up -d --build`.

ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@10.18.0
WORKDIR /repo
# Manifests first so the dependency layer is cached between code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/collector/package.json apps/collector/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @home/api deploy --prod /out/api && \
    pnpm --filter @home/collector deploy --prod /out/collector

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production TZ=Europe/London
WORKDIR /app
USER node
# Both services migrate the database and sync the source registry at startup.
# config/ is also bind-mounted by docker-compose.yml, so registry edits need only a restart.
COPY --chown=node:node db/migrations ./db/migrations
COPY --chown=node:node config ./config

FROM runtime AS api
COPY --from=build --chown=node:node /out/api ./
COPY --from=build --chown=node:node /repo/apps/web/dist ./public
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]

FROM runtime AS collector
COPY --from=build --chown=node:node /out/collector ./
CMD ["node", "dist/index.js"]

# netprobe: network measurements from the host network (docs/01). Runs as root because Wi-Fi
# scans and ARP need the NET_ADMIN / NET_RAW capabilities docker-compose.yml grants it.
# curl runs the speed test's transfers (constant memory, unlike buffering them in Node).
FROM ${NODE_IMAGE} AS netprobe
RUN apt-get update \
 && apt-get install -y --no-install-recommends iw iputils-ping arp-scan iproute2 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production TZ=Europe/London
WORKDIR /app
COPY --from=build /out/collector ./
CMD ["node", "dist/netprobe/main.js"]
