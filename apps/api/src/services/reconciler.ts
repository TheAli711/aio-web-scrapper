/**
 * Reconciler: keeps our job records in sync with the engine.
 *
 * Every tick it leases a batch of non-terminal jobs (FOR UPDATE SKIP LOCKED, so several API
 * instances can run it concurrently) and:
 *   - crawl, running        -> pulls progress + new pages from the engine, persists them,
 *                              and finalises the job when the engine reports a terminal status
 *   - queued, stale         -> re-dispatches (process died between insert and dispatch)
 *   - scrape, running,stale -> marks INTERRUPTED (process died mid-scrape)
 *   - crawl, over budget    -> cancels on the engine, fails with TIMEOUT
 */
import type { FastifyBaseLogger } from "fastify";
import type { Limits } from "../config.js";
import type { Db } from "../db/pool.js";
import { jobEvents, jobs as jobsRepo, results as resultsRepo } from "../db/repos.js";
import type { CrawlJobOptions, Job, ScrapeJobOptions } from "../domain.js";
import { EngineUnavailableError } from "../engine/firecrawl.js";
import type { ScrapingEngine } from "../engine/types.js";
import type { Metrics } from "../observability/metrics.js";
import type { JobService } from "./jobs.js";
import type { ResultService } from "./results.js";

const LEASE_SECONDS = 60;
const BATCH = 20;
const QUEUED_ORPHAN_MS = 15_000;
const CRAWL_START_ORPHAN_MS = 120_000;
const ENGINE_OUTAGE_FAIL_MS = 10 * 60_000;
const MAX_SYNC_ROUNDS = 20;

