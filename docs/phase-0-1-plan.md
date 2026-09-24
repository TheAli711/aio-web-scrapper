I would keep **Phase 0 and Phase 1 as explicit project documents**, then give Claude a tightly scoped **Phase 2 implementation prompt**. The key is to tell Claude not to redesign Firecrawl or prematurely build the proxy/anti-bot layer.

Current Firecrawl guidance says to begin from an exact release/tag, get the baseline running, and understand the revision's Compose/services before changing it. Its current self-host setup includes the API/workers, Playwright, Redis, RabbitMQ and NuQ PostgreSQL. ([GitHub][1])

# Phase 0 — Product Definition

### Objective

Define what we are building and what the first usable version must accomplish.

### Product

A commercial web-data platform built on top of open-source Firecrawl, initially targeting developers, AI companies, and data teams that need reliable web scraping/crawling through an API and dashboard.

### Core use cases

1. Scrape a single URL.
2. Crawl an entire website.
3. Return clean Markdown/HTML/text.
4. Return structured JSON.
5. Allow developers to consume results through an API.
6. Allow users to inspect and download results through a dashboard.

### Initial differentiation

Do **not** attempt to differentiate through proxy rotation or CAPTCHA handling yet.

The longer-term differentiation will be:

* adaptive scraping
* reliability
* network/proxy infrastructure
* browser orchestration
* observability
* structured extraction
* developer experience

### MVP success criteria

A user should be able to:

```text
Sign up
  ↓
Create project
  ↓
Enter URL
  ↓
Choose Scrape or Crawl
  ↓
Run job
  ↓
See status
  ↓
Inspect results
  ↓
Download results
```

And a developer should be able to:

```text
POST URL
   ↓
API
   ↓
Scraping engine
   ↓
JSON / Markdown result
```

### Out of scope for Phase 2

Do not build yet:

* proxy rotation
* residential proxy infrastructure
* CAPTCHA solving
* sophisticated anti-bot bypass
* multi-region infrastructure
* Kubernetes
* billing
* complex team permissions
* advanced AI extraction
* autonomous scraping intelligence

---

# Phase 1 — Firecrawl Technical Recon

### Objective

Understand Firecrawl well enough that we know **what to reuse, what to extend, and what to eventually replace**.

### Step 1 — Pin the baseline

Fork Firecrawl and use a specific release/tag rather than developing against floating `main`. Firecrawl's current self-hosting documentation explicitly recommends this. ([GitHub][1])

### Step 2 — Run locally

Get the upstream system working without modifications.

Verify:

```text
/scrape
/crawl
/map
/extract
```

as supported by the checked-out version. The current API specification includes `/scrape` and other scraping functionality. ([GitHub][2])

### Step 3 — Understand the architecture

Document:

```text
API
 ↓
Job creation
 ↓
Queue
 ↓
Worker
 ↓
HTTP / Playwright
 ↓
Extraction
 ↓
Storage
 ↓
Response
```

Identify:

* API services
* workers
* queues
* database
* Redis
* browser infrastructure
* extraction pipeline
* storage
* authentication
* configuration
* Fire-engine integration

The current self-hosting documentation says the baseline uses bundled Playwright with basic fetch fallback and treats Fire-engine as a separate engine that can be connected when needed. ([GitHub][1])

### Step 4 — Benchmark

Create a fixed test corpus of roughly 20–30 URLs:

```text
Static HTML
WordPress
Next.js
React SPA
Documentation
E-commerce
Pagination
Infinite scroll
Large website
Slow website
PDF
Image-heavy website
Sites returning 403/429
```

Record:

```text
success/failure
HTTP status
latency
browser required?
extraction quality
crawl completeness
memory/CPU
```

### Step 5 — Identify extension points

Create a document:

```text
KEEP
EXTEND
REPLACE LATER
BUILD OURSELVES
```

### Phase 1 exit criteria

At the end of Phase 1:

> Firecrawl runs locally, we understand the major execution path, we have benchmark data, and we know exactly where our own product layer will sit.

---
