# syntax=docker/dockerfile:1
#
# Dashboard image. Build with the REPO ROOT as context:
#   docker build -f apps/web/Dockerfile -t ws-web .
# Run:
#   docker run -p 3000:3000 -e API_INTERNAL_URL=http://api:4000 ws-web
#
# API_INTERNAL_URL is read at request time by app/api/[...path]/route.ts, so the same image works
# against any API address.

ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1

# npm workspaces: `npm ci` validates the root lockfile against every workspace manifest, so copy
# all of them, then install only what @ws/web needs.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/egress-proxy/package.json apps/egress-proxy/package.json
COPY packages/net-policy/package.json packages/net-policy/package.json
RUN npm ci --workspace @ws/web --include-workspace-root=false --no-audit --no-fund

COPY tsconfig.base.json ./
COPY apps/web ./apps/web
RUN npm run build -w @ws/web

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    API_INTERNAL_URL=http://api:4000

# Standalone output mirrors the monorepo layout (outputFileTracingRoot = repo root).
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/login || exit 1
CMD ["node", "apps/web/server.js"]
