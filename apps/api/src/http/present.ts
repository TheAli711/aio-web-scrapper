/** Map DB rows to public JSON shapes. Internal columns (engine ids, leases, cursors) never leave here. */
import type { ApiKey, Job, Project, ResultContent, ResultRow } from "../domain.js";

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Stored options use internal camelCase; the public API is snake_case throughout. */
function snakeKeys(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));
}

export function presentJob(j: Job, basePath = "/api/v1") {
  return {
    id: j.id,
    project_id: j.project_id,
    type: j.type,
    target_url: j.target_url,
    status: j.status,
    source: j.source,
    options: snakeKeys(j.options),
    progress: {
      pages_discovered: j.pages_discovered,
      pages_processed: j.pages_processed,
      pages_succeeded: j.pages_succeeded,
      pages_failed: j.pages_failed,
    },
    error: j.error_code ? { code: j.error_code, message: j.error_message ?? "" } : null,
    created_at: iso(j.created_at)!,
    started_at: iso(j.started_at),
    completed_at: iso(j.completed_at),
    duration_ms:
      j.started_at && j.completed_at ? new Date(j.completed_at).getTime() - new Date(j.started_at).getTime() : null,
    links: { self: `${basePath}/jobs/${j.id}`, results: `${basePath}/jobs/${j.id}/results` },
  };
}

export function presentResult(r: ResultRow) {
  return {
    id: r.id,
    job_id: r.job_id,
    project_id: r.project_id,
    url: r.url,
    title: r.title,
    status_code: r.status_code,
    success: r.success,
    error: r.error_code ? { code: r.error_code, message: r.error_message ?? "" } : null,
    formats: r.formats,
    content_bytes: r.content_bytes,
    truncated: r.truncated,
    links_count: r.links_count,
    metadata: r.metadata,
    created_at: iso(r.created_at)!,
  };
}

export function presentResultWithContent(r: ResultRow, content: ResultContent | null) {
  return { ...presentResult(r), content };
}

export function presentProject(p: Project & { job_count?: number; last_job_at?: Date | null }) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    created_at: iso(p.created_at),
    updated_at: iso(p.updated_at),
    ...(p.job_count !== undefined ? { job_count: p.job_count, last_job_at: iso(p.last_job_at) } : {}),
  };
}

export function presentApiKey(k: ApiKey) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    created_at: iso(k.created_at),
    last_used_at: iso(k.last_used_at),
    revoked_at: iso(k.revoked_at),
    active: !k.revoked_at,
  };
}
