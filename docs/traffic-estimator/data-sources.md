# Data sources

Every source below was checked live on **2026-10-01** (endpoints, formats, limits). Nothing here is
traffic. They are popularity, link-graph, size, freshness and infrastructure signals that the
estimator combines. Each source is isolated behind a collector or list provider so it can be
disabled, replaced or added without touching the rest of the pipeline.

| Source | Kind | Access | Per-domain cost | Scale (1M domains) | Default |
|---|---|---|---|---|---|
| Tranco | bulk ranked list | free download, no key | 0 requests (local lookup) | fine | on |
| Majestic Million | bulk ranked list | free download (CC BY 3.0) | 0 | fine | on |
| Open PageRank top 10M | bulk ranked list | free download | 0 | fine | on |
| CrUX top list (crux-top-lists) | bulk ranked list | free download (CC BY 4.0 data) | 0 | fine | on |
| Common Crawl web graph (domain ranks) | bulk file → on-disk index | free download (2.5 GB per quarterly release) | 0 (index lookup) | fine | on |
| Common Crawl CDX index | per-domain API | free, heavily throttled | 1 request per crawl queried | **not viable** | off (opt-in, small batches) |
| Own crawl | per-domain HTTP | our crawler via egress-proxy | ~20–40 requests | days–weeks, horizontally scalable | on |
| DNS (DoH JSON) | per-domain API | free (Google/Cloudflare DoH) | ~8 requests | fine (rate: 1500 QPS/IP at Google) | on |
| RDAP | per-domain API | free, per-registry limits | 1 request | slow (≈1–2 rps/registry) | on |
| Wayback Machine | per-domain API | free, undocumented limits | 1 request | 2–3 weeks at 0.5 rps | round 2 |
| CrUX API | per-domain API | free key, 150 QPM | 1 request | ~5 days; adds no volume signal | round 2 |
| HTTP Archive | BigQuery | free tier 1 TB/month, needs a Google account | bulk monthly query | fine as a monthly bulk job | round 2 |

## Bulk ranked lists (`lists/providers.py`)

Lists are downloaded by the scheduler on each provider's cadence (`list_refresh` tasks), streamed
into Postgres with `COPY` (`ranked_lists` + `ranked_list_entries`), and looked up locally by the
`lists` collector. The Common Crawl web graph is the exception (133M rows): it becomes an on-disk
index instead. First load downloads ~2.8 GB in total.

### Tranco
- Latest list id: `GET https://tranco-list.eu/top-1m-id` (plain text, e.g. `Q2K34`). Metadata:
  `GET /api/lists/id/{id}` (JSON with `created_on`, providers, window).
- Full list (~4.6M pay-level domains, ~100 MB CSV, no header, `rank,domain`):
  `GET /download/{id}/full`. Top 1M only: `/download/{id}/1000000` (`TE_TRANCO_SCOPE=1000000`).
- No account, no key, no documented bulk-download limit. The per-domain API
  (`/api/ranks/domain/{domain}`) is limited to 1 request/second and is **not used**.
- Composition (Oct 2026): CrUX, Farsight, Majestic, Cloudflare Radar, Umbrella, Dowdall
  combination over 30 days. **Licensing note:** Radar input data is CC BY-NC 4.0; for commercial
  use, review this or generate a custom Tranco list without Radar (free account).
- Tranco rank is a popularity signal, not traffic.

### Majestic Million
- `GET https://downloads.majestic.com/majestic_million.csv` (~80 MB, header row), daily.
  Columns used: `GlobalRank`, `Domain`, `RefSubNets` (referring class-C subnets), `RefIPs`.
- License CC BY 3.0 (attribution required). Backlink-breadth signal; top 1M only.

### Open PageRank (top 10M)
- `GET https://openpagerank.keywordseverywhere.com/downloads/top10milliondomains.csv.zip`
  (~117 MB zip; header `Rank,Domain,Extension,Open Page Rank,Referring Domains`), monthly, derived
  from Common Crawl. Terms ask to attribute Common Crawl. The bulk API's free tier (30k domains
  per month) is not used.

