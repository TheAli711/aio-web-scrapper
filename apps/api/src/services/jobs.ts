/**
 * JobService: creates, dispatches and cancels scrape/crawl jobs.
 *
 * Execution model (no second work queue):
 *   - Our `jobs` table is the persistent record of what a user asked for.
 *   - Work is handed to the engine immediately; Firecrawl's own queue (NuQ) does the scheduling.
 *   - Scrapes: dispatched in-process (Firecrawl scrape is synchronous from our side).
 *   - Crawls:  started on the engine; the Reconciler polls progress into our DB.
 *   - The Reconciler also recovers jobs orphaned by a restart.
 */
import type { FastifyBaseLogger } from "fastify";
import { checkUrl, normalizeHostname, type NetPolicyConfig, type Resolver, systemResolver } from "@ws/net-policy";
import type { Limits } from "../config.js";
import type { Db } from "../db/pool.js";
import { jobEvents, jobs as jobsRepo, projects } from "../db/repos.js";
import type {
  CrawlJobOptions,
  Job,
  JobType,
  OutputFormat,
  Principal,
  ScrapeJobOptions,
} from "../domain.js";
import type { BrandingService } from "../engine/branding.js";
import { EngineUnavailableError } from "../engine/firecrawl.js";
import type { PageResult, ScrapingEngine } from "../engine/types.js";
import { AppError, type ErrorCode } from "../lib/errors.js";
import type { Metrics } from "../observability/metrics.js";
import type { ResultService } from "./results.js";

export interface ScrapeInput {
  url: string;
  /** Omitted = the user's default (oldest) project. */
  project_id?: string;
  formats?: OutputFormat[];
  only_main_content?: boolean;
  timeout_ms?: number;
  wait_for_ms?: number;
}

export interface CrawlInput extends ScrapeInput {
  max_depth?: number;
  max_pages?: number;
  include_patterns?: string[];
  exclude_patterns?: string[];
  allowed_domain?: string;
  allow_subdomains?: boolean;
}

const DEFAULT_CRAWL_PAGES = 50;
const DEFAULT_CRAWL_DEPTH = 3;

export class JobService {
  /** In-flight scrapes in this process, so cancel can abort them and the reconciler can skip them. */
  readonly inFlight = new Map<string, AbortController>();

  constructor(
    private readonly db: Db,
    private readonly engine: ScrapingEngine,
    private readonly resultsSvc: ResultService,
    private readonly metrics: Metrics,
    private readonly log: FastifyBaseLogger,
    private readonly limits: Limits,
    private readonly urlPolicy: NetPolicyConfig,
    private readonly resolver: Resolver = systemResolver,
    private readonly branding: BrandingService | null = null,
    private readonly brandingTimeoutMs = 60_000,
  ) {}

  // ------------------------------------------------------------------ validation

  private normalizeScrapeOptions(input: ScrapeInput): ScrapeJobOptions {
    const formats = [...new Set(input.formats?.length ? input.formats : (["markdown"] as OutputFormat[]))];
    const timeoutMs = input.timeout_ms ?? this.limits.defaultScrapeTimeoutMs;
    if (timeoutMs > this.limits.maxScrapeTimeoutMs) {
      throw new AppError("LIMIT_EXCEEDED", `timeout_ms may not exceed ${this.limits.maxScrapeTimeoutMs}`, {
        field: "timeout_ms",
        max: this.limits.maxScrapeTimeoutMs,
      });
    }
    const waitForMs = input.wait_for_ms ?? 0;
    if (waitForMs > timeoutMs / 2) {
      throw new AppError("VALIDATION_ERROR", "wait_for_ms may not exceed half of timeout_ms", { field: "wait_for_ms" });
    }
    return { formats, onlyMainContent: input.only_main_content ?? true, timeoutMs, waitForMs };
  }

  private normalizeCrawlOptions(input: CrawlInput, startHost: string): CrawlJobOptions {
    const base = this.normalizeScrapeOptions(input);
    if (base.formats.includes("branding")) {
      throw new AppError("VALIDATION_ERROR", 'The "branding" format is only available for scrape jobs (brand the start URL with a scrape)', {
        field: "formats",
      });
    }
    const maxPages = input.max_pages ?? Math.min(DEFAULT_CRAWL_PAGES, this.limits.maxCrawlPages);
    if (maxPages > this.limits.maxCrawlPages) {
      throw new AppError("LIMIT_EXCEEDED", `max_pages may not exceed ${this.limits.maxCrawlPages}`, {
        field: "max_pages",
        max: this.limits.maxCrawlPages,
      });
    }
    const maxDepth = input.max_depth ?? Math.min(DEFAULT_CRAWL_DEPTH, this.limits.maxCrawlDepth);
    if (maxDepth > this.limits.maxCrawlDepth) {
      throw new AppError("LIMIT_EXCEEDED", `max_depth may not exceed ${this.limits.maxCrawlDepth}`, {
        field: "max_depth",
        max: this.limits.maxCrawlDepth,
      });
    }
    const includePatterns = this.checkPatterns(input.include_patterns ?? [], "include_patterns");
    const excludePatterns = this.checkPatterns(input.exclude_patterns ?? [], "exclude_patterns");

    const allowedDomain = input.allowed_domain ? normalizeHostname(input.allowed_domain) : startHost;
    if (startHost !== allowedDomain && !startHost.endsWith(`.${allowedDomain}`)) {
      throw new AppError("VALIDATION_ERROR", "allowed_domain must be the start URL's host or a parent domain of it", {
        field: "allowed_domain",
      });
    }
    return {
      ...base,
      maxPages,
      maxDepth,
      includePatterns,
      excludePatterns,
      allowedDomain,
      allowSubdomains: input.allow_subdomains ?? false,
    };
  }

