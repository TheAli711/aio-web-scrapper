# Build context: repository root.  docker build -f apps/brand-service/Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/net-policy/package.json packages/net-policy/
COPY apps/api/package.json apps/api/
COPY apps/egress-proxy/package.json apps/egress-proxy/
COPY apps/web/package.json apps/web/
COPY apps/brand-service/package.json apps/brand-service/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --workspace @ws/brand-service --include-workspace-root=false --ignore-scripts
COPY apps/brand-service apps/brand-service
RUN npm run build -w @ws/brand-service \
 && npm prune --omit=dev --workspace @ws/brand-service --include-workspace-root=false

FROM node:22-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
# Full Chromium (new headless mode) plus its system libraries; no headless-shell build.
RUN node node_modules/playwright/cli.js install --with-deps --no-shell chromium \
 && rm -rf /var/lib/apt/lists/* \
 && apt-get update && apt-get install -y --no-install-recommends fonts-liberation fonts-noto-color-emoji wget \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /repo/apps/brand-service/package.json apps/brand-service/
COPY --from=build /repo/apps/brand-service/dist apps/brand-service/dist
USER node
EXPOSE 4100
CMD ["node", "apps/brand-service/dist/index.js"]
