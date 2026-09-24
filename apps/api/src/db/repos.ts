/**
 * Data access. Every read of a user-owned resource takes the owner's user_id and filters on it,
 * so cross-tenant access is impossible by construction (a foreign id simply yields "not found").
 */
import type { Db, DbClient } from "./pool.js";
import type {
  ApiKey,
  Job,
  JobOptions,
  JobStatus,
  JobType,
  Project,
  ResultRow,
  User,
} from "../domain.js";
import type { ErrorCode } from "../lib/errors.js";

// ---------------------------------------------------------------------------- users & sessions

export const users = {
  async create(db: DbClient, email: string, passwordHash: string, name: string | null): Promise<User> {
    const { rows } = await db.query<User>(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)
       RETURNING id, email, name, created_at`,
      [email, passwordHash, name],
    );
    return rows[0]!;
  },

  async findByEmail(db: DbClient, email: string): Promise<(User & { password_hash: string }) | null> {
    const { rows } = await db.query<User & { password_hash: string }>(
      `SELECT id, email, name, created_at, password_hash FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ?? null;
  },

  async findById(db: DbClient, id: string): Promise<User | null> {
    const { rows } = await db.query<User>(`SELECT id, email, name, created_at FROM users WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },
};

export const sessions = {
  async create(
    db: DbClient,
    idHash: string,
    userId: string,
    ttlHours: number,
    userAgent: string | null,
    ip: string | null,
  ): Promise<void> {
    await db.query(
      `INSERT INTO sessions (id, user_id, expires_at, user_agent, ip)
       VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
      [idHash, userId, ttlHours, userAgent?.slice(0, 300) ?? null, ip],
    );
  },

  async findValid(db: DbClient, idHash: string): Promise<{ user_id: string; email: string } | null> {
    const { rows } = await db.query<{ user_id: string; email: string }>(
      `UPDATE sessions s SET last_seen_at = now()
       FROM users u
       WHERE s.id = $1 AND s.expires_at > now() AND u.id = s.user_id
       RETURNING s.user_id, u.email`,
      [idHash],
    );
    return rows[0] ?? null;
  },

  async delete(db: DbClient, idHash: string): Promise<void> {
    await db.query(`DELETE FROM sessions WHERE id = $1`, [idHash]);
  },

  async purgeExpired(db: DbClient): Promise<number> {
    const r = await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
    return r.rowCount ?? 0;
  },
};

// ---------------------------------------------------------------------------- projects

