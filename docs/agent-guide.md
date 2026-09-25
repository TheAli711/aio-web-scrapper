# Web Scraper API: guide for agents

Base URL: {{BASE_URL}}/api/v1
Full machine-readable spec: {{BASE_URL}}/api/v1/openapi.json
Human docs: {{BASE_URL}}/api/v1/docs

This service fetches web pages and returns clean Markdown, HTML or plain text. It can also crawl
a whole site. Use it whenever you need the content of a public web page.

## Authentication

Every request needs this header:

    Authorization: Bearer <API_KEY>

API keys look like `wsk_XXXXXXXX_...` (53 characters). For a local install, the key is in
`.local/credentials.env` (`WS_API_KEY`), printed by `./scripts/local.sh up`.

## Recipe 1: get one page as Markdown (single request)

    POST /api/v1/scrape?wait=true
    Content-Type: application/json

    {"url": "https://example.com", "formats": ["markdown"]}

The request blocks until the page is fetched (usually 1–10 s) and returns HTTP 200:

    {
      "job":    { "id": "…", "status": "completed", "error": null, … },
      "result": {
        "url": "https://example.com/", "title": "Example Domain", "status_code": 200, "success": true,
        "content": { "markdown": "Example Domain\n==============\n…", "links": ["https://iana.org/…"] },
        "metadata": { "description": "…", "language": "en" }, …
      }
    }

- Read `result.content.markdown` (or `.html` / `.text` if you asked for those formats).
- If `job.status` is `"failed"`, read `job.error.code` and `job.error.message`. `result` can still
  hold the body of an error page (for example a 404).
- If the page takes longer than the wait window, you get HTTP 202 with just the job. Continue
  with Recipe 2 from the polling step.

curl:

    curl -s -X POST "{{BASE_URL}}/api/v1/scrape?wait=true" \
      -H "Authorization: Bearer $WS_API_KEY" -H "Content-Type: application/json" \
      -d '{"url":"https://example.com","formats":["markdown"]}' | jq -r '.result.content.markdown'

## Recipe 2: crawl a website (asynchronous)

1. Start:

       POST /api/v1/crawl
       {"url": "https://docs.example.com/", "max_pages": 25, "max_depth": 2,
        "include_patterns": ["^/guide/"], "exclude_patterns": ["/changelog"], "formats": ["markdown"]}

   Response is HTTP 202 with a job; keep `job.id`.

2. Poll every 2–5 s until `status` is `completed`, `failed` or `cancelled`:

       GET /api/v1/jobs/{id}
       → {"status": "running", "progress": {"pages_discovered": 14, "pages_processed": 9,
           "pages_succeeded": 8, "pages_failed": 1}, …}

   Pages are already readable while the crawl runs.

3. Read the pages, 100 at a time:

       GET /api/v1/jobs/{id}/results?include_content=true&limit=100&offset=0

   → `{"data": [ {url, title, status_code, success, error, content: {markdown, …}}, … ],
       "pagination": {"total": 25, "next_offset": null}}`. Repeat with `offset=next_offset`
   until `next_offset` is null. Add `&success=true` to skip failed pages.

   Or download everything at once as JSON Lines (one result per line, with content):

       GET /api/v1/jobs/{id}/export

## Request fields

| Field | Applies to | Default | Notes |
|---|---|---|---|
| `url` | both | required | http/https only, public hosts only |
| `formats` | both | `["markdown"]` | any of `markdown`, `html`, `text`; scrape only: `branding` (logo, favicon, brand colors, fonts in `content.branding`; adds ~15–30 s) |
| `only_main_content` | both | `true` | strips nav, header and footer |
| `timeout_ms` | both | 30000 | per page; server max 90000 |
| `wait_for_ms` | both | 0 | extra wait after load for JS-heavy pages; ≤ timeout_ms/2 |
| `project_id` | both | your default project | uuid from `GET /api/v1/projects` |
| `max_pages` | crawl | 50 | server max 500 |
| `max_depth` | crawl | 3 | link hops from the start URL; server max 10 |
| `include_patterns` / `exclude_patterns` | crawl | none | regexes on the URL **path**, e.g. `^/blog/` |
| `allowed_domain` | crawl | start host | the start host or a parent domain of it |
| `allow_subdomains` | crawl | false | follow links to subdomains of `allowed_domain` |

## Other endpoints

| Call | Use |
|---|---|
| `GET /api/v1/jobs?limit=20&type=crawl&status=running` | list your recent jobs |
| `POST /api/v1/jobs/{id}/cancel` | stop a queued or running job |
| `GET /api/v1/results/{result_id}` | one result with content |
| `GET /api/v1/results/{result_id}/download?format=markdown` | raw file (`markdown`, `html`, `text`, `json`) |
| `GET /api/v1/projects` | list projects |

## Errors

Every error has this shape: `{"error": {"code": "…", "message": "…", "details": {…}, "requestId": "…"}}`.

| code | HTTP | What to do |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Fix the request (see `details.issues`) |
| `INVALID_URL`, `UNSUPPORTED_URL` | 400 | Fix the URL; only http(s) without credentials is accepted |
| `BLOCKED_URL` | 400 | Private, internal or metadata address, or a disallowed port. Don't retry. |
| `LIMIT_EXCEEDED` | 400 | Lower the value to `details.max` |
| `DNS_RESOLUTION_FAILED` | 422 | The host doesn't exist. Check spelling. |
| `UNAUTHENTICATED`, `INVALID_API_KEY` | 401 | Check the Authorization header |
| `NOT_FOUND` | 404 | Wrong id, or not yours |
| `RATE_LIMITED` | 429 | Wait `details.retryAfterSeconds` (also in the `Retry-After` header), then retry |
| `TOO_MANY_ACTIVE_JOBS` | 429 | Too many jobs queued or running; wait for some to finish |

Codes on a failed job or failed page (`job.error.code`, `result.error.code`):

| code | Meaning | Retry? |
|---|---|---|
| `HTTP_ERROR` | Site answered 4xx/5xx (`status_code` shows which) | Only for 429/5xx, after a pause |
| `TIMEOUT` | Page didn't load in time | Yes, with a larger `timeout_ms` or `wait_for_ms` |
| `CONNECTION_FAILED`, `SSL_ERROR` | Couldn't connect | Once, later |
| `BLOCKED_URL` | A redirect led to a private address | No |
| `ROBOTS_DISALLOWED` | Disallowed by robots.txt (crawl) | No |
| `ENGINE_UNAVAILABLE` | Scraper overloaded or starting | Yes, after 10–30 s |
| `CRAWL_FAILED`, `EXTRACTION_FAILED`, `INTERRUPTED` | Engine-side failure | Yes, once |

## Limits

- 300 requests/min per key; 30 new jobs/min per key; 10 queued or running jobs at a time.
- Page content is capped at 5 MB per page (`truncated: true` when cut).
- Only public internet hosts can be fetched. Private networks, localhost and cloud metadata
  addresses are always blocked.

## Tips

- For "read this page", use Recipe 1 with `formats: ["markdown"]`. Markdown is the most compact
  representation to feed a model.
- For JS-heavy pages that come back nearly empty, retry with `"wait_for_ms": 3000`.
- `result.content.links` lists absolute URLs found on the page. Use them to pick the next pages
  to scrape instead of crawling a whole site.
- Crawls are asynchronous. Don't hold one request open waiting for a crawl; poll the job.
