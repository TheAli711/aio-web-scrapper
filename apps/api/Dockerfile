# Build context: repository root.  docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/net-policy/package.json packages/net-policy/
COPY apps/api/package.json apps/api/
COPY apps/egress-proxy/package.json apps/egress-proxy/
COPY apps/web/package.json apps/web/
COPY apps/brand-service/package.json apps/brand-service/
RUN npm ci --workspace @ws/api --workspace @ws/net-policy --include-workspace-root=false --ignore-scripts
COPY packages/net-policy packages/net-policy
COPY apps/api apps/api
RUN npm run build -w @ws/net-policy && npm run build -w @ws/api \
 && npm prune --omit=dev --workspace @ws/api --workspace @ws/net-policy --include-workspace-root=false

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/package.json ./
COPY --from=build /repo/packages/net-policy/package.json packages/net-policy/
COPY --from=build /repo/packages/net-policy/dist packages/net-policy/dist
COPY --from=build /repo/apps/api/package.json apps/api/
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/api/migrations apps/api/migrations
COPY docs/agent-guide.md docs/agent-guide.md
RUN mkdir -p /data/objects && chown -R node:node /data
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
CMD ["node", "dist/index.js"]