export const projects = {
  async create(db: DbClient, userId: string, name: string, description: string | null): Promise<Project> {
    const { rows } = await db.query<Project>(
      `INSERT INTO projects (user_id, name, description) VALUES ($1, $2, $3) RETURNING *`,
      [userId, name, description],
    );
    return rows[0]!;
  },

  async list(db: DbClient, userId: string): Promise<Array<Project & { job_count: number; last_job_at: Date | null }>> {
    const { rows } = await db.query(
      `SELECT p.*, COALESCE(j.cnt, 0)::int AS job_count, j.last_job_at
       FROM projects p
       LEFT JOIN (SELECT project_id, count(*) AS cnt, max(created_at) AS last_job_at
                  FROM jobs WHERE user_id = $1 GROUP BY project_id) j ON j.project_id = p.id
       WHERE p.user_id = $1
       ORDER BY p.created_at DESC`,
      [userId],
    );
    return rows;
  },

  async get(db: DbClient, userId: string, id: string): Promise<Project | null> {
    const { rows } = await db.query<Project>(`SELECT * FROM projects WHERE id = $1 AND user_id = $2`, [id, userId]);
    return rows[0] ?? null;
  },

  /** The user's oldest project; creates "Default project" if the user has none. */
  async getOrCreateDefault(db: DbClient, userId: string): Promise<Project> {
    const { rows } = await db.query<Project>(
      `SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at, id LIMIT 1`,
      [userId],
    );
    return rows[0] ?? (await projects.create(db, userId, "Default project", "Created automatically"));
  },

  async update(
    db: DbClient,
    userId: string,
    id: string,
    patch: { name?: string; description?: string | null },
  ): Promise<Project | null> {
    const { rows } = await db.query<Project>(
      `UPDATE projects SET
         name = COALESCE($3, name),
         description = CASE WHEN $4::boolean THEN $5 ELSE description END,
         updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId, patch.name ?? null, patch.description !== undefined, patch.description ?? null],
    );
    return rows[0] ?? null;
  },

  async delete(db: DbClient, userId: string, id: string): Promise<boolean> {
    const r = await db.query(`DELETE FROM projects WHERE id = $1 AND user_id = $2`, [id, userId]);
    return (r.rowCount ?? 0) > 0;
  },
};

// ---------------------------------------------------------------------------- api keys

export const apiKeys = {
  async create(db: DbClient, userId: string, name: string, prefix: string, hash: string): Promise<ApiKey> {
    const { rows } = await db.query<ApiKey>(
      `INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, name, prefix, created_at, last_used_at, revoked_at`,
      [userId, name, prefix, hash],
    );
    return rows[0]!;
  },

  async list(db: DbClient, userId: string): Promise<ApiKey[]> {
    const { rows } = await db.query<ApiKey>(
      `SELECT id, user_id, name, prefix, created_at, last_used_at, revoked_at
       FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return rows;
  },

  async findActiveByPrefix(
    db: DbClient,
    prefix: string,
  ): Promise<{ id: string; user_id: string; key_hash: string; email: string } | null> {
    const { rows } = await db.query(
      `SELECT k.id, k.user_id, k.key_hash, u.email
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.prefix = $1 AND k.revoked_at IS NULL`,
      [prefix],
    );
    return rows[0] ?? null;
  },

  async touch(db: DbClient, id: string): Promise<void> {
    // Coarse-grained to avoid a write per request.
    await db.query(
      `UPDATE api_keys SET last_used_at = now()
       WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [id],
    );
  },

  async revoke(db: DbClient, userId: string, id: string): Promise<boolean> {
    const r = await db.query(
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [id, userId],
    );
    return (r.rowCount ?? 0) > 0;
  },
};

// ---------------------------------------------------------------------------- jobs

export interface JobListFilter {
  projectId?: string;
  status?: JobStatus;
  type?: JobType;
  limit: number;
  before?: Date;
}

export const jobs = {
  async create(
    db: DbClient,
    input: {
      userId: string;
      projectId: string;
      type: JobType;
      targetUrl: string;
      options: JobOptions;
      source: "dashboard" | "api";
      apiKeyId: string | null;
      engine: string;
    },
  ): Promise<Job> {
    const { rows } = await db.query<Job>(
      `INSERT INTO jobs (user_id, project_id, type, target_url, options, source, api_key_id, engine)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        input.userId,
        input.projectId,
        input.type,
        input.targetUrl,
        JSON.stringify(input.options),
        input.source,
        input.apiKeyId,
        input.engine,
      ],
    );
    return rows[0]!;
  },

  async get(db: DbClient, userId: string, id: string): Promise<Job | null> {
    const { rows } = await db.query<Job>(`SELECT * FROM jobs WHERE id = $1 AND user_id = $2`, [id, userId]);
    return rows[0] ?? null;
  },

  /** Internal (reconciler) lookup without owner scoping. Never exposed via routes. */
  async getInternal(db: DbClient, id: string): Promise<Job | null> {
    const { rows } = await db.query<Job>(`SELECT * FROM jobs WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },

  async list(db: DbClient, userId: string, f: JobListFilter): Promise<Job[]> {
    const { rows } = await db.query<Job>(
      `SELECT * FROM jobs
       WHERE user_id = $1
         AND ($2::uuid IS NULL OR project_id = $2)
         AND ($3::text IS NULL OR status = $3)
         AND ($4::text IS NULL OR type = $4)
         AND ($5::timestamptz IS NULL OR created_at < $5)
       ORDER BY created_at DESC
       LIMIT $6`,
      [userId, f.projectId ?? null, f.status ?? null, f.type ?? null, f.before ?? null, f.limit],
    );
    return rows;
  },

  async countActive(db: DbClient, userId: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs WHERE user_id = $1 AND status IN ('queued', 'running')`,
      [userId],
    );
    return rows[0]!.n;
  },

  async stats(db: DbClient, userId: string) {
    const { rows } = await db.query<{ status: JobStatus; n: number }>(
      `SELECT status, count(*)::int AS n FROM jobs WHERE user_id = $1 GROUP BY status`,
      [userId],
    );
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<JobStatus, number>>;
    return by;
  },

  /** Atomic queued -> running transition. Returns null if someone else already claimed it. */
  async claim(db: DbClient, id: string): Promise<Job | null> {
    const { rows } = await db.query<Job>(
      `UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now(),
              lease_until = now() + interval '30 seconds'
       WHERE id = $1 AND status = 'queued' RETURNING *`,
      [id],
    );
    return rows[0] ?? null;
  },

  async setEngineJobId(db: DbClient, id: string, engineJobId: string): Promise<void> {
    await db.query(`UPDATE jobs SET engine_job_id = $2, updated_at = now() WHERE id = $1`, [id, engineJobId]);
  },

  async updateProgress(
    db: DbClient,
    id: string,
    p: { discovered: number; processed: number; succeeded: number; failed: number; cursor: number },
  ): Promise<void> {
    await db.query(
      `UPDATE jobs SET pages_discovered = GREATEST(pages_discovered, $2),
                       pages_processed = GREATEST(pages_processed, $3),
                       pages_succeeded = $4, pages_failed = $5, sync_cursor = $6, updated_at = now()
       WHERE id = $1 AND status = 'running'`,
      [id, p.discovered, p.processed, p.succeeded, p.failed, p.cursor],
    );
  },

  /** Move a non-terminal job to a terminal state. Returns the updated job, or null if already terminal. */
  async finish(
    db: DbClient,
    id: string,
    status: "completed" | "failed" | "cancelled",
    error?: { code: ErrorCode; message: string } | null,
  ): Promise<Job | null> {
    const { rows } = await db.query<Job>(
      `UPDATE jobs SET status = $2, error_code = $3, error_message = $4,
              completed_at = now(), updated_at = now(), lease_until = NULL
       WHERE id = $1 AND status IN ('queued', 'running') RETURNING *`,
      [id, status, error?.code ?? null, error?.message ?? null],
    );
    return rows[0] ?? null;
  },

  /** Lease running crawls (and orphaned queued jobs) for reconciliation, skipping ones held elsewhere. */
  async leaseForSync(db: DbClient, limit: number, leaseSeconds: number): Promise<Job[]> {
    const { rows } = await db.query<Job>(
      `UPDATE jobs SET lease_until = now() + make_interval(secs => $2)
       WHERE id IN (
         SELECT id FROM jobs
         WHERE status IN ('queued', 'running')
           AND (lease_until IS NULL OR lease_until < now())
         ORDER BY updated_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [limit, leaseSeconds],
    );
    return rows;
  },

  async releaseLease(db: DbClient, id: string): Promise<void> {
    await db.query(`UPDATE jobs SET lease_until = NULL WHERE id = $1`, [id]);
  },
};

// ---------------------------------------------------------------------------- results

export interface NewResult {
  jobId: string;
  projectId: string;
  userId: string;
  url: string;
  title: string | null;
  statusCode: number | null;
  success: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  contentType: string | null;
  formats: string[];
  storageKey: string | null;
  contentBytes: number;
  truncated: boolean;
  linksCount: number;
  metadata: Record<string, unknown>;
}

export const results = {
  /** Insert; on duplicate (job_id, url) keep the first. Returns the row id or null if it already existed. */
  async insert(db: DbClient, r: NewResult & { id: string }): Promise<string | null> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO results (id, job_id, project_id, user_id, url, title, status_code, success, error_code,
                            error_message, content_type, formats, storage_key, content_bytes, truncated,
                            links_count, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (job_id, url) DO NOTHING RETURNING id`,
      [
        r.id,
        r.jobId,
        r.projectId,
        r.userId,
        r.url,
        r.title,
        r.statusCode,
        r.success,
        r.errorCode,
        r.errorMessage,
        r.contentType,
        r.formats,
        r.storageKey,
        r.contentBytes,
        r.truncated,
        r.linksCount,
        JSON.stringify(r.metadata),
      ],
    );
    return rows[0]?.id ?? null;
  },

  async countsForJob(db: DbClient, jobId: string): Promise<{ succeeded: number; failed: number }> {
    const { rows } = await db.query<{ succeeded: number; failed: number }>(
      `SELECT count(*) FILTER (WHERE success)::int AS succeeded, count(*) FILTER (WHERE NOT success)::int AS failed
       FROM results WHERE job_id = $1`,
      [jobId],
    );
    return rows[0]!;
  },

  async listForJob(
    db: DbClient,
    userId: string,
    jobId: string,
    opts: { limit: number; offset: number; success?: boolean },
  ): Promise<{ items: ResultRow[]; total: number }> {
    const { rows } = await db.query<ResultRow & { total: number }>(
      `SELECT *, count(*) OVER ()::int AS total FROM results
       WHERE job_id = $1 AND user_id = $2 AND ($3::boolean IS NULL OR success = $3)
       ORDER BY created_at, id
       LIMIT $4 OFFSET $5`,
      [jobId, userId, opts.success ?? null, opts.limit, opts.offset],
    );
    return { items: rows, total: rows[0]?.total ?? 0 };
  },

  async list(
    db: DbClient,
    userId: string,
    opts: { projectId?: string; limit: number; before?: Date },
  ): Promise<Array<ResultRow & { job_type: JobType }>> {
    const { rows } = await db.query(
      `SELECT r.*, j.type AS job_type FROM results r JOIN jobs j ON j.id = r.job_id
       WHERE r.user_id = $1 AND ($2::uuid IS NULL OR r.project_id = $2)
         AND ($3::timestamptz IS NULL OR r.created_at < $3)
       ORDER BY r.created_at DESC LIMIT $4`,
      [userId, opts.projectId ?? null, opts.before ?? null, opts.limit],
    );
    return rows;
  },

  async get(db: DbClient, userId: string, id: string): Promise<ResultRow | null> {
    const { rows } = await db.query<ResultRow>(`SELECT * FROM results WHERE id = $1 AND user_id = $2`, [id, userId]);
    return rows[0] ?? null;
  },
};

// ---------------------------------------------------------------------------- job events

export interface JobEvent {
  id: number;
  job_id: string;
  level: "info" | "warn" | "error";
  event: string;
  message: string | null;
  data: Record<string, unknown>;
  created_at: Date;
}

export const jobEvents = {
  async add(
    db: DbClient,
    jobId: string,
    level: JobEvent["level"],
    event: string,
    message: string | null,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await db.query(`INSERT INTO job_events (job_id, level, event, message, data) VALUES ($1, $2, $3, $4, $5)`, [
      jobId,
      level,
      event,
      message,
      JSON.stringify(data),
    ]);
  },

  async list(db: DbClient, jobId: string): Promise<JobEvent[]> {
    const { rows } = await db.query<JobEvent>(
      `SELECT * FROM job_events WHERE job_id = $1 ORDER BY id LIMIT 500`,
      [jobId],
    );
    return rows;
  },
};

export type { Db };
