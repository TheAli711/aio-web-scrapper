# Render build of upstream Firecrawl's playwright-service at the SHA pinned in firecrawl.lock.
# Upstream publishes this image only as :latest, so we build it from the pinned source instead.
# Steps mirror firecrawl/apps/playwright-service-ts/Dockerfile; upstream code is not modified.
# Build context: repository root.  docker build -f infra/render/playwright-service.Dockerfile .
FROM alpine/git:2.47.2 AS src
ARG FIRECRAWL_REPO=https://github.com/firecrawl/firecrawl.git
ARG FIRECRAWL_SHA=ef12eb36b2f3382838dfe0a0c1a5add3d5df7fe5
RUN git init -q /src && cd /src \
 && git remote add origin "$FIRECRAWL_REPO" \
 && git fetch -q --depth 1 origin "$FIRECRAWL_SHA" \
 && git checkout -q FETCH_HEAD

FROM node:18-slim
WORKDIR /usr/src/app
COPY --from=src /src/apps/playwright-service-ts/package*.json ./
RUN npm install
COPY --from=src /src/apps/playwright-service-ts/ ./
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright
RUN npx playwright install chromium --with-deps
RUN npm run build
ENV PORT=3000
EXPOSE 3000
CMD [ "npm", "start" ]
