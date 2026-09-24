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
| GET | `/jobs` | List jobs (`project_id`, `status`, `type`, `limit`, `before`) |
| GET | `/jobs/{id}` | Job status and progress |
| POST | `/jobs/{id}/cancel` | Cancel a queued/running job |
| GET | `/jobs/{id}/results` | Paginated results (`limit`≤100, `offset`, `success`, `include_content`) |
| GET | `/jobs/{id}/export` | All results with content, `format=jsonl` (default) or `json` |
| GET | `/results/{id}` | One result with content |
| GET | `/results/{id}/download` | `format=markdown|html|text|json`, as an attachment |

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

`?wait=true` blocks until the scrape finishes (up to `timeout_ms + 30s`) and returns **200**
`{"job": Job, "result": Result-with-content | null}`. A failed scrape also returns 200, with
`job.status = "failed"` and `job.error`. If the deadline passes first, the response is the usual
**202** + Job.

### POST /crawl

Everything from `/scrape` plus:

```json
{
  "max_depth": 3,
  "max_pages": 50,
  "include_patterns": ["^/blog/"],
  "exclude_patterns": ["/tag/", "\\.pdf$"],
  "allowed_domain": "example.com",
  "allow_subdomains": false
}
```

Patterns are regular expressions matched against the URL path (≤20 each, ≤200 chars).
`allowed_domain` defaults to the start URL's host and must be that host or a parent domain.
Server caps: `MAX_CRAWL_PAGES`, `MAX_CRAWL_DEPTH`, `MAX_CRAWL_DURATION_MS`.

### Job

```json
{
  "id": "uuid",
  "project_id": "uuid",
  "type": "crawl",
  "target_url": "https://example.com/",
  "status": "running",
  "source": "api",
  "options": { "formats": ["markdown"], "max_pages": 50, "max_depth": 3, "...": "..." },
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
| `DNS_RESOLUTION_FAILED` | 422 | Hostname does not resolve |
| `UNAUTHENTICATED` / `INVALID_API_KEY` | 401 | Missing / invalid credentials |
| `FORBIDDEN` | 403 | Credential type not allowed here, or cross-origin cookie request |
| `NOT_FOUND` | 404 | No such resource **for you** (other users' ids are indistinguishable) |
| `JOB_NOT_CANCELLABLE` | 409 | Job already terminal |
| `RATE_LIMITED` | 429 | See `Retry-After` and `details.retryAfterSeconds` |
| `TOO_MANY_ACTIVE_JOBS` | 429 | Per-user queued+running cap reached |
| `INTERNAL_ERROR` | 500 | Unexpected; quote `requestId` |

Codes that appear on failed **jobs** and **results**: `TIMEOUT`, `HTTP_ERROR`,
`CONNECTION_FAILED`, `SSL_ERROR`, `DNS_RESOLUTION_FAILED`, `BLOCKED_URL`, `ROBOTS_DISALLOWED`,
`CRAWL_FAILED`, `EXTRACTION_FAILED`, `ENGINE_UNAVAILABLE`, `INTERRUPTED`.

## Rate limits

Per API key: `RATE_LIMIT_PER_MINUTE` (default 300) overall, and `RATE_LIMIT_JOB_CREATE_PER_MINUTE`
(default 30) for `POST /scrape` and `POST /crawl`. Responses carry `x-ratelimit-limit`,
`x-ratelimit-remaining` and `x-ratelimit-reset`; a `429` carries `retry-after`.
