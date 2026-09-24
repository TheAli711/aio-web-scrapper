/**
 * Tiny typed client for the dashboard API. Every call goes to the same origin (/api/...), which the
 * Next.js route handler in app/api/[...path]/route.ts forwards to the Fastify API, so the httpOnly
 * session cookie is sent automatically.
 */
import type {
  ApiErrorBody,
  ApiKey,
  CrawlRequest,
  CreatedApiKey,
  Job,
  JobEvent,
  JobResultsPage,
  ListResponse,
  Project,
  ResultListItem,
  ResultWithContent,
  ScrapeRequest,
  Stats,
  User,
} from "./types";

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /** Field-level problems from VALIDATION_ERROR responses. */
  get issues(): ValidationIssue[] {
    const raw = this.details?.issues;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((i: unknown) => {
      if (typeof i !== "object" || i === null) return [];
      const rec = i as Record<string, unknown>;
      const field = typeof rec.field === "string" ? rec.field : "";
      const path = [typeof rec.path === "string" ? rec.path : "", field].filter(Boolean).join("/");
      return [{ path, message: typeof rec.message === "string" ? rec.message : String(rec.message) }];
    });
  }
}

function isErrorBody(v: unknown): v is ApiErrorBody {
  if (typeof v !== "object" || v === null || !("error" in v)) return false;
  const e = (v as { error: unknown }).error;
  return typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string";
}

type Query = Record<string, string | number | boolean | undefined | null>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

interface RequestOptions {
  signal?: AbortSignal;
  /** Don't bounce to /login on UNAUTHENTICATED (used by the auth pages and the session probe). */
  noAuthRedirect?: boolean;
}

export async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body !== undefined ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach the dashboard server. Check your connection and try again.");
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (!res.ok) {
    if (isErrorBody(parsed)) {
      const e = parsed.error;
      const err = new ApiError(res.status, e.code, e.message, e.details, e.requestId);
      if (err.code === "UNAUTHENTICATED" && !opts.noAuthRedirect) redirectToLogin();
      throw err;
    }
    const snippet = text.trim().slice(0, 200);
    throw new ApiError(
      res.status,
      `HTTP_${res.status}`,
      `Request failed with HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}${snippet ? `: ${snippet}` : ""}`,
    );
  }

  if (parsed === undefined && text) {
    throw new ApiError(res.status, "INVALID_RESPONSE", "The API returned a response that is not valid JSON");
  }
  return parsed as T;
}

export function redirectToLogin() {
  if (typeof window === "undefined") return;
  const here = window.location.pathname + window.location.search;
  if (window.location.pathname === "/login" || window.location.pathname === "/signup") return;
  window.location.assign(`/login?next=${encodeURIComponent(here)}`);
}

export const get = <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, undefined, opts);

/** Endpoints used by the dashboard. */
export const api = {
  signup: (body: { email: string; password: string; name?: string }) =>
    request<{ user: User }>("POST", "/api/auth/signup", body, { noAuthRedirect: true }),
  login: (body: { email: string; password: string }) =>
    request<{ user: User }>("POST", "/api/auth/login", body, { noAuthRedirect: true }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout", undefined, { noAuthRedirect: true }),
  me: (signal?: AbortSignal) => request<{ user: User }>("GET", "/api/auth/me", undefined, { signal, noAuthRedirect: true }),

  createProject: (body: { name: string; description?: string | null }) => request<Project>("POST", "/api/projects", body),
  updateProject: (id: string, body: { name?: string; description?: string | null }) =>
    request<Project>("PATCH", `/api/projects/${id}`, body),
  deleteProject: (id: string) => request<void>("DELETE", `/api/projects/${id}`),

  scrape: (body: ScrapeRequest) => request<Job>("POST", "/api/scrape", body),
  crawl: (body: CrawlRequest) => request<Job>("POST", "/api/crawl", body),
  cancelJob: (id: string) => request<Job>("POST", `/api/jobs/${id}/cancel`),

  createKey: (name: string) => request<CreatedApiKey>("POST", "/api/keys", { name }),
  revokeKey: (id: string) => request<void>("DELETE", `/api/keys/${id}`),
};

/** GET paths, for use with the useApi hook. */
export const paths = {
  stats: "/api/stats",
  projects: "/api/projects",
  project: (id: string) => `/api/projects/${id}`,
  jobs: (q?: { project_id?: string; status?: string; type?: string; limit?: number }) => withQuery("/api/jobs", q),
  job: (id: string) => `/api/jobs/${id}`,
  jobEvents: (id: string) => `/api/jobs/${id}/events`,
  jobResults: (id: string, q?: { limit?: number; offset?: number; success?: boolean }) =>
    withQuery(`/api/jobs/${id}/results`, q),
  jobExport: (id: string, format: "jsonl" | "json" = "jsonl") => withQuery(`/api/jobs/${id}/export`, { format }),
  results: (q?: { project_id?: string; limit?: number }) => withQuery("/api/results", q),
  result: (id: string) => `/api/results/${id}`,
  resultDownload: (id: string, format: string) => withQuery(`/api/results/${id}/download`, { format }),
  keys: "/api/keys",
};

// Response type helpers for useApi call sites.
export type StatsResponse = Stats;
export type ProjectsResponse = ListResponse<Project>;
export type JobsResponse = ListResponse<Job>;
export type EventsResponse = ListResponse<JobEvent>;
export type ResultsResponse = ListResponse<ResultListItem>;
export type KeysResponse = ListResponse<ApiKey>;
export type { JobResultsPage, ResultWithContent };
