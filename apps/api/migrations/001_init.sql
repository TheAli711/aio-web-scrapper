-- 001_init: users, sessions, projects, api_keys, jobs, results, job_events
-- Every user-owned row carries user_id so ownership checks are a single indexed predicate.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_len CHECK (char_length(email) BETWEEN 3 AND 320)
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

-- Dashboard sessions. Only a SHA-256 of the session token is stored.
CREATE TABLE sessions (
  id           text PRIMARY KEY,               -- sha256(token), hex
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text,
  ip           text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_name_len CHECK (char_length(name) BETWEEN 1 AND 120),
  -- Lets child tables enforce (project_id, user_id) consistency with a composite FK.
  CONSTRAINT projects_id_user_uq UNIQUE (id, user_id)
);
CREATE INDEX projects_user_created_idx ON projects (user_id, created_at DESC);

-- API keys. Raw secret is shown once; we keep a lookup prefix and a SHA-256 of the full key.
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  prefix       text NOT NULL,                  -- public, non-secret identifier (e.g. wsk_ab12cd34)
  key_hash     text NOT NULL,                  -- sha256(full key), hex
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  CONSTRAINT api_keys_name_len CHECK (char_length(name) BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX api_keys_prefix_uq ON api_keys (prefix);
CREATE INDEX api_keys_user_idx ON api_keys (user_id, created_at DESC);

CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL,
  user_id          uuid NOT NULL,
  type             text NOT NULL CHECK (type IN ('scrape', 'crawl')),
  target_url       text NOT NULL,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  options          jsonb NOT NULL DEFAULT '{}'::jsonb,
  source           text NOT NULL DEFAULT 'dashboard' CHECK (source IN ('dashboard', 'api')),
  api_key_id       uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  engine           text NOT NULL DEFAULT 'firecrawl',
  engine_job_id    text,
  pages_discovered integer NOT NULL DEFAULT 0,
  pages_processed  integer NOT NULL DEFAULT 0,
  pages_succeeded  integer NOT NULL DEFAULT 0,
  pages_failed     integer NOT NULL DEFAULT 0,
  error_code       text,
  error_message    text,
  -- Reconciler bookkeeping (not a work queue: Firecrawl owns execution).
  sync_cursor      integer NOT NULL DEFAULT 0,
  lease_until      timestamptz,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, user_id) REFERENCES projects (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX jobs_user_created_idx ON jobs (user_id, created_at DESC);
CREATE INDEX jobs_project_created_idx ON jobs (project_id, created_at DESC);
CREATE INDEX jobs_active_idx ON jobs (status, updated_at) WHERE status IN ('queued', 'running');

-- One row per fetched page. Large bodies (markdown/html/text/links) live in object storage.
CREATE TABLE results (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  project_id     uuid NOT NULL,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url            text NOT NULL,
  title          text,
  status_code    integer,
  success        boolean NOT NULL,
  error_code     text,
  error_message  text,
  content_type   text,
  formats        text[] NOT NULL DEFAULT '{}',
  storage_key    text,                          -- object-storage key of the content blob
  content_bytes  integer NOT NULL DEFAULT 0,
  truncated      boolean NOT NULL DEFAULT false,
  links_count    integer NOT NULL DEFAULT 0,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- small, bounded page metadata
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, user_id) REFERENCES projects (id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX results_job_url_uq ON results (job_id, url);
CREATE INDEX results_job_created_idx ON results (job_id, created_at);
CREATE INDEX results_user_created_idx ON results (user_id, created_at DESC);
CREATE INDEX results_project_created_idx ON results (project_id, created_at DESC);

-- Append-only job timeline: answers "what happened?" per job.
CREATE TABLE job_events (
  id         bigserial PRIMARY KEY,
  job_id     uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  level      text NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  event      text NOT NULL,
  message    text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_events_job_idx ON job_events (job_id, id);
