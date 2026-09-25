# Build context: repository root.  docker build -f apps/egress-proxy/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/net-policy/package.json packages/net-policy/
COPY apps/api/package.json apps/api/
COPY apps/egress-proxy/package.json apps/egress-proxy/
COPY apps/web/package.json apps/web/
COPY apps/brand-service/package.json apps/brand-service/
RUN npm ci --workspace @ws/egress-proxy --workspace @ws/net-policy --include-workspace-root=false --ignore-scripts
COPY packages/net-policy packages/net-policy
COPY apps/egress-proxy apps/egress-proxy
RUN npm run build -w @ws/net-policy && npm run build -w @ws/egress-proxy \
 && npm prune --omit=dev --workspace @ws/egress-proxy --workspace @ws/net-policy --include-workspace-root=false

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/packages/net-policy/package.json packages/net-policy/
COPY --from=build /repo/packages/net-policy/dist packages/net-policy/dist
COPY --from=build /repo/apps/egress-proxy/package.json apps/egress-proxy/
COPY --from=build /repo/apps/egress-proxy/dist apps/egress-proxy/dist
USER node
EXPOSE 3128
CMD ["node", "apps/egress-proxy/dist/index.js"]