export class Reconciler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly engine: ScrapingEngine,
    private readonly jobsSvc: JobService,
    private readonly resultsSvc: ResultService,
    private readonly metrics: Metrics,
    private readonly log: FastifyBaseLogger,
    private readonly limits: Limits,
    private readonly intervalMs: number,
  ) {}

  start() {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      await this.tick();
      if (!this.stopped) this.timer = setTimeout(loop, this.intervalMs);
    };
    this.timer = setTimeout(loop, this.intervalMs);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 25));
  }

  /** One reconciliation pass. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const leased = await jobsRepo.leaseForSync(this.db, BATCH, LEASE_SECONDS);
      await Promise.all(leased.map((j) => this.reconcile(j)));
    } catch (err) {
      this.log.error({ err }, "reconciler tick failed");
    } finally {
      this.running = false;
    }
  }

  private async reconcile(job: Job): Promise<void> {
    try {
      const now = Date.now();
      if (job.status === "queued") {
        if (now - job.created_at.getTime() > QUEUED_ORPHAN_MS) {
          this.log.warn({ jobId: job.id }, "re-dispatching orphaned queued job");
          await jobsRepo.releaseLease(this.db, job.id);
          await this.jobsSvc.dispatch(job.id);
          return;
        }
      } else if (job.type === "scrape") {
        const opts = job.options as ScrapeJobOptions;
        const started = job.started_at?.getTime() ?? now;
        if (!this.jobsSvc.inFlight.has(job.id) && now - started > opts.timeoutMs + 60_000) {
          await this.jobsSvc.fail(job, "INTERRUPTED", "The scrape was interrupted before completing; please retry");
          return;
        }
      } else {
        await this.syncCrawl(job, now);
        return;
      }
      await jobsRepo.releaseLease(this.db, job.id);
    } catch (err) {
      this.log.error({ err, jobId: job.id }, "reconcile failed");
      await jobsRepo.releaseLease(this.db, job.id).catch(() => {});
    }
  }

  private async syncCrawl(job: Job, now: number): Promise<void> {
    const started = job.started_at?.getTime() ?? now;
    if (!job.engine_job_id) {
      if (now - started > CRAWL_START_ORPHAN_MS) {
        await this.jobsSvc.fail(job, "INTERRUPTED", "The crawl was interrupted before it started; please retry");
      } else {
        await jobsRepo.releaseLease(this.db, job.id);
      }
      return;
    }

    if (now - started > this.limits.maxCrawlDurationMs) {
      await this.engine.cancel(job.engine_job_id).catch(() => {});
      await this.drainAndFinish(job, "failed", {
        code: "TIMEOUT",
        message: `Crawl exceeded the maximum duration of ${Math.round(this.limits.maxCrawlDurationMs / 60000)} minutes`,
      });
      return;
    }

    try {
      const snap = await this.pullPages(job, job.sync_cursor);
      const counts = await resultsRepo.countsForJob(this.db, job.id);
      await jobsRepo.updateProgress(this.db, job.id, {
        discovered: Math.max(snap.discovered, counts.succeeded + counts.failed),
        processed: Math.max(snap.processed, counts.succeeded + counts.failed),
        succeeded: counts.succeeded,
        failed: counts.failed,
        cursor: snap.nextCursor,
      });

      if (snap.status === "running" || snap.status === "queued") {
        await jobsRepo.releaseLease(this.db, job.id);
        return;
      }
      if (snap.status === "completed") {
        await this.drainAndFinish(job, "completed");
      } else if (snap.status === "cancelled") {
        await this.drainAndFinish(job, "cancelled");
      } else {
        await this.drainAndFinish(job, "failed", snap.error ?? { code: "CRAWL_FAILED", message: "The crawl failed" });
      }
    } catch (err) {
      if (err instanceof EngineUnavailableError && now - job.updated_at.getTime() > ENGINE_OUTAGE_FAIL_MS) {
        await this.jobsSvc.fail(job, "ENGINE_UNAVAILABLE", "Lost contact with the scraping engine for too long");
        return;
      }
      this.log.warn({ err, jobId: job.id }, "crawl sync failed; will retry");
      await jobsRepo.releaseLease(this.db, job.id);
    }
  }

  /** Pull successful pages after `cursor` until the engine has nothing more right now. */
  private async pullPages(job: Job, cursor: number) {
    const opts = job.options as CrawlJobOptions;
    let snap = await this.engine.getJobStatus(job.engine_job_id!, cursor);
    for (let round = 0; ; round++) {
      let fresh = 0;
      for (const page of snap.pages) {
        if (await this.resultsSvc.persistPage(job, page, opts.formats)) {
          fresh++;
          this.metrics.increment("pages_total", { type: "crawl", outcome: page.success ? "success" : "failure" });
        }
      }
      if (fresh > 0) {
        this.log.debug({ jobId: job.id, fresh, cursor: snap.nextCursor }, "crawl pages ingested");
      }
      if (!snap.hasMore || round >= MAX_SYNC_ROUNDS) break;
      snap = await this.engine.getJobStatus(job.engine_job_id!, snap.nextCursor);
    }
    return snap;
  }

  /**
   * Terminal bookkeeping: a full re-scan from cursor 0 catches any page whose completion raced
   * our cursor (inserts are idempotent), then engine-side failures are recorded as failed pages.
   */
  private async drainAndFinish(
    job: Job,
    status: "completed" | "failed" | "cancelled",
    error?: { code: Job["error_code"] & string; message: string },
  ): Promise<void> {
    const opts = job.options as CrawlJobOptions;
    let snapDiscovered = job.pages_discovered;
    try {
      const snap = await this.pullPages(job, 0);
      snapDiscovered = Math.max(snapDiscovered, snap.discovered);
      const failures = await this.engine.getFailures(job.engine_job_id!);
      for (const f of failures) {
        if (await this.resultsSvc.persistPage(job, f, opts.formats)) {
          this.metrics.increment("pages_total", { type: "crawl", outcome: "failure" });
        }
      }
    } catch (err) {
      this.log.warn({ err, jobId: job.id }, "final crawl drain incomplete");
    }

    const counts = await resultsRepo.countsForJob(this.db, job.id);
    const total = counts.succeeded + counts.failed;
    await jobsRepo.updateProgress(this.db, job.id, {
      discovered: Math.max(snapDiscovered, total),
      processed: total,
      succeeded: counts.succeeded,
      failed: counts.failed,
      cursor: job.sync_cursor,
    });
    await jobEvents.add(this.db, job.id, counts.failed > 0 ? "warn" : "info", "crawl.synced", "Final crawl results recorded", {
      succeeded: counts.succeeded,
      failed: counts.failed,
    });

    // A "completed" crawl with zero successful pages is a failure from the user's point of view.
    if (status === "completed" && counts.succeeded === 0) {
      await this.jobsSvc.fail(job, "CRAWL_FAILED", total > 0 ? "No pages could be fetched successfully" : "The crawl found no pages");
    } else if (status === "completed") {
      await this.jobsSvc.complete(job);
    } else if (status === "cancelled") {
      const done = await jobsRepo.finish(this.db, job.id, "cancelled");
      if (done) await jobEvents.add(this.db, job.id, "warn", "job.cancelled", "Cancelled on the engine");
    } else {
      await this.jobsSvc.fail(job, error?.code ?? "CRAWL_FAILED", error?.message ?? "The crawl failed");
    }
  }
}
