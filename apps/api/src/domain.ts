import type { Branding } from "./engine/branding.js";
import type { ErrorCode } from "./lib/errors.js";

export type JobType = "scrape" | "crawl";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(["completed", "failed", "cancelled"]);

export type OutputFormat = "markdown" | "html" | "text" | "branding";
export const OUTPUT_FORMATS: readonly OutputFormat[] = ["markdown", "html", "text", "branding"];

export interface User {
  id: string;
  email: string;
  name: string | null;
  created_at: Date;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export interface ScrapeJobOptions {
  formats: OutputFormat[];
  onlyMainContent: boolean;
  timeoutMs: number;
  waitForMs: number;
}

export interface CrawlJobOptions extends ScrapeJobOptions {
  maxDepth: number;
  maxPages: number;
  includePatterns: string[];
  excludePatterns: string[];
  /** Hostname the crawl is confined to (defaults to the start URL's host). */
  allowedDomain: string;
  allowSubdomains: boolean;
}

export type JobOptions = ScrapeJobOptions | CrawlJobOptions;

export interface Job {
  id: string;
  project_id: string;
  user_id: string;
  type: JobType;
  target_url: string;
  status: JobStatus;
  options: JobOptions;
  source: "dashboard" | "api";
  api_key_id: string | null;
  engine: string;
  engine_job_id: string | null;
  pages_discovered: number;
  pages_processed: number;
  pages_succeeded: number;
  pages_failed: number;
  error_code: ErrorCode | null;
  error_message: string | null;
  sync_cursor: number;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ResultRow {
  id: string;
  job_id: string;
  project_id: string;
  user_id: string;
  url: string;
  title: string | null;
  status_code: number | null;
  success: boolean;
  error_code: string | null;
  error_message: string | null;
  content_type: string | null;
  formats: string[];
  storage_key: string | null;
  content_bytes: number;
  truncated: boolean;
  links_count: number;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/** Blob stored in object storage for each result. */
export interface ResultContent {
  markdown?: string;
  html?: string;
  text?: string;
  links?: string[];
  /** Present when the "branding" format was requested (null when extraction failed). */
  branding?: Branding | null;
  branding_error?: { code: string; message: string } | null;
}

/** Who is making a request: a dashboard session or an API key. */
export interface Principal {
  userId: string;
  email: string;
  via: "session" | "api_key";
  apiKeyId?: string;
  sessionId?: string;
}
