# Traffic estimator

`apps/traffic-estimator` estimates a domain's monthly website traffic from free, public signals.
The numbers are **estimates inferred from popularity lists, link graphs, our own crawl and DNS
data, not measured traffic**. Every estimate carries a range, a traffic bucket, a confidence score
and the model version; until a model is trained on legitimate ground truth the model is the clearly
labelled `heuristic_v2` (hand-set priors; `heuristic_v1` stays available for comparison).

- Data sources, their access mechanisms and limits: [data-sources.md](data-sources.md)
- Feature definitions: [features.md](features.md)
- Estimation, confidence and known accuracy limitations: [estimation.md](estimation.md)

## Architecture

```
POST /domains            traffic-api (FastAPI :4200, loopback)
      │                        │
      ▼                        ▼
   domains ──► pipeline_runs ──► tasks (Postgres queue, FOR UPDATE SKIP LOCKED)
                                   │
              ┌────────────────────┼─────────────────────┐
              ▼                    ▼                     ▼
       traffic-worker        traffic-worker         traffic-worker      (scale: --scale traffic-worker=N)
        lists │ commoncrawl │ crawl │ dns │ finalize │ list_refresh
              │                                      ▲
              ▼                                      │ enqueues list refreshes, recovers lost tasks
       raw_observations (append-only)         traffic-scheduler (one instance)
              │
              ▼  finalize: latest observation per source
       domain_features (feature_version) ──► estimates (model_version)
```

