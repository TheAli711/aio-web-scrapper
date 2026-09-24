/**
 * Types mirroring the JSON shapes returned by apps/api (see apps/api/src/http/present.ts and schemas.ts).
 * All timestamps are ISO-8601 strings.
 */

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type JobType = "scrape" | "crawl";
export type OutputFormat = "markdown" | "html" | "text";
export type DownloadFormat = OutputFormat | "json";

export const JOB_STATUSES: JobStatus[] = ["queued", "running", "completed", "failed", "cancelled"];
export const ACTIVE_STATUSES: JobStatus[] = ["queued", "running"];

export interface ErrorInfo {
  code: string;
  message: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

export interface ListResponse<T> {
  data: T[];
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  created_at?: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** Present on the list endpoint only. */
  job_count?: number;
  last_job_at?: string | null;
}

export interface JobProgress {
  pages_discovered: number;
  pages_processed: number;
  pages_succeeded: number;
  pages_failed: number;
}

export interface Job {
  id: string;
  project_id: string;
  type: JobType;
  target_url: string;
  status: JobStatus;
  source: "dashboard" | "api";
  options: Record<string, unknown>;
  progress: JobProgress;
  error: ErrorInfo | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  links: { self: string; results: string };
}

export interface JobEvent {
  id: string | number;
  level: "info" | "warn" | "error" | string;
  event: string;
  message: string | null;
  data: unknown;
  created_at: string;
}

export interface ResultSummary {
  id: string;
  job_id: string;
  project_id: string;
  url: string;
  title: string | null;
  status_code: number | null;
  success: boolean;
  error: ErrorInfo | null;
  formats: string[];
  content_bytes: number;
  truncated: boolean;
  links_count: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ResultListItem extends ResultSummary {
  job_type: JobType;
}

export interface ResultContent {
  markdown?: string;
  html?: string;
  text?: string;
  links?: string[];
}

export interface ResultWithContent extends ResultSummary {
  content: ResultContent | null;
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
  next_offset: number | null;
}

export interface JobResultsPage {
  job: Job;
  data: ResultSummary[];
  pagination: Pagination;
}

export interface Stats {
  projects: number;
  jobs: Record<JobStatus, number>;
  recent_jobs: Job[];
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  active: boolean;
}

export interface CreatedApiKey extends ApiKey {
  /** The raw key. Returned exactly once, at creation. */
  key: string;
}

export interface ScrapeRequest {
  url: string;
  project_id: string;
  formats?: OutputFormat[];
  only_main_content?: boolean;
  timeout_ms?: number;
  wait_for_ms?: number;
}

export interface CrawlRequest extends ScrapeRequest {
  max_depth?: number;
  max_pages?: number;
  include_patterns?: string[];
  exclude_patterns?: string[];
  allowed_domain?: string;
  allow_subdomains?: boolean;
}
