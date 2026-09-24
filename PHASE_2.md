# Phase 2: Product layer on Firecrawl

Status: **complete**. The acceptance workflow runs end to end on a clean local install (see
[Acceptance](#acceptance-test)).

## Starting point

The Phase 2 brief assumed Firecrawl was already pinned and running. It was not: the repo held
only the Phase 0/1 plan (now at `docs/phase-0-1-plan.md`). Phase 2 therefore also:

- pinned Firecrawl to its latest official release, **v2.11.0** (commit `ef12eb36`, 2026-06-18),
  recorded in `firecrawl.lock` and fetched by `scripts/fetch-firecrawl.sh`,
- built its images from source, because GHCR publishes no image tag for v2.11.0,
- ran an integration recon of the v2 API, error model, self-host auth, SSRF controls, proxy
  support, crawl pagination and limits. The findings are in the adapter header and in
  `docs/architecture.md`.

The Phase 1 benchmark corpus (20–30 URL types) was **not** produced. See Phase 3 recommendations.

## Architecture implemented

```
User ─► Dashboard (Next.js) ─► Application API (Fastify) ─► ScrapingEngine ─► FirecrawlEngine adapter
                                    │                                              │ HTTP v2 (internal network)
                                    ├─► Postgres (users, projects, keys, jobs,     ▼
                                    │    results metadata, job events)         Firecrawl api/workers (NuQ)
                                    └─► ObjectStorage (page bodies)                │
                                                                     Playwright service / fetch engine
                                                                                   │
                                                                     egress-proxy (SSRF enforcement) ─► internet
```

Full description: [docs/architecture.md](docs/architecture.md).

## Files / components added

| Path | What |
|---|---|
| `package.json`, `tsconfig.base.json` | npm workspaces root |
| `firecrawl.lock`, `scripts/fetch-firecrawl.sh` | Upstream pin + verified fetch |
| `docker-compose.yml` | Full stack; `include`s upstream compose + override |
| `infra/firecrawl.override.yml`, `infra/firecrawl.env` | All Firecrawl configuration changes |
| `infra/testsite/` | Deterministic crawl fixture (nginx) |
| `packages/net-policy/` | URL / hostname / IP policy shared by API and proxy (+52 tests) |
| `apps/egress-proxy/` | Forward proxy (HTTP + CONNECT) enforcing egress policy |
| `apps/api/migrations/001_init.sql` | Schema |
| `apps/api/src/config.ts` | Env config + limits |
| `apps/api/src/engine/types.ts` | `ScrapingEngine` interface |
| `apps/api/src/engine/firecrawl.ts` | Firecrawl v2 adapter + error mapping |
| `apps/api/src/services/jobs.ts` | Job creation, validation, dispatch, cancel |
| `apps/api/src/services/reconciler.ts` | Crawl progress sync, orphan recovery |
| `apps/api/src/services/results.ts` | Result persistence, text derivation, size limits |
| `apps/api/src/storage/object-storage.ts` | `ObjectStorage` + local FS + memory impls |
| `apps/api/src/observability/metrics.ts` | `Metrics` interface + Prometheus-text impl |
| `apps/api/src/http/*` | Auth plugin, schemas (TypeBox → validation + OpenAPI), presenters |
| `apps/api/src/routes/*` | auth, projects, keys, jobs/results (shared by `/api` and `/api/v1`) |
| `apps/api/src/scripts/*` | migrate, create-user, openapi |
| `apps/api/test/**` | 81 unit/integration tests + 8 e2e tests |
| `scripts/local.sh` | One-command local run (`up`), plus `scrape`, `crawl`, `status`, `logs`, `creds`, `new-key`, `down` |
| `docs/agent-guide.md` | Guide for LLM agents, served at `/api/v1/llms.txt` |
| `apps/web/` | Dashboard (login, signup, dashboard, projects, project, jobs, job, results, result, api-keys, settings) + streaming `/api` proxy |
| `docs/` | architecture, development, api, openapi.json, phase 0–1 plan |

## Firecrawl components reused

- The whole engine, unchanged: v2 HTTP API, NuQ queue (Postgres + RabbitMQ), workers, Redis,
  Playwright microservice, fetch engine, HTML→Markdown, link extraction, crawler (depth, include
  and exclude paths, sitemap, robots.txt, subdomains), crawl status pagination and error reporting.
- Upstream's built-in proxy support (`PROXY_SERVER/USERNAME/PASSWORD`) is used to route all engine
  traffic through our egress proxy.
- Upstream's `/v0/health/liveness` backs the compose healthcheck.

## Firecrawl components modified

**No upstream source files were modified.** `git -C firecrawl status` is clean, and the fetch
script warns if it is not. Behaviour changes are configuration only, all in
`infra/firecrawl.override.yml`:

1. `backend` network made `internal` (no direct internet).
2. `PROXY_*` pointed at `egress-proxy` for `api` and `playwright-service`.
3. `ALLOW_LOCAL_WEBHOOKS=true` on `api` and `playwright-service`. Their own private-IP checks
   cannot work behind a proxy on an internal network: the fetch check sees the proxy's IP, and
   Playwright's check cannot resolve DNS. Enforcement moved to the egress proxy, which checks the
   real destination without a rebinding window. See the residual risk in known limitations.
4. Firecrawl API port no longer published; `firecrawl-gateway` exposes it on `127.0.0.1` only.
5. FoundationDB services behind the `fdb` profile; `nuq-postgres` made an explicit dependency.
6. Lower memory/CPU limits and `NUM_WORKERS_PER_QUEUE=4`; `BLOCK_MEDIA=TRUE`; healthcheck on `api`.

Adapter-side compensations (no upstream change): always `proxy: "basic"`, derived `text`
format, 4xx/5xx pages treated as failed pages, `waitFor` clamped, error codes normalised.

## Database schema

`apps/api/migrations/001_init.sql`:

- `users` (unique `lower(email)`, scrypt hash)
- `sessions` (sha256 token id, expiry)
- `projects` (`user_id` FK; `UNIQUE(id, user_id)` for composite FKs)
- `api_keys` (unique `prefix`, sha256 `key_hash`, `last_used_at`, `revoked_at`)
- `jobs` (`(project_id, user_id)` → projects composite FK; type/status CHECKs; options JSONB;
  engine and engine_job_id; page counters; error_code/message; started/completed; reconciler
  cursor and lease; indexes on `(user_id, created_at)`, `(project_id, created_at)`, and a
  partial index on active status)
- `results` (job FK cascade, composite project FK, `UNIQUE(job_id, url)`, bounded metadata
  JSONB, `storage_key` → object storage, sizes, `truncated`)
- `job_events` (append-only timeline)

## API routes

Dashboard / internal (session cookie; job routes also accept API keys):

```
POST   /api/auth/signup | /api/auth/login | /api/auth/logout      GET /api/auth/me
GET    /api/projects            POST /api/projects
GET    /api/projects/:id        PATCH /api/projects/:id     DELETE /api/projects/:id
GET    /api/keys                POST /api/keys              DELETE /api/keys/:id
POST   /api/scrape              POST /api/crawl
GET    /api/jobs                GET /api/jobs/:id           GET /api/jobs/:id/events
POST   /api/jobs/:id/cancel     GET /api/jobs/:id/results   GET /api/jobs/:id/export
GET    /api/results             GET /api/results/:id        GET /api/results/:id/download
GET    /api/stats
```

Public (API key only), documented in `docs/api.md` and `docs/openapi.json`:

```
GET  /api/v1/projects
POST /api/v1/scrape[?wait=true]     POST /api/v1/crawl
GET  /api/v1/jobs                   GET  /api/v1/jobs/:id            POST /api/v1/jobs/:id/cancel
GET  /api/v1/jobs/:id/results       GET  /api/v1/jobs/:id/export
GET  /api/v1/results/:id            GET  /api/v1/results/:id/download
```

Documentation (no auth): `GET /api/v1/openapi.json`, `GET /api/v1/docs` (Swagger UI),
`GET /api/v1/llms.txt` and `GET /api/v1/guide.md` (agent guide, base URL filled in per request).

System: `GET /healthz`, `GET /readyz` (DB + engine), `GET /metrics`.

## Added after the Phase 2 sign-off (local use)

- `scripts/local.sh`: a single `up` command. It fetches the pinned Firecrawl, generates `.env`,
  builds and starts the stack, waits for readiness, and creates a local user + API key in
  `.local/credentials.env`. It also has `scrape` / `crawl` helpers.
- `POST /scrape?wait=true`: returns the finished job and page content in one response (falls
  back to 202 when the page outlives `timeout_ms + 30s`).
- `project_id` is optional on scrape/crawl (defaults to the user's oldest project, created if missing).
- Agent guide (`docs/agent-guide.md`) served at `/api/v1/llms.txt`.

## Security controls implemented

- Input validation on every route (TypeBox/AJV, `additionalProperties: false`), plus
  domain-level limits (timeout, depth, pages, patterns compile, allowed domain).
- URL pre-check and network-level egress enforcement (see architecture). Tested against the
  loopback, RFC 1918, metadata, decimal/hex/octal IP, IPv6-mapped, single-label docker name,
  DNS-rebinding and mixed-resolution cases, and a live redirect to `169.254.169.254`.
- Authentication (scrypt passwords, hashed sessions, hashed API keys shown once, revocation).
- Authorization: owner scoping in every query, composite FKs in the DB, 404 for foreign ids,
  API keys cannot manage keys, `/api/v1` requires API keys, CSRF origin check for cookies.
- Rate limiting per key / user / IP, with stricter limits on job creation and login. Per-user
  active job cap.
- Request body limit (256 KB), request timeout, per-page result size cap, bounded metadata.
- Safe errors: fixed vocabulary of codes; upstream messages and stack traces never returned;
  `requestId` for correlation; downloads served with `Content-Security-Policy: sandbox` and
  `nosniff`; the HTML preview is `<iframe sandbox="">`.
- Firecrawl is not reachable from outside the Docker network (loopback gateway for dev only).

## Test results (at completion)

| Suite | Result |
|---|---|
| `packages/net-policy` unit | 52 passed |
| `apps/api` unit + integration (real Postgres, fake engine) | 81 passed (6 files) |
| `apps/api` e2e against real stack (Firecrawl + proxy + fixture) | 8 passed |

(An earlier revision reported "86 unit/integration". That figure wrongly included the 8 e2e
tests, because the CLI `--exclude` flag was ignored. `vitest.config.ts` now separates the suites,
and `npm run test:e2e` sets `E2E=1`.)
| Typecheck (all workspaces), `next build` | clean |

The e2e suite covers: single URL scrape (example.com), small site crawl (7 ok + 404 + 500),
exclude patterns, failed URL (HTTP 404 job, DNS failure), SSRF at API and at proxy (redirect to
metadata), and unauthorized project/job access.

## Acceptance test

Run manually in the browser against `docker compose up` on this machine:

1. Stack started (11 containers healthy/up).
2. Dashboard opened at `http://localhost:3000`.
3. User created. Done through `POST /api/auth/signup` rather than the form: the agent that ran
   the check doesn't type passwords into browsers. The signup form posts to the same endpoint
   and is covered by tests.
4. Project "Acceptance test" created in the UI.
5. `https://example.com` scraped (markdown, html, text).
6. Job page showed status live (API returned `queued`; completed in ~0.8 s).
7. Completed result shown.
8. Markdown, HTML (source + sandboxed preview) and Text tabs viewed.
9. Download returns `attachment; filename="example.com.json"`, and the same for `.md/.html/.txt`.
10. API key created in the UI; secret displayed once with a curl example.
11. `POST /api/v1/scrape` with the key → `202 queued` → `completed`; no key → `401`.
12. Crawl of `http://testsite.test/` started from the UI.
13. Live progress: discovered 9 / processed 9, progress bar, events timeline.
14. 7 successful and 2 failed pages (404, 500 with `HTTP_ERROR`); Failed filter works.
15. Crawl retrieved via `GET /api/v1/jobs/:id`, `/results?success=false`, `/export` (9 JSONL lines).

## Known limitations

- **Chromium loopback bypass (residual SSRF surface).** With Playwright's own check disabled
  (see Firecrawl modification 3), Chromium's built-in proxy bypass for `localhost`/`127.0.0.1`
  means a scraped page can reach the playwright-service's own port on loopback. That service can
  only fetch through the egress proxy, so policy still applies, but it is a hole to close. Phase 3
  options: a Chromium `--proxy-bypass-list=<-loopback>` flag (needs an upstream config hook or
  our own browser service), or putting the Playwright service in its own network namespace with
  iptables egress rules.
- **Client IP for rate limiting.** The dashboard proxy forwards `X-Forwarded-For`. Without a
  trusted ingress that overwrites it, a client can spoof its IP for IP-keyed limits
  (login/sign-up). Authenticated limits are keyed by user or API key and are not affected.
- Rate-limit counters and metrics are in-process: per instance, reset on restart.
- Only local-filesystem object storage is implemented (the S3/R2 interface is defined).
- Scrape dispatch runs in the API process. A restart mid-scrape marks the job `INTERRUPTED`
  (no automatic retry).
- The crawl sync cursor relies on Firecrawl's completion ordering. A full re-scan at completion
  makes the final result set correct, but live counts can briefly lag.
- Firecrawl keeps crawl data for 24 h. Our copy is permanent, but a crawl running longer than
  24 h would lose engine state (capped by `MAX_CRAWL_DURATION_MS`, default 1 h).
- No email verification, password reset, account deletion UI or teams.
- No retention policy for results / blobs. Blob deletion on project delete is best-effort, not
  transactional.
- Dashboard list pages show the latest 100 jobs/results (API supports a `before` cursor; UI has
  no "load more").
- The e2e suite needs internet access (example.com).
- Firecrawl images are built from source locally (~10 min first build).

## Technical debt

- Route-level rate limits are counted separately for `/api/...` and `/api/v1/...`.
- `GET /api/projects/:id` lacks `job_count` / `last_job_at`; job JSON lacks the project name.
- `/api/stats` "running" excludes queued jobs (the UI shows "+N queued").
- The minimal SQL migrator is forward-only (no down migrations).
- `ENGINE_UNAVAILABLE` for crawls is decided by `updated_at` staleness, not a real circuit breaker.
- Metrics use high-cardinality-safe labels, but there is no histogram per engine or per domain.

## Recommendations for Phase 3

1. **Run the Phase 1 benchmark through our API**: the 20–30 URL corpus (SPA, pagination,
   infinite scroll, PDFs, 403/429 sites). We now have per-page status, error codes, timings and
   job events to compare engines.
2. **Reliability layer as a `ScrapingEngine` decorator**: retries with classification
   (`TIMEOUT`, `CONNECTION_FAILED`, `HTTP 429/5xx`), per-domain concurrency and backoff, and a
   circuit breaker. No route or schema change needed.
3. **Grow egress-proxy into the network layer**: it already sees every outbound connection.
   Add upstream proxy routing, per-destination telemetry, and fix the Chromium loopback bypass
   (own browser service or netns egress rules).
4. **Move scrape dispatch to the engine's async path** (Firecrawl batch scrape) or a durable
   dispatcher, so restarts don't interrupt in-flight scrapes.
5. **Production hardening**: S3/R2 `ObjectStorage`, Redis-backed rate limits, OTel `Metrics`,
   trusted ingress for client IPs, retention jobs, and versioned GHCR images of our own builds.
6. **Productize**: structured JSON extraction (Phase 0 use case #4), webhooks for job
   completion, teams.
