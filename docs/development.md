# Development setup

## Layout

```
apps/api            Fastify application API (+ migrations, tests)
apps/web            Next.js dashboard
apps/egress-proxy   SSRF-enforcing forward proxy used by Firecrawl
packages/net-policy Shared URL / IP policy
infra/              Firecrawl compose override, env defaults, fixture site
firecrawl/          Upstream Firecrawl (fetched, pinned, never edited; git-ignored)
docs/               Architecture, API docs, OpenAPI spec
```

npm workspaces; Node 22+. `npm install` at the repo root installs everything.

## Option A: everything in Docker

`./scripts/local.sh up` (see README). After code changes: `docker compose up -d --build --wait app-api app-web`.

## Option B: engine in Docker, app on the host (hot reload)

```bash
./scripts/fetch-firecrawl.sh
cp .env.example .env
docker compose up -d app-db api firecrawl-gateway    # Firecrawl + deps + egress-proxy + app DB
npm install
npm run build -w @ws/net-policy
npm run dev:api        # http://localhost:4000, uses .env (FIRECRAWL_API_URL=http://localhost:3002)
npm run dev:web        # http://localhost:3000, proxies /api/* to API_INTERNAL_URL (default :4000)
```

Migrations run automatically on API start (`MIGRATE_ON_START=false` to disable); run them
manually with `npm run db:migrate`.

`firecrawl-gateway` binds Firecrawl to `127.0.0.1:3002` only. Never publish it more widely:
self-hosted Firecrawl has no authentication.

## Tests

| Command | What | Needs |
|---|---|---|
| `npm test -w @ws/net-policy` | URL/IP policy unit tests | nothing |
| `npm test -w @ws/api` | Unit + API integration tests (auth, ownership, keys, scrape, crawl, job status, results, SSRF, limits, rate limiting, metrics, OpenAPI) with a deterministic `FakeEngine` and in-memory storage | Postgres at `TEST_DATABASE_URL` (default `postgres://webscraper:webscraper@localhost:5433/webscraper_test`) |
| `npm run test:e2e` | Real stack: example.com scrape, fixture-site crawl, failed URLs, SSRF redirect blocked at proxy, unauthorized project access | Full compose stack with profile `e2e`, internet access |

Create the test database once:

```bash
docker compose up -d app-db
docker compose exec app-db psql -U webscraper -c 'CREATE DATABASE webscraper_test'
```

### Fixture site and end-to-end tests

`infra/testsite` is a static site served by nginx as `http://testsite.test` (profile `e2e`):
7 good pages, a broken link (`/missing-page.html` → 404), a failing page (`/server-error` → 500)
and an unlinked SSRF probe (`/redirect-to-metadata` → 302 to `169.254.169.254`).

Private addresses are blocked, so the fixture must be trusted explicitly:

```bash
# Trust the fixture for this invocation only (never set TRUSTED_TEST_HOSTS in a shared deployment)
TRUSTED_TEST_HOSTS=testsite.test docker compose --profile e2e up -d --build --wait
npm run test:e2e
# restore the normal (no trusted hosts) configuration
docker compose up -d --wait egress-proxy app-api && docker compose --profile e2e stop testsite
```

## Useful commands

```bash
docker compose logs -f app-api                     # structured app logs
docker compose logs egress-proxy | grep egress_denied
curl -s localhost:4000/metrics | grep jobs_
curl -s localhost:4000/readyz                      # {"database":true,"engine":true}
npm run openapi -w @ws/api                         # regenerate docs/openapi.json
docker compose down                                # stop (keeps volumes)
docker compose down -v                             # stop and delete all data
```

## Troubleshooting

- **`app-api` waits forever:** Firecrawl's `api` must be healthy. `docker compose logs api`;
  a missing `nuq-postgres` shows up as `getaddrinfo EAI_AGAIN nuq-postgres`.
- **Every scrape fails with `CONNECTION_FAILED`:** check `egress-proxy` is healthy and that
  `EGRESS_PROXY_USERNAME/PASSWORD` match on both sides (`docker compose config | grep PROXY_`).
- **`FORBIDDEN: Cross-origin request rejected`:** `APP_ORIGIN` must equal the URL the dashboard
  is opened on.
- **Docker runs out of memory:** lower `NUM_WORKERS_PER_QUEUE` and the limits in
  `infra/firecrawl.override.yml`.
