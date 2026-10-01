-- 001_init: domains, pipeline runs, task queue, observability log, raw observations,
-- ranked lists (Tranco & co.), derived features, estimates, training examples, small KV cache.
--
-- Raw observations are append-only and never rewritten when feature logic changes:
-- features/estimates are recomputed from them under a new feature_version/model_version.

CREATE TABLE domains (
  id                bigserial PRIMARY KEY,
  name              text NOT NULL,            -- normalised registrable domain, e.g. example.com
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_run_id       bigint,                   -- most recent pipeline run (any status)
  last_completed_at timestamptz,              -- when a run last produced an estimate
  CONSTRAINT domains_name_uq UNIQUE (name),
  CONSTRAINT domains_name_len CHECK (char_length(name) BETWEEN 3 AND 253)
);

-- One run = one pass of the pipeline for one domain (the "job" the API hands back).
CREATE TABLE pipeline_runs (
  id              bigserial PRIMARY KEY,
  domain_id       bigint NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  collectors      text[] NOT NULL,            -- collectors scheduled for this run
  feature_version text,
  model_version   text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
CREATE INDEX pipeline_runs_domain_idx ON pipeline_runs (domain_id, created_at DESC);
CREATE INDEX pipeline_runs_status_idx ON pipeline_runs (status) WHERE status IN ('queued', 'running');

-- Work queue (Postgres, claimed with FOR UPDATE SKIP LOCKED). dedupe_key makes enqueueing idempotent.
CREATE TABLE tasks (
  id           bigserial PRIMARY KEY,
  run_id       bigint REFERENCES pipeline_runs(id) ON DELETE CASCADE,   -- NULL: maintenance task
  domain_id    bigint REFERENCES domains(id) ON DELETE CASCADE,
  kind         text NOT NULL,                 -- collector name | finalize | <maintenance kind>
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
  priority     integer NOT NULL DEFAULT 0,
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  run_after    timestamptz NOT NULL DEFAULT now(),
  locked_by    text,
  locked_at    timestamptz,
  lease_until  timestamptz,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text,
  dedupe_key   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  CONSTRAINT tasks_dedupe_uq UNIQUE (dedupe_key)
);
CREATE INDEX tasks_claim_idx ON tasks (run_after, priority DESC, id) WHERE status = 'queued';
CREATE INDEX tasks_running_idx ON tasks (kind, lease_until) WHERE status = 'running';
CREATE INDEX tasks_run_idx ON tasks (run_id);

-- Observability: one row per collection attempt (Phase 20).
CREATE TABLE collection_runs (
  id                bigserial PRIMARY KEY,
  task_id           bigint,
  domain_id         bigint REFERENCES domains(id) ON DELETE CASCADE,
  source            text NOT NULL,
  status            text NOT NULL CHECK (status IN ('running', 'success', 'failed', 'skipped')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  duration_ms       integer,
  http_status       integer,
  records_collected integer,
  error             text,
  worker            text
);
CREATE INDEX collection_runs_domain_idx ON collection_runs (domain_id, started_at DESC);
CREATE INDEX collection_runs_source_idx ON collection_runs (source, status, started_at DESC);

-- Append-only raw data per (domain, source). payload shape is owned by the collector.
CREATE TABLE raw_observations (
  id             bigserial PRIMARY KEY,
  domain_id      bigint NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  source         text NOT NULL,
  source_version text,                        -- list id, crawl ids, collector version ...
  run_id         bigint,
  collected_at   timestamptz NOT NULL DEFAULT now(),
  payload        jsonb NOT NULL
);
CREATE INDEX raw_observations_lookup_idx ON raw_observations (domain_id, source, collected_at DESC);

-- Bulk ranked lists (Tranco, Majestic Million, Open PageRank, CrUX top list, Common Crawl web graph).
-- One row per downloaded list version; `active` marks the version lookups use.
CREATE TABLE ranked_lists (
  id            bigserial PRIMARY KEY,
  provider      text NOT NULL,
  list_id       text NOT NULL,                -- provider's list id or the download date
  list_date     date,
  source_url    text,
  row_count     integer,
  file_path     text,                         -- kept on disk when the provider needs re-scans
  active        boolean NOT NULL DEFAULT false,
  downloaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ranked_lists_uq UNIQUE (provider, list_id)
);
CREATE UNIQUE INDEX ranked_lists_active_uq ON ranked_lists (provider) WHERE active;

-- rank NULL = the domain was looked up in the full source file and is absent (negative cache).
CREATE TABLE ranked_list_entries (
  list_id      bigint NOT NULL REFERENCES ranked_lists(id) ON DELETE CASCADE,
  domain       text NOT NULL,
  rank         integer,                       -- provider rank (CrUX: bucket; web graph: harmonic rank)
  score        real,                          -- Open PageRank 0..10 / web graph harmonic centrality
  pr_rank      integer,                       -- web graph PageRank position
  pr_score     double precision,              -- web graph PageRank value
  n_hosts      integer,                       -- web graph: hosts under the domain
  ref_domains  integer,                       -- Open PageRank referring domains
  ref_subnets  integer,                       -- Majestic referring class-C subnets
  ref_ips      integer,                       -- Majestic referring IPs
  PRIMARY KEY (list_id, domain)
);

-- Derived features (versioned). `features` holds the named raw-scale values, `normalized` the
-- model inputs, `sources` which sources contributed and how fresh they were.
CREATE TABLE domain_features (
  id              bigserial PRIMARY KEY,
  domain_id       bigint NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  run_id          bigint,
  feature_version text NOT NULL,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  features        jsonb NOT NULL,
  normalized      jsonb NOT NULL,
  sources         jsonb NOT NULL
);
CREATE INDEX domain_features_domain_idx ON domain_features (domain_id, computed_at DESC);

CREATE TABLE estimates (
  id                       bigserial PRIMARY KEY,
  domain_id                bigint NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  run_id                   bigint,
  feature_id               bigint REFERENCES domain_features(id) ON DELETE SET NULL,
  model_version            text NOT NULL,
  feature_version          text NOT NULL,
  estimated_monthly_visits bigint,
  lower_bound              bigint,
  upper_bound              bigint,
  traffic_bucket           text NOT NULL,
  confidence               text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  confidence_score         real NOT NULL,
  details                  jsonb NOT NULL,   -- score components, evidence, disagreement notes
  generated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX estimates_domain_idx ON estimates (domain_id, generated_at DESC);

-- Ground truth for model training. Only legitimately obtained measurements go here.
CREATE TABLE training_examples (
  id                   bigserial PRIMARY KEY,
  domain               text NOT NULL,
  feature_snapshot     jsonb NOT NULL,
  feature_version      text NOT NULL,
  actual_monthly_visits bigint NOT NULL CHECK (actual_monthly_visits >= 0),
  source               text NOT NULL,        -- e.g. ga4_export, owned_property
  measurement_date     date NOT NULL,
  period_start         date,
  period_end           date,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT training_examples_uq UNIQUE (domain, source, measurement_date)
);

-- Small shared cache (RDAP bootstrap, Common Crawl collinfo, hosting IP feeds ...).
CREATE TABLE kv_cache (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