### CrUX top list
- `GET https://raw.githubusercontent.com/zakird/crux-top-lists/main/data/global/current.csv.gz`
  (~9 MB, `origin,rank`; rank buckets 1000, 5000, 10000, 50000, 100000, 500000, 1000000), monthly.
  Origins are mapped to registrable domains; the best bucket per domain is kept. The underlying
  data (Chrome UX Report) is CC BY 4.0. Buckets for the long tail (5M–50M) exist only in BigQuery
  (`chrome-ux-report.experimental.global`, ≈1.5 GB per monthly query, fits the free tier) — a
  candidate for round 2.
- A CrUX bucket means "the origin is within the top N by Chrome page loads". It is not a visit count.

### Common Crawl web graph (domain-level ranks)
- Catalog: `GET https://index.commoncrawl.org/graphinfo.json` (newest release first, e.g.
  `cc-main-2026-jul-aug-sep`: 133M domains, 2.15B arcs).
- File: `https://data.commoncrawl.org/projects/hyperlinkgraph/{id}/domain/{id}-domain-ranks.txt.gz`
  (2.5 GB gzip, 9.2 GB text, 133.2M rows, tab-separated: `harmonicc_pos harmonicc_val pr_pos pr_val
  host_rev n_hosts`, sorted by harmonic centrality; domains in reversed notation `com.example`).
  Anonymous HTTPS, verified.
- A file sorted by rank cannot be searched by domain, and 133M rows are too many for Postgres, so
  the loader builds an on-disk index (`lists/webgraph_index.py`): records sorted by a 64-bit hash
  of the domain, plus a 2^20-slot table pointing into them, read through `mmap`. A lookup is a
  few page reads (~0.3 ms in Docker), so every domain, long tail included, resolves at once.
  The index keeps harmonic rank, PageRank rank and host count (not the float centrality values)
  in 20 bytes per domain: 2.67 GB. Building it takes ~3 minutes in a child process (one pass over
  the gzip into 256 hash partitions, then each partition sorted, peak ~8 GB disk and ~100 MB RAM);
  the gzip is deleted afterwards. `ranked_lists.file_path` points at the index; a missing or
  invalid index reads as "list not loaded", which makes the next lookup request a rebuild.
  Verified on the 2026 Jul–Sep release against the earlier Postgres load: 20,793 domains, no
  mismatch.
- Referring-domain counts are not in the ranks file; they can be derived offline from
  `-domain-edges.txt.gz` (8 GB) — documented follow-up. We use Open PageRank's referring domains instead.

## Common Crawl CDX index (`collectors/commoncrawl.py`)

- Crawl list: `GET https://index.commoncrawl.org/collinfo.json` (cached 24 h in `kv_cache`).
- Query per crawl: `GET {cdx-api}?url={domain}&matchType=domain&output=json&fl=url,timestamp,status,mime-detected,digest&limit=15000`
  (NDJSON). Summarised client-side: URL count, unique paths, subdomains, status/MIME mix,
  first/last capture; nothing but counts is stored.
- The FAQ says the server is "frequently abused and therefore heavily rate limited"; 503/504 are
  common and offenders are blocked ~24 h. During verification the server answered 504 to every
  request after ~5 spaced queries. The collector therefore runs with a **global concurrency of 1**,
  ~0.5 requests/second, long back-off and 2 recent crawls. It fails cleanly (the estimate is
  produced without it, confidence lower). **Disable it for large batches** by removing
  `"commoncrawl"` from `TE_ENABLED_COLLECTORS`.
- Scalable alternative (not implemented): one bulk aggregation of the columnar index
  (`s3://commoncrawl/cc-index/table/cc-main/warc/crawl=CC-MAIN-*/subset=warc/*.parquet`,
  ~300 GB per crawl, anonymous HTTPS) with DuckDB over HTTP (free, slow) or Athena (paid, cents per
  query). Terms: https://commoncrawl.org/terms-of-use.

## Own crawler (`collectors/crawler/`)

