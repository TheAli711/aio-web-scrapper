/**
 * Types mirroring the JSON shapes returned by apps/api (see apps/api/src/http/present.ts and schemas.ts).
 * All timestamps are ISO-8601 strings.
 */

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type JobType = "scrape" | "crawl";
/** "branding" is scrape-only; the API rejects it for crawl jobs. */
export type OutputFormat = "markdown" | "html" | "text" | "branding";
/** Branding is only available inside the full JSON download. */
export type DownloadFormat = Exclude<OutputFormat, "branding"> | "json";

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

export type Confidence = "high" | "medium" | "low";

export interface BrandingLogo {
  /** http(s) URL, or a data:image/svg+xml URI for inline SVG logos. */
  url: string | null;
  /** PNG data URI of the logo as rendered on the page. */
  image: string | null;
  /** dom-img | dom-svg | dom-background | json-ld | icon */
  source: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  /** dark = logo meant for light backgrounds; light = meant for dark backgrounds. */
  tone: "dark" | "light" | "color" | null;
  colors: string[];
  confidence: Confidence;
}

export interface BrandingFavicon {
  url: string;
  sizes: string | null;
  type: string | null;
  source: string;
}

export interface BrandingIcon {
  url: string;
  rel: string;
  sizes: string | null;
  type: string | null;
}

export interface BrandingColors {
  /** All colours are "#RRGGBB". */
  primary: string | null;
  secondary: string | null;
  accent: string | null;
  background: string | null;
  text: string | null;
  palette: Array<{ hex: string; weight: number; sources: string[] }>;
  basis: string;
  confidence: Confidence;
}

export interface Branding {
  final_url: string | null;
  site_name: string | null;
  logo: BrandingLogo | null;
  favicon: BrandingFavicon | null;
  icons: BrandingIcon[];
  colors: BrandingColors;
  fonts: { heading: string | null; body: string | null };
  theme_color: string | null;
  og_image: string | null;
}

export interface ResultContent {
  markdown?: string;
  html?: string;
  text?: string;
  links?: string[];
  /** Present when the "branding" format was requested; null when extraction failed. */
  branding?: Branding | null;
  branding_error?: ErrorInfo | null;
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