  private checkPatterns(patterns: string[], field: string): string[] {
    if (patterns.length > this.limits.maxPatterns) {
      throw new AppError("LIMIT_EXCEEDED", `${field} may contain at most ${this.limits.maxPatterns} entries`, { field });
    }
    return patterns.map((p, i) => {
      if (p.length === 0 || p.length > this.limits.maxPatternLength) {
        throw new AppError("VALIDATION_ERROR", `${field}[${i}] must be 1-${this.limits.maxPatternLength} characters`, { field });
      }
      try {
        new RegExp(p);
      } catch {
        throw new AppError("VALIDATION_ERROR", `${field}[${i}] is not a valid regular expression`, { field });
      }
      return p;
    });
  }

  private async checkTarget(url: string): Promise<URL> {
    const r = await checkUrl(url, this.urlPolicy, this.resolver);
    if (!r.ok) {
      this.metrics.increment("url_policy_rejections_total", { code: r.code });
      throw new AppError(r.code, r.reason);
    }
    return r.value.url;
  }

  // ------------------------------------------------------------------ create

  async create(principal: Principal, type: JobType, input: ScrapeInput | CrawlInput): Promise<Job> {
    const project = input.project_id
      ? await projects.get(this.db, principal.userId, input.project_id)
      : await projects.getOrCreateDefault(this.db, principal.userId);
    if (!project) throw new AppError("NOT_FOUND", "Project not found");

    const target = await this.checkTarget(input.url);
    const options =
      type === "crawl"
        ? this.normalizeCrawlOptions(input as CrawlInput, normalizeHostname(target.hostname))
        : this.normalizeScrapeOptions(input);

    const active = await jobsRepo.countActive(this.db, principal.userId);
    if (active >= this.limits.maxActiveJobsPerUser) {
      throw new AppError(
        "TOO_MANY_ACTIVE_JOBS",
        `You already have ${active} queued/running jobs (limit ${this.limits.maxActiveJobsPerUser}). Wait for some to finish or cancel them.`,
      );
    }

    const job = await jobsRepo.create(this.db, {
      userId: principal.userId,
      projectId: project.id,
      type,
      targetUrl: target.href,
      options,
      source: principal.via === "api_key" ? "api" : "dashboard",
      apiKeyId: principal.apiKeyId ?? null,
      engine: this.engine.name,
    });
    await jobEvents.add(this.db, job.id, "info", "job.created", `${type} job created`, {
      url: job.target_url,
      source: job.source,
      options,
    });
    this.metrics.increment("jobs_created_total", { type, source: job.source });
    this.log.info(
      { event: "job.created", jobId: job.id, userId: job.user_id, projectId: job.project_id, type, url: job.target_url, source: job.source },
      "job created",
    );

    void this.dispatch(job.id);
    return job;
  }

  // ------------------------------------------------------------------ dispatch

  /** Claim a queued job and hand it to the engine. Safe to call more than once. */
  async dispatch(jobId: string): Promise<void> {
    let job: Job | null = null;
    try {
      job = await jobsRepo.claim(this.db, jobId);
      if (!job) return;
      await jobEvents.add(this.db, job.id, "info", "job.started", "Dispatched to engine", { engine: this.engine.name });
      this.log.info({ event: "job.started", jobId: job.id, userId: job.user_id, type: job.type }, "job started");
      if (job.type === "scrape") await this.runScrape(job);
      else await this.startCrawl(job);
    } catch (err) {
      if (!job) {
        this.log.error({ err, jobId }, "dispatch failed before claim");
        return;
      }
      const e = toJobError(err);
      if (e.code === "INTERNAL_ERROR") this.log.error({ err, jobId }, "dispatch failed");
      await this.fail(job, e.code, e.message);
    }
  }

