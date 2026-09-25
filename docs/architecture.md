# Architecture (Phase 2)

## Components

| Component | Path | Tech | Role |
|---|---|---|---|
| Dashboard | `apps/web` | Next.js 16, Tailwind 4 | UI. Talks only to its own origin; `app/api/[...path]/route.ts` streams `/api/*` to app-api. |
| Application API | `apps/api` | Fastify 5, TypeBox, `pg` | Auth, projects, API keys, jobs, results, public API, OpenAPI, metrics. |
| Engine adapter | `apps/api/src/engine` | TypeScript | `ScrapingEngine` interface + `FirecrawlEngine` (HTTP client for Firecrawl v2). |
| Egress proxy | `apps/egress-proxy` | Node `http`/`net` | The only route from the engine to the internet; enforces SSRF policy. |
| Brand service | `apps/brand-service` | Node, Playwright (Chromium) | Branding extraction for the `branding` format: logo, favicon, brand colors, fonts. Internal only; all traffic via egress-proxy. |
| Net policy | `packages/net-policy` | `ipaddr.js` | Shared URL/IP/hostname rules used by app-api (pre-check) and egress-proxy (enforcement). |
| App database | `app-db` | Postgres 16 | Users, sessions, projects, api_keys, jobs, results, job_events. |
| Object storage | `apps/api/src/storage` | local FS (volume) | Page bodies (markdown/html/text/links) as JSON blobs. |
| Scraping engine | `firecrawl/` (upstream v2.11.0) | Firecrawl | API + NuQ workers, Playwright service, Redis, RabbitMQ, NuQ Postgres. |

## Request flow

### Scrape

1. `POST /api/v1/scrape` (API key) or `POST /api/scrape` (dashboard session). With
   `?wait=true` the handler holds the request open (polling the job row) and returns the finished
   job plus content in one response. Without it, the response is `202` and the client polls.
2. Auth resolves the principal (`http/auth.ts`); rate limit is applied per key or user.
3. `JobService.create` checks project ownership, validates options against hard limits,
   runs the URL pre-check (`@ws/net-policy`: scheme, credentials, port, hostname rules, DNS
   resolution with every address required to be public), enforces the per-user active job cap,
   and inserts a `jobs` row (`queued`) and a `job.created` event.
4. The API responds `202` with the job. In the same process, `dispatch()` atomically claims the
   job (`queued → running`) and calls `engine.scrape()`.
5. `FirecrawlEngine.scrape` calls Firecrawl `POST /v2/scrape`; Firecrawl queues it on NuQ, a
   worker fetches through Playwright or plain fetch, all via `egress-proxy`.
6. The `PageResult` is normalised (status codes, error codes, metadata trimmed), the body is
   written to object storage, and a `results` row with metadata is inserted.
7. Job becomes `completed`, or `failed` with a structured error code. Metrics and a structured
   log line record the outcome.

### Branding (`formats` includes `branding`, scrape only)

`JobService.runScrape` calls `BrandingService.extract` (`engine/branding.ts`, HTTP to
`brand-service:4100/v1/brand`) in parallel with `engine.scrape()`. Firecrawl cannot run custom
page scripts self-hosted (its branding format needs the hosted fire-engine), so brand-service
runs its own Chromium on the internal `backend` network. Its proxy is egress-proxy and its
Chromium is started with `--proxy-bypass-list=<-loopback>`, so even loopback requests go through
the SSRF policy.

Pipeline (`apps/brand-service/src`, heuristics only, no LLM):

1. Load the page with a Chrome UA matching the bundled Chromium; close / hide newsletter and
   cookie modals.