Budget per domain (configurable): homepage (tries https/http, apex/www), `robots.txt`, up to
`TE_CRAWL_MAX_SITEMAPS` sitemap files (indexes spread-sampled, URL budget
`TE_CRAWL_MAX_SITEMAP_URLS`), and `TE_CRAWL_PAGES` representative pages chosen round-robin over
URL kinds (product / article / category / page). Politeness: `TE_CRAWL_PER_DOMAIN_DELAY_S` between
requests to a host, `Crawl-delay` honoured (capped at 10 s), `Retry-After` honoured, robots.txt
respected (`TE_CRAWL_RESPECT_ROBOTS`). Bot protection is never bypassed: a challenge page sets
`blocked = true` and the pipeline continues. Parked pages and redirects to another domain are
recorded. Only counts, short strings and technology names are stored, never page bodies.

In Docker Compose the crawler reaches the internet only through `egress-proxy`, so the same SSRF
policy applies as for the scraping engine.

## DNS / RDAP (`collectors/dns.py`)

- DNS over HTTPS JSON (`TE_DOH_URL`, default `https://dns.google/resolve`; Cloudflare
  `https://cloudflare-dns.com/dns-query` also works): A, AAAA, NS, MX, TXT, CAA for the apex and
  CNAME/A for `www`. Works through the HTTP proxy, no key. Google documents 1500 QPS per client IP.
- Infrastructure classification: public IP range feeds (Cloudflare `ips-v4/v6`, AWS
  `ip-ranges.json`, Google Cloud `cloud.json`, Fastly `public-ip-list`; cached 7 days) plus
  nameserver / CNAME / MX / fixed-IP patterns (Vercel, Netlify, GitHub Pages, Shopify,
  Squarespace, Wix, Akamai, Azure, parking providers ...).
- RDAP: IANA bootstrap `https://data.iana.org/rdap/dns.json` (cached 7 days) → registry server
  → `GET {base}/domain/{domain}`. Overrides for registries missing from the bootstrap (.de .ch .io
  .ai .us). ccTLDs without RDAP (.jp .ru .cn .eu .it .es .se .co .me ...) report
  `rdap.status = unsupported_tld`. `.de` returns no registration date. The `rdap.org` redirector is
  not used (10 requests / 10 s). Registries publish no numeric limits but forbid high-volume
  automation; we run ≤1 request/second per worker with caching (`cache_hours`) and back-off on 429.

## Round-2 sources (verified, not yet implemented)

- **Wayback Machine**: CDX `https://web.archive.org/cdx/search/cdx?url=…&matchType=domain&showNumPages=true`
  gives a cheap capture-count proxy; `https://web.archive.org/__wb/sparkline?url=…&collection=web&output=json`
  (undocumented) gives first/last capture and a monthly series in one request. 429s with
  `Retry-After`; no key tier; keep ≤0.5–1 request/second.
- **CrUX API**: `POST https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=…`
  (free key, 150 queries/minute, no billing). Returns Core Web Vitals and form-factor fractions, no
  volume. `CHROME_UX_REPORT_DATA_NOT_FOUND` (404) for origins below the threshold is itself a signal.
- **HTTP Archive**: BigQuery only (`httparchive.crawl.pages`, partitioned by `date`, clustered by
  `client, is_root_page, rank, page`; ~30 TB/month, so query only light columns for root pages
  ≈ 1–5 GB/month). The Technology Report API (`https://cdn.httparchive.org/v1/...`) is per-technology
  aggregates only, no per-origin data.
- **Cisco Umbrella top 1M** (`https://s3-us-west-1.amazonaws.com/umbrella-static/top-1m.csv.zip`):
  still published daily; DNS-query based (includes infrastructure hosts). Easy to add as a list provider.
- **Cloudflare Radar rankings**: free token, but data is CC BY-NC 4.0 — not used.

## Explicitly not used

Similarweb, Ahrefs, Semrush, SpyFu, Moz, DataForSEO, commercial proxies, commercial traffic APIs,
and any paid cloud query service. The rdap.org redirector and the Tranco per-domain API are free
but unsuitable at scale and are not used either.