  private async runScrape(job: Job): Promise<void> {
    const opts = job.options as ScrapeJobOptions;
    const ctrl = new AbortController();
    this.inFlight.set(job.id, ctrl);
    const t0 = Date.now();
    let page: PageResult;
    try {
      // Branding runs in its own browser, in parallel with the content scrape.
      const wantsBranding = opts.formats.includes("branding");
      const [scraped, branding] = await Promise.all([
        this.engine.scrape(job.target_url, opts, ctrl.signal),
        wantsBranding
          ? this.branding
            ? this.branding.extract(job.target_url, Math.max(opts.timeoutMs, this.brandingTimeoutMs), ctrl.signal)
            : Promise.resolve({ ok: false as const, error: { code: "ENGINE_UNAVAILABLE" as const, message: "Branding is not configured on this server" } })
          : Promise.resolve(undefined),
      ]);
      page = branding ? { ...scraped, branding } : scraped;
      if (branding) this.metrics.increment("branding_total", { outcome: branding.ok ? "success" : "failure" });
    } finally {
      this.inFlight.delete(job.id);
    }
    this.metrics.observe("engine_scrape_duration_ms", Date.now() - t0, { outcome: page.success ? "success" : "failure" });

    // Cancelled while in flight: the job is already terminal, don't store results.
    const current = await jobsRepo.getInternal(this.db, job.id);
    if (!current || current.status !== "running") return;

    await this.resultsSvc.persistPage(job, page, opts.formats);
    this.metrics.increment("pages_total", { type: "scrape", outcome: page.success ? "success" : "failure" });
    await jobsRepo.updateProgress(this.db, job.id, {
      discovered: 1,
      processed: 1,
      succeeded: page.success ? 1 : 0,
      failed: page.success ? 0 : 1,
      cursor: 1,
    });
    if (page.success) {
      await this.complete(job);
    } else {
      await this.fail(job, page.error?.code ?? "EXTRACTION_FAILED", page.error?.message ?? "Scrape failed", {
        statusCode: page.statusCode,
      });
    }
  }

  private async startCrawl(job: Job): Promise<void> {
    const { engineJobId } = await this.engine.crawl(job.target_url, job.options as CrawlJobOptions);
    await jobsRepo.setEngineJobId(this.db, job.id, engineJobId);
    await jobsRepo.releaseLease(this.db, job.id);
    await jobEvents.add(this.db, job.id, "info", "crawl.started", "Crawl accepted by engine");
  }

  // ------------------------------------------------------------------ terminal transitions

  async complete(job: Job, data: Record<string, unknown> = {}): Promise<void> {
    const done = await jobsRepo.finish(this.db, job.id, "completed");
    if (!done) return;
    await jobEvents.add(this.db, job.id, "info", "job.completed", "Job completed", {
      pagesSucceeded: done.pages_succeeded,
      pagesFailed: done.pages_failed,
      ...data,
    });
    this.recordTerminal(done);
  }

  async fail(job: Job, code: ErrorCode, message: string, data: Record<string, unknown> = {}): Promise<void> {
    const done = await jobsRepo.finish(this.db, job.id, "failed", { code, message });
    if (!done) return;
    await jobEvents.add(this.db, job.id, "error", "job.failed", message, { code, ...data });
    this.recordTerminal(done);
  }

  private recordTerminal(job: Job) {
    const durationMs = job.started_at && job.completed_at ? job.completed_at.getTime() - job.started_at.getTime() : null;
    this.metrics.increment("jobs_finished_total", { type: job.type, status: job.status });
    if (durationMs !== null) this.metrics.observe("job_duration_ms", durationMs, { type: job.type, status: job.status });
    this.log.info(
      {
        event: `job.${job.status}`,
        jobId: job.id,
        userId: job.user_id,
        projectId: job.project_id,
        type: job.type,
        url: job.target_url,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        durationMs,
        pagesDiscovered: job.pages_discovered,
        pagesSucceeded: job.pages_succeeded,
        pagesFailed: job.pages_failed,
        errorCode: job.error_code,
      },
      `job ${job.status}`,
    );
  }

  // ------------------------------------------------------------------ cancel

  async cancel(principal: Principal, jobId: string): Promise<Job> {
    const job = await jobsRepo.get(this.db, principal.userId, jobId);
    if (!job) throw new AppError("NOT_FOUND", "Job not found");
    if (job.status !== "queued" && job.status !== "running") {
      throw new AppError("JOB_NOT_CANCELLABLE", `Job is already ${job.status}`);
    }
    if (job.type === "crawl" && job.engine_job_id) {
      try {
        await this.engine.cancel(job.engine_job_id);
      } catch (err) {
        this.log.warn({ err, jobId }, "engine cancel failed; marking cancelled locally");
      }
    }
    this.inFlight.get(job.id)?.abort();
    const done = await jobsRepo.finish(this.db, job.id, "cancelled");
    if (done) {
      await jobEvents.add(this.db, job.id, "warn", "job.cancelled", "Cancelled by user", { via: principal.via });
      this.recordTerminal(done);
      return done;
    }
    return (await jobsRepo.get(this.db, principal.userId, jobId))!;
  }
}

export function toJobError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  if (err instanceof EngineUnavailableError) {
    return { code: "ENGINE_UNAVAILABLE", message: "The scraping engine is unavailable; try again shortly" };
  }
  const engineError = (err as { engineError?: { code: ErrorCode; message: string } })?.engineError;
  if (engineError) return engineError;
  return { code: "INTERNAL_ERROR", message: "An internal error occurred while running the job" };
}