2. Logo pass (before scrolling, sticky headers change layout afterwards): score `<img>`, inline
   `<svg>`, CSS-background and text-wordmark candidates by logo-ish attributes and file names,
   header position, link to the home page, site-name match, size; penalise press / payment /
   social / tiny icons. Screenshot the winner (`logo.image`) and read its ink colors against the
   backdrop (taken from the capture's edge pixels).
3. Scroll the page like a visitor (instant scrolling, then force-finish common reveal libraries),
   then sample a point grid with `elementsFromPoint` and verify each sample against a full-page
   screenshot pixel, which gives the true visible surface colors.
4. Collect computed styles: button / CTA backgrounds (gradients included), links, headings,
   header bands, named brand CSS variables (builder defaults ignored), paragraph text; skip fixed
   widgets and third-party embeds.
5. `color.ts` pools the signals with per-source weights, clusters them in Lab space and scores
   each cluster by role (saturated > carrier-backed tints > dark brand neutrals). `secondary`
   must be a different hue family. Confidence reflects how many independent signals agree.

A branding failure never fails the scrape; it is reported in `content.branding_error`.

### Crawl

Steps 1–4 as above, then `engine.crawl()` calls `POST /v2/crawl` and stores Firecrawl's crawl
id on the job. The **Reconciler** (`services/reconciler.ts`, every `RECONCILE_INTERVAL_MS`):

- leases non-terminal jobs with `FOR UPDATE SKIP LOCKED` (safe with several API instances),
- pulls `GET /v2/crawl/:id?skip=<cursor>` and persists new pages idempotently
  (`UNIQUE(job_id, url)`), updating discovered / processed / succeeded / failed counters,
- on a terminal engine status re-scans from 0 (catches pages that raced the cursor), reads
  `GET /v2/crawl/:id/errors` to record fetch failures and robots-blocked URLs as failed pages,
  then finalises the job. A crawl with zero successful pages is `failed / CRAWL_FAILED`,
- recovers orphans: stale `queued` jobs are re-dispatched, scrapes stuck in `running` after a
  restart become `INTERRUPTED`, crawls over `MAX_CRAWL_DURATION_MS` are cancelled.

There is no second work queue. `jobs` is the durable record of a user's request. Scheduling,
retries and concurrency belong to Firecrawl (NuQ on Postgres + RabbitMQ).

## Data model

See `apps/api/migrations/001_init.sql`.

- Every user-owned table has `user_id`. Every query in `db/repos.ts` filters on it, so a foreign
  id is indistinguishable from a missing one (404).
- `jobs` and `results` reference `projects(id, user_id)` with a composite foreign key, so the
  database itself rejects a job or result whose project belongs to a different user.
- `results` holds only bounded metadata (URL, title, status, error, sizes, formats, ≤40 metadata
  keys). Bodies live in object storage at `users/<user>/jobs/<job>/<result>.json`, capped at
  `MAX_RESULT_BYTES` (HTML is trimmed first, then text, then markdown; `truncated=true`).
- `job_events` is an append-only timeline per job (created, started, crawl.started, crawl.synced,
  completed/failed/cancelled, with codes and counts).
- Passwords: scrypt (N=2^17, r=8, p=1). Session tokens and API keys: stored only as SHA-256.

## Authentication boundary

- Dashboard: `ws_session` cookie (httpOnly, SameSite=Lax, `Secure` when `COOKIE_SECURE=true`).
  Cookie-authenticated `POST/PUT/PATCH/DELETE` must come from `APP_ORIGIN` (Origin /
  Sec-Fetch-Site check).
- API: `Authorization: Bearer wsk_<8-char id>_<40-char secret>`. The id part is a lookup prefix;
  the whole key is compared by SHA-256 in constant time. Keys can be revoked and are session-only
  to manage (an API key cannot mint or revoke keys).
- `/api/*`: session or API key. `/api/v1/*` (documented public API): API key only.
- Firecrawl never sees user credentials and is never exposed publicly.

## SSRF design

Validating the submitted URL string is not enough (redirects, DNS rebinding, crawl-discovered
links, page sub-resources), so there are two layers:

1. **Pre-check in app-api** (fast, precise errors): http/https only; no embedded credentials;
   allowed ports (80, 443, 8080, 8443); hostname deny rules (`localhost`, `*.local`,
   `*.internal`, single-label names such as `redis` or `api`, cloud metadata names); IP literals
   in every notation the WHATWG parser accepts (decimal, hex, octal, IPv6, IPv4-mapped); DNS
   resolution requiring **every** returned address to be public.
2. **Enforcement in egress-proxy** (the security boundary): Firecrawl's containers sit on the
   `backend` network, declared `internal: true`, so they have no route to the internet. The
   only exit is `egress-proxy` (HTTP forward proxy + `CONNECT`, basic auth), which resolves each
   destination itself, rejects the connection if any address is non-public (RFC 1918, loopback,
   link-local / `169.254.169.254`, CGNAT, multicast, reserved, documentation ranges, IPv6
   ULA/link-local, NAT64/6to4-embedded private IPv4), and then connects to the vetted IP. That
   leaves no rebinding window, and every hop is covered: redirects, links found during a crawl,
   sub-resources, robots.txt and sitemaps.

Denials are logged as structured `egress_denied` events and counted at `egress-proxy:3128/metrics`.
A plain-http redirect to a blocked address is reported to the user as `BLOCKED_URL`. The adapter
recognises the proxy's denial body, so the user never sees a fake "403 page".

`TRUSTED_TEST_HOSTS` is the only exemption: an explicit list of exact hostnames, empty by default,
used by the e2e fixture (`testsite.test`).

## Firecrawl configuration overrides

No Firecrawl source file is modified. `infra/firecrawl.override.yml` changes:

| Override | Why |
|---|---|
| `networks.backend.internal: true` | Removes Firecrawl's direct internet access; egress only via proxy. |
| `api` / `playwright-service`: `PROXY_SERVER`, `PROXY_USERNAME`, `PROXY_PASSWORD` | Route all fetches through egress-proxy (upstream supports these variables). |
| `api`: `ALLOW_LOCAL_WEBHOOKS=true` | Upstream's fetch-engine check (`safeFetch.ts`) inspects the socket's remote address. Behind a proxy that is the proxy's private IP, so the check would either reject every request or check the wrong address. The proxy performs the check on the real destination instead. |
| `playwright-service`: `ALLOW_LOCAL_WEBHOOKS=TRUE` | Its pre-navigation check resolves DNS itself, and containers on an internal network cannot resolve public names, so it would reject everything. The proxy does the check without the TOCTOU window. |
| `api.ports: !reset []` + `firecrawl-gateway` | Containers on an internal-only network can't publish ports; a socat gateway binds `127.0.0.1:3002` for host-side development only. |
| `foundationdb*` behind profile `fdb` | Experimental queue backend, unused. |
| `nuq-postgres` added to `api.depends_on` | Upstream relies on starting every service at once. |
| Memory/CPU limits, `NUM_WORKERS_PER_QUEUE=4`, `BLOCK_MEDIA=TRUE` | Laptop-sized Docker VM. |
| Healthcheck on `api` (`/v0/health/liveness`) | Lets app-api wait for the engine. |

Adapter-level compensations (`apps/api/src/engine/firecrawl.ts`, header comment):

- always sends `proxy: "basic"`. With upstream's default `auto`, a 401/403/429 page escalates to
  a stealth proxy that doesn't exist self-hosted, and the whole scrape fails,
- derives the `text` format from HTML (Firecrawl has no plain-text format),
- treats target 4xx/5xx as failed pages while keeping their bodies,
- clamps `waitFor ≤ timeout/2` (upstream validation rule),
- maps Firecrawl error codes to our vocabulary without passing upstream messages through.

## Observability

- Structured JSON logs (pino) with request ids. `authorization`, `cookie`, `set-cookie`,
  `password`, `key` and `token` fields are redacted. Job lifecycle lines (`job.created`,
  `job.started`, `job.completed|failed|cancelled`) carry jobId, userId, projectId, url, timings,
  page counts and error code.
- `Metrics` interface (`observability/metrics.ts`) with an in-process Prometheus-text
  implementation at `/metrics`: `jobs_created_total`, `jobs_finished_total{type,status}`,
  `job_duration_ms`, `pages_total{type,outcome}`, `engine_scrape_duration_ms`,
  `http_requests_total`, `http_request_duration_ms`, `api_errors_total{code,status}`,
  `url_policy_rejections_total{code}`, `jobs_active{status}`.
  To move to OpenTelemetry or Datadog, implement `Metrics` against that SDK and pass it to
  `buildApp`. No call sites change.

## Extension points for later phases

- **Reliability / proxy / browser orchestration:** wrap or replace `ScrapingEngine` (for example
  `RetryingEngine(FirecrawlEngine)`, or a native Playwright pool engine). Routes, persistence and
  UI stay the same.
- **Network intelligence:** egress-proxy is already the choke point for every outbound
  connection. Per-destination routing, upstream proxy pools and telemetry belong there.
- **Storage:** implement `ObjectStorage` for S3/R2 (four methods).
- **Metrics/tracing:** implement `Metrics`, and add OTel HTTP instrumentation in `buildApp`.