| Component | Path | Role |
|---|---|---|
| API | `src/traffic_estimator/api/` | ingestion, job status, features, estimates. No auth: internal service, published on 127.0.0.1:4200 only |
| Pipeline | `pipeline.py` | run creation, collector task execution + caching, finalize (features → estimate) |
| Queue | `queue.py` | Postgres task queue: idempotent enqueue (dedupe key), global per-kind concurrency caps, retries with exponential back-off, lease recovery |
| Worker | `worker.py` | claims tasks, bounded concurrency, heartbeats, deferral, graceful stop |
| Scheduler | `scheduler.py` | periodic list refreshes, lost-task recovery, stale-run finalize |
| Collectors | `collectors/` | `lists`, `commoncrawl`, `crawl`, `dns` (contract in `collectors/base.py`) |
| Ranked lists | `lists/` | providers (Tranco, Majestic, Open PageRank, CrUX top, CC web graph) + loader (COPY, or the web graph's on-disk index in `webgraph_index.py`) + lookup |
| Features | `features/` | `schema.py` (FeatureVector v2), `extract.py` (observations → features), `normalize.py` (log transforms) |
| Estimators | `estimator/` | `heuristic.py` (`heuristic_v2`, config in `config/heuristic_v2.yaml`; `TE_MODEL_VERSION=heuristic_v1` selects the previous one), `confidence.py`, `buckets.py` |
| Training | `training/dataset.py` | ground-truth import/export (JSON Lines) |
| HTTP | `http.py`, `ratelimit.py` | one proxy-aware httpx client, size caps, Retry-After, per-service token buckets, per-host politeness |

### Why a Postgres queue and not Celery/Redis

The pipeline needs idempotent enqueueing, a *global* cap on concurrent tasks per source (at most one
Common Crawl index query in flight across all workers), retries, lost-task recovery and SQL-level
observability. All of that is one table with `FOR UPDATE SKIP LOCKED` plus an advisory lock around
the claim, and Postgres is already here. Workers are stateless and horizontally scalable (the claim
lock serialises claims, which is fine because tasks take seconds). The queue sits behind
`queue.py`; a Redis-backed implementation can replace it without touching collectors.

### Request flow

1. `POST /domains` normalises the input (lower-case, scheme/path stripped, `www` folded,
   public-suffix-aware registrable domain, IDNA), upserts `domains`, and unless an active run exists
   or a completed run is younger than `TE_REPROCESS_AFTER_HOURS` (`force: true` overrides), inserts a
   `pipeline_runs` row and one task per enabled collector (`dedupe_key = run:<id>:<collector>`).
2. Workers claim tasks. A collector task first checks the cache (an observation for every source of
   the collector younger than `cache_hours` → skipped), then runs the collector, appends
   `raw_observations`, and writes a `collection_runs` row (source, status, duration, HTTP status,
   records, error, worker).
3. A collector may return `defer` (re-queue later without using an attempt: lists still loading), `failed` (retry with back-off unless `retryable=False`) or `skipped`.
4. When every collector task of a run is terminal, `finalize` is enqueued (idempotent). It takes the
   latest observation per source (from any run, so cached data is reused), extracts the feature
   vector, normalises it, runs the estimator, stores `domain_features` + `estimates`, and completes
   the run. A failed source lowers coverage/confidence; it never blocks the estimate.

## Database schema (`migrations/001_init.sql`)

| Table | Purpose |
|---|---|
| `domains` | one row per normalised domain |
| `pipeline_runs` | one pipeline pass per domain (the API's job) |
| `tasks` | work queue; `dedupe_key` unique; `status`, `attempts`, `run_after`, `lease_until` |
| `collection_runs` | observability log, one row per collection attempt |
| `raw_observations` | append-only raw payload per (domain, source), with `source_version` |
| `ranked_lists`, `ranked_list_entries` | bulk list versions and their rows (`active` version per provider); the web graph's rows live in the index file named by `file_path` |
| `domain_features` | derived features per run: `features` (raw scale), `normalized` (model inputs), `sources` (provenance) |
| `estimates` | estimate per run: visits, bounds, bucket, confidence, `details` (per-signal breakdown) |
| `training_examples` | ground truth paired with a feature snapshot |
| `kv_cache` | small shared cache (collinfo, RDAP bootstrap, IP feeds, CDX cooldown) |

Raw observations are never rewritten when feature logic changes; bump `FEATURE_VERSION` /
`model_version` and re-estimate (`POST /domains/{domain}/reestimate`).

## Running

`docker compose up -d --build` starts `traffic-db`, `traffic-api` (http://localhost:4200, Swagger at
`/docs`), `traffic-worker` and `traffic-scheduler` with the rest of the stack. Workers reach the
internet only through `egress-proxy`. The scheduler immediately queues the ranked-list downloads
(~2.7 GB on first start, see `TE_LIST_PROVIDERS` in `.env.example` to trim); domain jobs wait for the
lists (deferred `lists` tasks), everything else runs right away.

```bash
curl -s -X POST localhost:4200/domains -H 'content-type: application/json' -d '{"domain":"example.com"}'
curl -s localhost:4200/jobs/1
curl -s localhost:4200/domains/example.com/estimate?details=true
curl -s localhost:4200/domains/example.com/features
curl -s localhost:4200/stats
```

Host-side development (Postgres from compose, direct internet):

```bash
docker compose up -d traffic-db
cd apps/traffic-estimator && uv sync
export TE_DATABASE_URL=postgresql+psycopg://traffic:traffic@localhost:5434/traffic
uv run python -m traffic_estimator api       # :4200
uv run python -m traffic_estimator worker
uv run python -m traffic_estimator scheduler
uv run python -m traffic_estimator lists refresh tranco   # load one list now
uv run python -m traffic_estimator enqueue example.com    # submit from the CLI
uv run pytest                                             # 68 tests; DB tests use traffic_test
```

### API

| Endpoint | Purpose |
|---|---|
| `POST /domains` `{"domain", "force"?, "collectors"?}` | submit one domain → `202 {job_id, status: queued|existing|recent}` |
| `POST /domains/bulk` / `POST /jobs` `{"domains": [...]}` | submit up to `TE_BULK_MAX_DOMAINS` (10k) → per-domain status, invalid inputs reported, duplicates collapsed |
| `GET /jobs/{job_id}` | run status, per-task status/attempts/errors, estimate when completed |
| `GET /domains/{domain}` | domain, latest job, latest estimate, collection log (Phase 20 observability) |
| `GET /domains/{domain}/features` | latest feature vector (raw + normalized + sources) |
| `GET /domains/{domain}/estimate?details=true` | latest estimate; `details` adds the per-signal breakdown and notes |
| `POST /domains/{domain}/reestimate` | recompute features + estimate from stored observations |
| `GET /stats`, `GET /healthz` | queue/run counters, loaded lists; liveness |

### Configuration

All knobs are `TE_*` environment variables (`settings.py`); the important ones are documented in
`.env.example`. Per-source rate limits: `TE_SOURCE_RATE_PER_S` (per worker process) and global
concurrency caps `TE_SOURCE_CONCURRENCY` (enforced in the claim query across all workers).

## Adding a collector

1. Create `collectors/<name>.py` with a class exposing `name`, `sources` (the `raw_observations.source`
   values it writes), `cache_hours`, and `async collect(ctx) -> CollectorResult` (`ok`, `failed`,
   `skipped`, `defer`). Use `http.fetch(url, limiter_key=<service>)` for outbound requests so proxying,
   size caps, Retry-After and rate limiting apply.
2. Register it in `collectors/__init__.py` (`ALL_COLLECTORS`) and add it to `TE_ENABLED_COLLECTORS`;
   optionally add a concurrency cap / rate in settings.
3. Map its payload to features in `features/extract.py` (+ fields in `features/schema.py`,
   transforms in `features/normalize.py`), bump `FEATURE_VERSION` if existing fields change.
4. Give it a weight in `config/heuristic_v2.yaml` (`signals` and `confidence.source_weights`).
5. Add tests (parser unit tests with fixtures; the pipeline tests use a fake collector).

A bulk list is even simpler: implement a `ListProvider` in `lists/providers.py` (`resolve()` →
version + URL, `parse(stream)` → entries) and add it to `build_providers()`.

## Training a model

There is no ground truth yet, so no model is trained and nothing pretends to be accurate.
The infrastructure that exists:

- `training_examples` schema: `domain, feature_snapshot, feature_version, actual_monthly_visits,
  source, measurement_date, period_start, period_end`.
- `python -m traffic_estimator training import rows.jsonl` pairs measured visits (GA4 exports of
  sites you own or whose owners provided them, server logs, …) with the latest feature snapshot;
  `training export out.jsonl` dumps the dataset.
- Normalised features (`features/normalize.py`) are the model inputs; `estimator/base.py` is the
  interface a trained model implements (`estimate(fv, normalized) -> Estimate`), selected by
  `TE_MODEL_VERSION`. The `ml` optional dependency group pins scikit-learn / LightGBM for the
  training script (planned: bucket classifier first, then log-visits regression, evaluated with
  grouped cross-validation by domain and calibrated ranges).

Do not import third-party estimates (Similarweb etc.) as labels; they are estimates themselves.

## Benchmarking against a reference dataset

Third-party numbers can still be used to *compare* (`evaluation/benchmark.py`): a CSV with a
domain column and a monthly visits column (defaults `Domain` / `Monthly Visits`, falling back to
`Website`). Reference values of 0 are treated as "no data" (`--keep-zero` to override); domains
are normalised like API input; duplicate rows keep the first value.

```bash
cd apps/traffic-estimator
uv run python -m traffic_estimator benchmark submit ../../reference.csv --collectors lists,crawl,dns
uv run python -m traffic_estimator benchmark wait   ../../reference.csv
uv run python -m traffic_estimator benchmark report ../../reference.csv --name similarweb \
  --keep-col Country --out ../../output/benchmark-similarweb
# Try another heuristic config without re-collecting anything (nothing is written to the DB):
uv run python -m traffic_estimator benchmark report ../../reference.csv --config config/my_variant.yaml
```

`submit` creates normal pipeline runs (the queue workers do the work, so pass the same collectors
the workers have enabled). `report` recomputes every estimate from the stored raw observations with
the given heuristic config and writes `report.md` (agreement metrics: log10 error bias/MAE, share
within ×2/×3.2/×10, bucket confusion, Spearman, reference-in-range, per-confidence, per-bucket and
per-signal breakdowns, largest disagreements), `rows.csv` (one row per domain) and `metrics.json`.
Agreement with a third-party estimate is not accuracy; results of the first run are in
[estimation.md](estimation.md#benchmark-against-similarweb-2026-10-01).

## Scaling

- Workers share nothing but Postgres: `docker compose up -d --scale traffic-worker=8`. Each runs
  `TE_WORKER_CONCURRENCY` tasks; per-source rates are per process, per-kind concurrency caps are global.
- Bulk lists cost zero requests per domain (local lookup, including the web graph index), so a
  single new domain is estimated as soon as its crawl and DNS finish (~30 s).
- Per-domain costs: crawl ~20–40 requests (politeness delay 1 s/host, parallel across hosts), DNS ~8
  DoH requests, RDAP 1 request (registry limits dominate: expect ~1–2 rps per registry).
- `commoncrawl` (CDX index API) is off by default: on 2026-10-01 it answered 504 to the first try for
  every test domain and held each estimate back by 2–5 minutes, while lists, crawl and DNS took
  ≤ 21 s. Enable it only for small batches that need page counts; it has a circuit breaker
  (15-minute cooldown after 3 consecutive 5xx) so a throttled index never stalls the queue.
- Throughput is bounded by the global crawl cap (`TE_SOURCE_CONCURRENCY`, crawl 16) and politeness,
  not CPU: the 761-domain benchmark (3 workers × 8 tasks, crawl budget 15 pages) crawled ~32
  sites/minute (~1.9k domains/hour) and finished 22 minutes after the lists were loaded. Raise the
  crawl cap together with the worker count for more; 1M domains at that rate ≈ 3 weeks.
- Disk: lists volume ~3 GB at rest (web graph index 2.67 GB), ~8 GB while the quarterly web graph
  index is rebuilt. Each worker maps the index read-only; the OS page cache is shared.
- Postgres: `ranked_list_entries` holds ~16M rows with the default providers; raw observations
  are ~5–20 KB per domain. Partition `raw_observations` by month when it passes tens of millions of rows.

## Observability

`collection_runs` records every attempt (`GET /domains/{domain}` shows the log). Worker logs are
JSON lines. `GET /stats` exposes queue counts per kind/status and the active list versions.
Useful queries: failed sources in the last hour (`SELECT source, count(*) FROM collection_runs
WHERE status='failed' AND started_at > now() - interval '1 hour' GROUP BY 1`), p95 duration per
source, deferred tasks (`tasks.error LIKE 'waiting%'`).

## Known limitations

- Accuracy is unvalidated: `heuristic_v2` maps rank/link signals to visits through hand-set curves.
  Expect order-of-magnitude ranges; buckets are more trustworthy than point estimates.
- Tranco's inputs include Cloudflare Radar data (CC BY-NC); review licensing before commercial use.
- Common Crawl's CDX API is not usable at scale; the web graph covers link popularity but not
  page counts. Per-domain page counts at scale need the offline columnar-index aggregation.
- Subdomain-heavy properties (blog.example.com vs shop.example.com) are folded into the registrable
  domain; CrUX buckets are taken as the best origin of the domain.
- Sites behind bot protection yield no crawl signals (recorded as `blocked`), lowering confidence.
- RDAP is missing for many ccTLDs; `.de` has no registration date.
