/**
 * TrafficEstimator: monthly-visit estimates for a domain, inferred from public signals (ranked
 * lists, the Common Crawl web graph, our own crawl, DNS). Estimates, not measured traffic.
 *
 * The only implementation, HttpTrafficEstimator, calls the internal traffic-estimator service
 * (apps/traffic-estimator, Python; no auth of its own, reachable on the private network only).
 * Estimates are per domain and shared by all users: they describe public sites, not user data.
 */
import { AppError } from "../lib/errors.js";

export interface TrafficEstimate {
  estimated_monthly_visits: number | null;
  lower_bound: number | null;
  upper_bound: number | null;
  traffic_bucket: string;
  confidence: "high" | "medium" | "low";
  confidence_score: number;
  model_version: string;
  generated_at: string;
  /** Per-signal breakdown; only when asked for. Not a stable contract. */
  details?: Record<string, unknown>;
}

export interface TrafficRun {
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface TrafficState {
  domain: string;
  /** Latest collection run (the one a refresh would be). */
  run: TrafficRun | null;
  /** Latest estimate, possibly from an earlier run than `run`. */
  estimate: TrafficEstimate | null;
}

export interface TrafficSubmission {
  input: string;
  domain: string | null;
  /** queued: new run; existing: a run is in progress; recent: estimated recently, nothing to do. */
  status: "queued" | "existing" | "recent" | "invalid" | "duplicate";
  error: string | null;
}

export interface TrafficEstimator {
  submit(domains: string[], refresh: boolean): Promise<TrafficSubmission[]>;
  /** null when the domain was never submitted. Throws INVALID_DOMAIN for unusable input. */
  get(domain: string, details: boolean): Promise<TrafficState | null>;
}

export class HttpTrafficEstimator implements TrafficEstimator {
  constructor(private readonly cfg: { serviceUrl: string; timeoutMs: number }) {}

  async submit(domains: string[], refresh: boolean): Promise<TrafficSubmission[]> {
    const body = (await this.call("POST", "/domains/bulk", { domains, force: refresh })) as { results: TrafficSubmission[] };
    return body.results.map((r) => ({ input: r.input, domain: r.domain, status: r.status, error: r.error ?? null }));
  }

  async get(domain: string, details: boolean): Promise<TrafficState | null> {
    const d = (await this.call("GET", `/domains/${encodeURIComponent(domain)}`)) as RawDomain | null;
    if (!d) return null;
    let estimate = d.latest_estimate ? pickEstimate(d.latest_estimate) : null;
    if (estimate && details) {
      const full = (await this.call("GET", `/domains/${encodeURIComponent(d.domain)}/estimate?details=true`)) as RawEstimate | null;
      if (full) estimate = { ...pickEstimate(full), details: full.details ?? {} };
    }
    const job = d.latest_job;
    return {
      domain: d.domain,
      run: job ? { status: job.status, error: job.error, created_at: job.created_at, finished_at: job.finished_at } : null,
      estimate,
    };
  }

  /** JSON call to the service. 404 → null; 400 → INVALID_DOMAIN; anything else → TRAFFIC_UNAVAILABLE. */
  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.serviceUrl}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch {
      throw new AppError("TRAFFIC_UNAVAILABLE", "The traffic estimator is not reachable; retry shortly");
    }
    if (res.status === 404) return null;
    const json = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    if (res.status === 400) {
      const detail = typeof json?.detail === "string" ? json.detail.replace(/^invalid domain:\s*/, "") : "not a valid domain";
      throw new AppError("INVALID_DOMAIN", `Invalid domain: ${detail}`);
    }
    if (!res.ok || json === null) {
      throw new AppError("TRAFFIC_UNAVAILABLE", "The traffic estimator returned an error; retry shortly", { upstreamStatus: res.status });
    }
    return json;
  }
}

interface RawEstimate extends Omit<TrafficEstimate, "details"> {
  details?: Record<string, unknown> | null;
}

interface RawDomain {
  domain: string;
  latest_job: (TrafficRun & { job_id: number }) | null;
  latest_estimate: RawEstimate | null;
}

function pickEstimate(e: RawEstimate): TrafficEstimate {
  return {
    estimated_monthly_visits: e.estimated_monthly_visits,
    lower_bound: e.lower_bound,
    upper_bound: e.upper_bound,
    traffic_bucket: e.traffic_bucket,
    confidence: e.confidence,
    confidence_score: e.confidence_score,
    model_version: e.model_version,
    generated_at: e.generated_at,
  };
}
