# web-scrapper

A web-data platform (dashboard + authenticated API) built on top of a pinned, unmodified
[Firecrawl](https://github.com/firecrawl/firecrawl) engine.

- Sign up, create projects, scrape a URL or crawl a site, watch jobs run, inspect and download
  results as Markdown / HTML / plain text / JSON.
- Do the same over a public REST API with per-user API keys (`Authorization: Bearer wsk_...`).
- Firecrawl is the scraping/crawling engine behind a `ScrapingEngine` adapter. It runs on an
  isolated network, and all of its outbound traffic goes through an SSRF-enforcing egress proxy.

Phase 2 status, design decisions and known gaps: [PHASE_2.md](PHASE_2.md).
Original Phase 0/1 plan: [docs/phase-0-1-plan.md](docs/phase-0-1-plan.md).

## Architecture in one picture

```
Browser ──► app-web (Next.js :3000) ──/api/*──► app-api (Fastify :4000) ──► app-db (Postgres)
                                                   │    │
API client ── Authorization: Bearer wsk_... ───────┘    ├──► object storage (./data or volume)
                                                        │
                                  FirecrawlEngine adapter (HTTP, v2 API)
                                                        │   backend network (internal: no internet)
                                                        ▼
                         Firecrawl api + workers ── playwright-service ── redis / rabbitmq / nuq-postgres
                                                        │
                                                        ▼
                                  egress-proxy (SSRF policy at connect time) ──► internet
```

Details: [docs/architecture.md](docs/architecture.md).

## Run it locally (one command)

Requirements: Docker Desktop with Compose v2.24+ and ~8 GB RAM for Docker, plus `git`, `curl`,
`jq`, `openssl` (`brew install jq` if missing). Node is not needed to run it.

```bash
./scripts/local.sh up
```

This fetches the pinned Firecrawl, creates `.env` with a random proxy password, builds and starts
every container, waits until the API and engine are ready, creates a local user and API key, and
prints:

```
Dashboard      http://localhost:3000
API            http://localhost:4000/api/v1
API reference  http://localhost:4000/api/v1/docs      (interactive Swagger UI)
OpenAPI spec   http://localhost:4000/api/v1/openapi.json
Agent guide    http://localhost:4000/api/v1/llms.txt  (Markdown guide written for LLM agents)
API key        wsk_...
```

Credentials (dashboard login + API key) are saved in `.local/credentials.env` (git-ignored).
The first run builds Firecrawl from source (10–15 min); later runs take seconds. Re-running
`up` is safe and reuses the existing user and key.

```bash
./scripts/local.sh scrape https://example.com            # prints the page as Markdown
./scripts/local.sh scrape https://example.com text       # or html / text
./scripts/local.sh crawl https://quotes.toscrape.com 10  # crawl 10 pages -> output/crawl-<id>.jsonl
./scripts/local.sh status | logs [service] | creds | new-key | down
```

### Using it from your agent / code

Give your agent the API key and the guide URL, e.g. *"Use the web scraper API described at
http://localhost:4000/api/v1/llms.txt with API key $WS_API_KEY to read pages."* The guide
covers auth, both recipes, every field, error codes and retry advice. For tool/SDK generation use
the OpenAPI spec.

Single call, content inline:

```bash
set -a; source .local/credentials.env; set +a
curl -s -X POST "http://localhost:4000/api/v1/scrape?wait=true" \
  -H "Authorization: Bearer $WS_API_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","formats":["markdown"]}' | jq -r .result.content.markdown
```

## Manual start (what the script does)

```bash
# 1. Fetch the pinned Firecrawl release (tag + commit from firecrawl.lock) into ./firecrawl
./scripts/fetch-firecrawl.sh

# 2. Configuration
cp .env.example .env        # then change EGRESS_PROXY_PASSWORD at least

# 3. Build and start (first build compiles Firecrawl from source: ~10 minutes)
docker compose up -d --build

# 4. Open the dashboard
open http://localhost:3000
```

The API is also on `http://localhost:4000` (loopback only), the interactive API reference on
`http://localhost:3000/api/v1/docs`, and Prometheus metrics on `http://localhost:4000/metrics`.

`docker compose ps` should show `api`, `app-api`, `app-web`, `app-db`, `egress-proxy`
healthy, plus `playwright-service`, `redis`, `rabbitmq`, `nuq-postgres`, `firecrawl-gateway`.

## Create a user

Either sign up on `http://localhost:3000/signup` (enabled while `ALLOW_SIGNUP=true`), or from
the command line (uses `DATABASE_URL` from `.env`, which points at the published Postgres port):

```bash
npm install
npm run build -w @ws/net-policy
npm run user:create -- --email you@example.com --password 'a-long-password'
```

Omit `--password` to have one generated and printed once. Every new user gets a
"Default project".

## Run a scrape

Dashboard: **Projects → (project) → New job → Scrape**, enter `https://example.com`, pick output
formats, **Start scrape**. You are taken to the job page, which updates live; click the result to
see the Markdown / HTML / Text / Links / Metadata tabs, copy or download.

API (create a key under **API keys** first; it is shown once):

```bash
KEY=wsk_...                      # your API key
PROJECT=$(curl -s localhost:3000/api/v1/projects -H "Authorization: Bearer $KEY" | jq -r '.data[0].id')

JOB=$(curl -s -X POST localhost:3000/api/v1/scrape \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"url\":\"https://example.com\",\"project_id\":\"$PROJECT\",\"formats\":[\"markdown\",\"text\"]}" | jq -r .id)

curl -s localhost:3000/api/v1/jobs/$JOB -H "Authorization: Bearer $KEY" | jq '{status, progress, error}'
curl -s "localhost:3000/api/v1/jobs/$JOB/results?include_content=true" -H "Authorization: Bearer $KEY" | jq '.data[0].content.markdown'
```

## Run a crawl

Dashboard: **New job → Crawl**, set start URL, max depth / max pages, optional include/exclude
regexes (matched against the URL path), allowed domain. The job page shows discovered /
processed / succeeded / failed counts and lists failed pages with their error codes.

API:

```bash
JOB=$(curl -s -X POST localhost:3000/api/v1/crawl \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"url\":\"https://quotes.toscrape.com/\",\"project_id\":\"$PROJECT\",\"max_depth\":2,\"max_pages\":10}" | jq -r .id)

curl -s localhost:3000/api/v1/jobs/$JOB -H "Authorization: Bearer $KEY" | jq '{status, progress}'
curl -s "localhost:3000/api/v1/jobs/$JOB/results?success=false" -H "Authorization: Bearer $KEY" | jq '.data[] | {url, status_code, error}'
curl -s localhost:3000/api/v1/jobs/$JOB/export -H "Authorization: Bearer $KEY" > crawl.jsonl
```

For a deterministic local test site, start the fixture: see
[docs/development.md](docs/development.md#fixture-site-and-end-to-end-tests).

## How Firecrawl is integrated

- **Pinned, unmodified.** `firecrawl.lock` records tag `v2.11.0` and its commit; the fetch script
  refuses a mismatch. No file under `firecrawl/` is edited.
- **Composed, not forked.** `docker-compose.yml` `include`s upstream's compose file together with
  `infra/firecrawl.override.yml`, which only changes configuration (internal network, egress
  proxy, loopback-only access, memory limits, FoundationDB behind a profile). Every override is
  explained in [docs/architecture.md](docs/architecture.md#firecrawl-configuration-overrides).
- **Behind an adapter.** `apps/api/src/engine/firecrawl.ts` implements our `ScrapingEngine`
  interface using Firecrawl's public v2 HTTP API. Nothing else in our code knows Firecrawl exists.
- **Firecrawl's queue does the work.** We keep a persistent job record per request, hand the work
  to Firecrawl immediately, and reconcile crawl progress/results back into Postgres.
- **Never public.** Self-hosted Firecrawl has no authentication; it is reachable only on the
  internal Docker network and via a `127.0.0.1` gateway for local development.

## Environment variables

All variables are documented in [.env.example](.env.example). The important ones:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://webscraper:webscraper@localhost:5433/webscraper` | App database (compose overrides it for the container) |
| `APP_ORIGIN` | `http://localhost:3000` | Public dashboard origin; cookie-authenticated writes from other origins are rejected |
| `COOKIE_SECURE` | `false` | Set `true` behind HTTPS |
| `ALLOW_SIGNUP` | `true` | Self-service sign-up |
| `FIRECRAWL_API_URL` | `http://localhost:3002` | Engine URL (compose uses `http://api:3002`) |
| `EGRESS_PROXY_USERNAME` / `EGRESS_PROXY_PASSWORD` | `firecrawl` / `change-me-egress` | Credentials between Firecrawl and the egress proxy |
| `TRUSTED_TEST_HOSTS` | empty | Hostnames exempt from private-address blocking. **Keep empty outside tests.** |
| `MAX_CRAWL_PAGES`, `MAX_CRAWL_DEPTH`, `MAX_SCRAPE_TIMEOUT_MS`, `MAX_RESULT_BYTES`, `MAX_ACTIVE_JOBS_PER_USER` | 500, 10, 90000, 5 MiB, 10 | Hard limits |
| `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_JOB_CREATE_PER_MINUTE`, `RATE_LIMIT_AUTH_PER_MINUTE` | 300, 30, 10 | Rate limits |
| `METRICS_TOKEN` | empty | Bearer token for `/metrics` (required in production) |

## Tests

```bash
npm install
npm run build -w @ws/net-policy
docker compose up -d app-db
docker compose exec app-db psql -U webscraper -c 'CREATE DATABASE webscraper_test'   # once
npm test                       # unit + API integration tests (fake engine, real Postgres)

# End-to-end against the real stack (real Firecrawl, egress proxy, fixture site).
# Trusts the fixture host only for this compose invocation.
TRUSTED_TEST_HOSTS=testsite.test docker compose --profile e2e up -d --build --wait
npm run test:e2e
docker compose up -d --wait egress-proxy app-api && docker compose --profile e2e stop testsite   # back to normal
```

## Documentation

- [docs/architecture.md](docs/architecture.md): components, request flow, SSRF design, Firecrawl overrides
- [docs/development.md](docs/development.md): host-side development, tests, fixture site, troubleshooting
- [docs/api.md](docs/api.md): public API guide, schemas, error codes; machine-readable spec in [docs/openapi.json](docs/openapi.json)
- [docs/agent-guide.md](docs/agent-guide.md): compact guide for LLM agents (served live at `/api/v1/llms.txt`)
- [PHASE_2.md](PHASE_2.md): what was built, reused, modified; limitations; Phase 3 recommendations

## Licensing note

Firecrawl is licensed under **AGPL-3.0**. This repository does not include Firecrawl's code:
`scripts/fetch-firecrawl.sh` downloads the unmodified upstream release pinned in
`firecrawl.lock`. If you offer this stack as a network service, AGPL obligations apply to the
Firecrawl component. Since it runs unmodified, linking users to the upstream source at the
pinned tag is the usual way to meet them. This is not legal advice; review before commercial launch.
This repository itself has no license file yet (all rights reserved by default).
