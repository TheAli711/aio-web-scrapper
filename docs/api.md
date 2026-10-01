# Public API (v1)

Base URL: `http://localhost:4000/api/v1` (API directly) or `http://localhost:3000/api/v1`
(through the dashboard origin). Interactive reference: `/api/v1/docs`.
Machine-readable spec: [openapi.json](openapi.json) (also served at `/api/v1/openapi.json`).
Guide for LLM agents: [agent-guide.md](agent-guide.md) (served at `/api/v1/llms.txt`, with the
base URL filled in).

**Quickest path:** `POST /api/v1/scrape?wait=true` with `{"url": "..."}` returns the finished job
and the page content in one response. `project_id` is optional everywhere (defaults to your
oldest project).

## Authentication

Create a key in the dashboard (**API keys**). The secret is displayed once.

```
Authorization: Bearer wsk_XXXXXXXX_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

`/api/v1/*` accepts API keys only. Missing key → `401 UNAUTHENTICATED`; bad or revoked key →
`401 INVALID_API_KEY`.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/llms.txt` | Agent guide in Markdown (no auth) |
| GET | `/openapi.json` | OpenAPI 3.1 spec (no auth) |
| GET | `/projects` | List your projects (to get a `project_id`) |
| POST | `/scrape` | Create a scrape job → `202` + Job |
| POST | `/crawl` | Create a crawl job → `202` + Job |
| POST | `/map` | List a site's URLs without scraping them → `200` (synchronous, no job) |
| GET | `/jobs` | List jobs (`project_id`, `status`, `type`, `limit`, `before`) |
| GET | `/jobs/{id}` | Job status and progress |
| POST | `/jobs/{id}/cancel` | Cancel a queued/running job |
| GET | `/jobs/{id}/results` | Paginated results (`limit`≤100, `offset`, `success`, `include_content`) |
| GET | `/jobs/{id}/export` | All results with content, `format=jsonl` (default) or `json` |
| GET | `/results/{id}` | One result with content |
| GET | `/results/{id}/download` | `format=markdown|html|text|json`, as an attachment |
| POST | `/traffic` | Estimate a website's monthly visits → `200` (ready) or `202` (being computed) |
| GET | `/traffic/{domain}` | Latest traffic estimate for a domain |
| POST | `/traffic/bulk` | Estimate up to 100 websites at once → `202` |

Jobs are asynchronous: create, poll `GET /jobs/{id}` until `status` is `completed`, `failed` or
`cancelled`, then read results. Crawl results appear while the crawl is still running.

### POST /scrape

```json
{
  "url": "https://example.com",
  "project_id": "uuid",
  "formats": ["markdown", "html", "text"],
  "only_main_content": true,
  "timeout_ms": 30000,
  "wait_for_ms": 0
}
```

`formats` defaults to `["markdown"]`. `timeout_ms` defaults to 30000 (server max
`MAX_SCRAPE_TIMEOUT_MS`). `wait_for_ms` must be ≤ `timeout_ms / 2`. `project_id` is optional.

When a page comes back empty (JavaScript-rendered sites such as Square Online) and `wait_for_ms`
is 0, the server retries once with a 5 s render wait before reporting a failure.

#### `branding` format (scrape only)

Add `"branding"` to `formats` to also get the site's logo, favicon, brand colors and fonts:

```json
"content": {
  "markdown": "...",
  "branding": {
    "logo": { "url": "https://…/logo.png", "image": "data:image/png;base64,…", "source": "dom-img",
              "text": null, "alt": "Zona Med Spa", "width": 180, "height": 75,
              "tone": "dark", "colors": ["#010101"], "confidence": "high" },
    "favicon": { "url": "https://…/favicon-32x32.png", "sizes": "32x32", "type": "image/png", "source": "link" },
    "icons": [ { "url": "…", "rel": "apple-touch-icon", "sizes": "180x180", "type": null } ],
    "colors": { "primary": "#6B8F71", "secondary": "#B4795A", "accent": null,
                "background": "#FFFFFF", "text": "#000000",
                "palette": [ { "hex": "#6B8F71", "weight": 5.1, "sources": ["buttons", "background"] } ],
                "basis": "buttons+background", "confidence": "medium" },
    "fonts": { "heading": "Cormorant Garamond", "body": "Maven Pro" },
    "theme_color": null, "og_image": "https://…", "site_name": "Zona Med Spa", "final_url": "https://…"
  },
  "branding_error": null
}
```

- The page is loaded in a real browser (separate from the content scrape, in parallel) and
  scrolled once; expect 15–30 s extra. `?wait=true` allows 60 s more when branding is requested.
- `logo.source`: `dom-img`, `dom-svg` (`url` is an SVG data URI), `dom-background` (CSS background),
  `dom-text` (styled site name; see `logo.text`), `json-ld` (schema.org `logo`) or `icon` (fallback).
  `logo.image` is a PNG of the logo exactly as rendered (dropped first if the result exceeds the
  size limit). `tone`: `dark` = drawn for light backgrounds, `light` = for dark backgrounds.
- Colors come from what the page actually paints: buttons and CTAs weigh most, then the logo's
  own pixels, named CSS brand variables, the header, links and headings, and visible surfaces.
  Page-builder default palettes and third-party widgets (chat, social feeds, cookie banners) are
  ignored. `secondary` is a second hue when the brand has one, otherwise a brand neutral.
  `basis` lists the signals behind `primary`.
- `confidence: "low"` on `logo` or `colors` means the heuristics were unsure; treat as a hint.
- If branding fails but the page scraped, the job still completes: `branding` is `null` and
  `branding_error` says why (`TIMEOUT`, `HTTP_ERROR`, `CONNECTION_FAILED`, ...).
- Requesting `branding` on a crawl returns `VALIDATION_ERROR`.

`?wait=true` blocks until the scrape finishes (up to `timeout_ms + 30s`) and returns **200**
`{"job": Job, "result": Result-with-content | null}`. A failed scrape also returns 200, with
`job.status = "failed"` and `job.error`. If the deadline passes first, the response is the usual
**202** + Job.

### POST /crawl

Everything from `/scrape` plus:

```json
{
  "max_depth": 3,
  "max_pages": 200,
  "include_patterns": ["^/blog/"],
  "exclude_patterns": ["/tag/", "\\.pdf$"],
  "allowed_domain": "example.com",
  "allow_subdomains": false
}
```

Patterns are regular expressions matched against the URL path (≤20 each, ≤200 chars).
`allowed_domain` defaults to the start URL's host and must be that host or a parent domain.
Defaults: `max_pages` 200, `max_depth` 3. Server caps: `MAX_CRAWL_PAGES` (default 2000),
`MAX_CRAWL_DEPTH`, `MAX_CRAWL_DURATION_MS`.

**Store crawls.** A crawl that starts at the home page of a Magento, Shopify or WooCommerce store
(and sets no `include_patterns`) reads product URLs from the store's public catalog instead of
relying on link-following, which on large stores runs out of pages in the category menu before
reaching any product. 25% of `max_pages` is reserved for products; the rest goes to the site's
other pages (sitemap, then links on the home page), and slots those leave unused go to more
products. Pages are fetched one link deep from the home page in this mode, so `max_depth` has no
further effect. If the store's catalog is not reachable, the crawl runs normally.

### POST /map

Lists a site's URLs without scraping them. Synchronous (usually 2–20 s); no job is created.

```json
{
  "url": "https://shop.example.com/",
  "limit": 5000,
  "include_patterns": [],
  "exclude_patterns": ["/tag/"],
  "allowed_domain": "example.com",
  "allow_subdomains": false
}
```

Only `url` is required. `limit` defaults to 5000 (server cap `MAX_MAP_URLS`, default 10000);
the pattern and domain fields work as for `/crawl`. Response **200**:

```json
{
  "url": "https://shop.example.com/",
  "platform": "magento",
  "product_urls": 3750,
  "count": 5000,
  "urls": ["https://shop.example.com/", "https://shop.example.com/some-product.html", "..."]
}
```

`urls` starts with the start URL, then product pages from the store's public catalog (when
`platform` is `magento`, `shopify` or `woocommerce`; 25% of `limit` is reserved for them),
sitemap entries and the start page's links, deduplicated. If the start page can't be loaded
and nothing else is found, the response is an error (`TIMEOUT`, `CONNECTION_FAILED`, ...).

### Traffic estimates

Monthly visits for a website, **estimated** from public signals: popularity rankings (Tranco, the
Chrome UX Report top list, Majestic, Open PageRank), the Common Crawl link graph, a short crawl of
the site (sitemaps, technologies) and DNS. It is not measured traffic: nobody's analytics are read.
Use the range and the bucket; the point estimate is an order of magnitude. Estimates are per
registrable domain, shared by all API users, and reused for 7 days.

#### POST /traffic

```json
{ "domain": "example.com", "refresh": false }
```

| Field / query | Default | Notes |
|---|---|---|
| `domain` | required | A domain or URL. Reduced to the registrable domain: `https://www.shop.example.co.uk/x` → `example.co.uk` (subdomains count towards their parent). |
| `refresh` | `false` | `true` collects fresh data even if the domain was estimated in the last 7 days. |
| `?wait=true` | `false` | Block until the estimate is ready, up to 60 s (`TRAFFIC_WAIT_MS`). |
| `?details=true` | `false` | Add `estimate.details`, the per-signal breakdown (diagnostic; its shape may change). |

Returns `200` with the estimate when it is ready, or `202` (with a `Location` header) while it is
being computed: poll `GET /traffic/{domain}` every few seconds. A domain estimated in the last 7
days answers at once; a new one takes 10–30 s (the site is crawled politely).

```json
{
  "domain": "example.com",
  "status": "ready",
  "refreshing": false,
  "estimate": {
    "estimated_monthly_visits": 18256,
    "lower_bound": 3263,
    "upper_bound": 102153,
    "traffic_bucket": "10K-100K",
    "confidence": "high",
    "confidence_score": 0.88,
    "model_version": "heuristic_v2",
    "generated_at": "2026-10-01T12:17:58.272Z"
  },
  "error": null,
  "disclaimer": "Estimated from public signals (popularity rankings, link graphs, our crawl and DNS); not measured traffic.",
  "links": { "self": "/api/v1/traffic/example.com" }
}
```

| Field | Meaning |
|---|---|
| `status` | `pending` (no estimate yet), `ready` (`estimate` is set) or `failed` (no estimate could be made; `error` says why, code `ESTIMATION_FAILED`) |
| `refreshing` | `true` while a newer estimate is computed; `estimate` is still the previous one |
| `estimated_monthly_visits` | Point estimate of visits per month, worldwide, all devices |
| `lower_bound`, `upper_bound` | Plausible range (at least ×3 either side of the estimate; wider when evidence is thin or the signals disagree) |
| `traffic_bucket` | `<1K`, `1K-10K`, `10K-100K`, `100K-1M`, `1M-10M` or `10M+` |
| `confidence`, `confidence_score` | How much evidence backs the estimate (`high` ≥ 0.70, `medium` ≥ 0.40, else `low`), not how large it is |
| `model_version` | Estimator that produced the number; changes when the method changes |

#### GET /traffic/{domain}

The latest estimate for a domain requested earlier (by anyone), same shape as above, always `200`.
`404 NOT_FOUND` if the domain was never requested. `?details=true` as above.

#### POST /traffic/bulk

```json
{ "domains": ["example.com", "shop.example.org", "https://www.example.net/about"], "refresh": false }
```

Up to 100 domains. Answers at once with `202` and one item per input, in order: domains estimated
in the last 7 days come back `ready` with their estimate, new ones `pending` (poll each
`links.self`), unusable input `invalid` (`error.code = INVALID_DOMAIN`, `domain` and `links`
null). Each item is the object above plus `input`; `disclaimer` is given once at the top level.

### Job

```json
{
  "id": "uuid",
  "project_id": "uuid",
  "type": "crawl",
  "target_url": "https://example.com/",
  "status": "running",
  "source": "api",
  "options": { "formats": ["markdown"], "max_pages": 200, "max_depth": 3, "...": "..." },
  "progress": { "pages_discovered": 12, "pages_processed": 7, "pages_succeeded": 6, "pages_failed": 1 },
  "error": null,
  "created_at": "2026-09-24T12:00:00.000Z",
  "started_at": "2026-09-24T12:00:00.100Z",
  "completed_at": null,
  "duration_ms": null,
  "links": { "self": "/api/v1/jobs/uuid", "results": "/api/v1/jobs/uuid/results" }
}
```

Status lifecycle: `queued → running → completed | failed | cancelled`. `error` is
`{code, message}` on failed jobs.

### Result

```json
{
  "id": "uuid",
  "job_id": "uuid",
  "project_id": "uuid",
  "url": "https://example.com/",
  "title": "Example Domain",
  "status_code": 200,
  "success": true,
  "error": null,
  "formats": ["markdown", "text"],
  "content_bytes": 661,
  "truncated": false,
  "links_count": 1,
  "metadata": { "description": "…", "language": "en", "finalUrl": "…" },
  "created_at": "…",
  "content": { "markdown": "…", "text": "…", "links": ["…"] }
}
```

`content` is present on `GET /results/{id}` and on `/jobs/{id}/results?include_content=true`.
Pages with HTTP ≥ 400 have `success: false`, `error.code = HTTP_ERROR`, and still keep their
body. Pages the engine could not fetch at all have `success: false` and no content.

## Errors

Every error has the same shape:

```json
{ "error": { "code": "BLOCKED_URL", "message": "Target address is not publicly routable (loopback)", "details": {}, "requestId": "…" } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Body/query failed validation (`details.issues[]`) |
| `INVALID_URL` | 400 | URL cannot be parsed / is empty / too long |
| `UNSUPPORTED_URL` | 400 | Non-http(s) scheme, embedded credentials, unsupported content |
| `BLOCKED_URL` | 400 | Target is private/internal/metadata, port not allowed, or a redirect went there |
| `LIMIT_EXCEEDED` | 400 | Option above server limit (`details.field`, `details.max`) |
| `INVALID_DOMAIN` | 400 | Traffic: the input is not a registrable public domain |
| `DNS_RESOLUTION_FAILED` | 422 | Hostname does not resolve |
| `UNAUTHENTICATED` / `INVALID_API_KEY` | 401 | Missing / invalid credentials |
| `FORBIDDEN` | 403 | Credential type not allowed here, or cross-origin cookie request |
| `NOT_FOUND` | 404 | No such resource **for you** (other users' ids are indistinguishable) |
| `JOB_NOT_CANCELLABLE` | 409 | Job already terminal |
| `RATE_LIMITED` | 429 | See `Retry-After` and `details.retryAfterSeconds` |
| `TOO_MANY_ACTIVE_JOBS` | 429 | Per-user queued+running cap reached |
| `TRAFFIC_UNAVAILABLE` | 503 | Traffic estimator unreachable or not enabled on this server; retry later |
| `INTERNAL_ERROR` | 500 | Unexpected; quote `requestId` |

Codes that appear on failed **jobs** and **results**: `TIMEOUT`, `HTTP_ERROR`,
`CONNECTION_FAILED`, `SSL_ERROR`, `DNS_RESOLUTION_FAILED`, `BLOCKED_URL`, `ROBOTS_DISALLOWED`,
`CRAWL_FAILED`, `EXTRACTION_FAILED`, `ENGINE_UNAVAILABLE`, `INTERRUPTED`.

## Rate limits

Per API key: `RATE_LIMIT_PER_MINUTE` (default 300) overall, and `RATE_LIMIT_JOB_CREATE_PER_MINUTE`
(default 30) on each of `POST /scrape`, `POST /crawl`, `POST /map`, `POST /traffic` and `POST /traffic/bulk`
(counted per endpoint). Responses carry `x-ratelimit-limit`,
`x-ratelimit-remaining` and `x-ratelimit-reset`; a `429` carries `retry-after`.
