/**
 * Job + result routes. Registered twice:
 *   /api/...     for the dashboard (session cookie) and API keys
 *   /api/v1/...  the documented public API (API keys only)
 * Handlers are shared so both surfaces behave identically.
 */
import { Readable } from "node:stream";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { jobEvents, jobs as jobsRepo, projects, results as resultsRepo } from "../db/repos.js";
import type { Principal, ResultRow } from "../domain.js";
import { AppError } from "../lib/errors.js";
import { principalOf } from "../http/auth.js";
import { presentJob, presentResult, presentResultWithContent } from "../http/present.js";
import {
  CrawlRequest,
  DownloadQuery,
  ErrorBody,
  ExportQuery,
  IdParams,
  JobBody,
  JobListQuery,
  JobResultsPage,
  JobResultsQuery,
  ResultWithContent,
  ScrapeQuery,
  ScrapeRequest,
  ScrapeSyncBody,
} from "../http/schemas.js";
import { TERMINAL_STATUSES, type ScrapeJobOptions } from "../domain.js";
import type { AppContext } from "../app.js";

export interface JobRouteOptions {
  ctx: AppContext;
  base: "/api" | "/api/v1";
  accept: Array<Principal["via"]>;
  /** Include in the OpenAPI document. */
  public: boolean;
}

const errorResponses = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  429: ErrorBody,
};

export const jobRoutes: FastifyPluginAsyncTypebox<JobRouteOptions> = async (app, opts) => {
  const { ctx, base } = opts;
  const { db, jobsSvc, resultsSvc, config } = ctx;
  const auth = app.authenticate(opts.accept);
  const hide = !opts.public;
  const tags = ["jobs"];
  const createLimit = { rateLimit: { max: config.rateLimit.jobCreatePerMinute, timeWindow: "1 minute" } };
  const security = [{ bearerAuth: [] }];

  const getJobOr404 = async (userId: string, id: string) => {
    const job = await jobsRepo.get(db, userId, id);
    if (!job) throw new AppError("NOT_FOUND", "Job not found");
    return job;
  };

  // ------------------------------------------------------------------ create

  app.post(
    `${base}/scrape`,
    {
      preValidation: auth,
      config: createLimit,
      schema: {
        hide,
        tags,
        security,
        summary: "Scrape a single URL",
        description:
          "Creates a scrape job. By default returns immediately (202) with status `queued`/`running`: poll `GET /jobs/{id}` until the status is terminal, then fetch `GET /jobs/{id}/results`. " +
          "With `?wait=true` the request blocks until the page is done and returns 200 with the job and the page content inline (a failed scrape also returns 200, with `job.status = failed` and `job.error`).",
        querystring: ScrapeQuery,
        body: ScrapeRequest,
        response: { 200: ScrapeSyncBody, 202: JobBody, ...errorResponses },
      },
    },
    async (req, reply) => {
      const principal = principalOf(req);
      const job = await jobsSvc.create(principal, "scrape", req.body);
      if (req.query.wait) {
        const opts = job.options as ScrapeJobOptions;
        const deadline = Date.now() + opts.timeoutMs + 30_000;
        let current = job;
        // Stop early if the client hangs up (the socket, not req.raw: the request stream is
        // auto-destroyed as soon as its body has been read).
        while (!TERMINAL_STATUSES.has(current.status) && Date.now() < deadline && !req.socket.destroyed) {
          await new Promise((r) => setTimeout(r, 200));
          current = (await jobsRepo.get(db, principal.userId, job.id)) ?? current;
        }
        if (TERMINAL_STATUSES.has(current.status)) {
          const page = await resultsRepo.listForJob(db, principal.userId, job.id, { limit: 1, offset: 0 });
          const row = page.items[0];
          return reply.code(200).send({
            job: presentJob(current, base),
            result: row ? presentResultWithContent(row, await safeContent(row)) : null,
          });
        }
      }
      return reply.code(202).header("location", `${base}/jobs/${job.id}`).send(presentJob(job, base));
    },
  );

  app.post(
    `${base}/crawl`,
    {
      preValidation: auth,
      config: createLimit,
      schema: {
        hide,
        tags,
        security,
        summary: "Crawl a website",
        description: "Starts an asynchronous crawl. Progress and page counts are reported on the job; pages appear under `/jobs/{id}/results` as they complete.",
        body: CrawlRequest,
        response: { 202: JobBody, ...errorResponses },
      },
    },
    async (req, reply) => {
      const job = await jobsSvc.create(principalOf(req), "crawl", req.body);
      return reply.code(202).header("location", `${base}/jobs/${job.id}`).send(presentJob(job, base));
    },
  );

  // ------------------------------------------------------------------ read

  app.get(
    `${base}/jobs`,
    { preValidation: auth, schema: { hide, tags, security, summary: "List jobs", querystring: JobListQuery } },
    async (req) => {
      const q = req.query;
      const list = await jobsRepo.list(db, principalOf(req).userId, {
        projectId: q.project_id,
        status: q.status as never,
        type: q.type,
        limit: q.limit ?? 50,
        before: q.before ? new Date(q.before) : undefined,
      });
      return { data: list.map((j) => presentJob(j, base)) };
    },
  );

  app.get(
    `${base}/jobs/:id`,
    {
      preValidation: auth,
      schema: { hide, tags, security, summary: "Get job status", params: IdParams, response: { 200: JobBody, 404: ErrorBody } },
    },
    async (req) => {
      const job = await getJobOr404(principalOf(req).userId, req.params.id);
      return presentJob(job, base);
    },
  );

  if (base === "/api") {
    // Dashboard-only extras: timeline events for the job detail page.
    app.get(`${base}/jobs/:id/events`, { preValidation: auth, schema: { hide: true, params: IdParams } }, async (req) => {
      const job = await getJobOr404(principalOf(req).userId, req.params.id);
      const events = await jobEvents.list(db, job.id);
      return { data: events.map((e) => ({ id: e.id, level: e.level, event: e.event, message: e.message, data: e.data, created_at: e.created_at })) };
    });

    app.get(`${base}/stats`, { preValidation: auth, schema: { hide: true } }, async (req) => {
      const userId = principalOf(req).userId;
      const [byStatus, projectList, recent] = await Promise.all([
        jobsRepo.stats(db, userId),
        projects.list(db, userId),
        jobsRepo.list(db, userId, { limit: 10 }),
      ]);
      return {
        projects: projectList.length,
        jobs: {
          queued: byStatus.queued ?? 0,
          running: byStatus.running ?? 0,
          completed: byStatus.completed ?? 0,
          failed: byStatus.failed ?? 0,
          cancelled: byStatus.cancelled ?? 0,
        },
        recent_jobs: recent.map((j) => presentJob(j, base)),
      };
    });
  }

  app.post(
    `${base}/jobs/:id/cancel`,
    {
      preValidation: auth,
      schema: { hide, tags, security, summary: "Cancel a queued or running job", params: IdParams, response: { 200: JobBody, 404: ErrorBody, 409: ErrorBody } },
    },
    async (req) => presentJob(await jobsSvc.cancel(principalOf(req), req.params.id), base),
  );

  app.get(
    `${base}/jobs/:id/results`,
    {
      preValidation: auth,
      schema: {
        hide,
        tags,
        security,
        summary: "List a job's results",
        description:
          "Paginated page results. Failed pages are included with `success: false` and an `error`. Set `include_content=true` to inline markdown/html/text.",
        params: IdParams,
        querystring: JobResultsQuery,
        response: { 200: JobResultsPage, 404: ErrorBody },
      },
    },
    async (req) => {
      const userId = principalOf(req).userId;
      const job = await getJobOr404(userId, req.params.id);
      const limit = req.query.limit ?? 20;
      const offset = req.query.offset ?? 0;
      const page = await resultsRepo.listForJob(db, userId, job.id, { limit, offset, success: req.query.success });
      const data = req.query.include_content
        ? await Promise.all(page.items.map(async (r) => presentResultWithContent(r, await safeContent(r))))
        : page.items.map(presentResult);
      return {
        job: presentJob(job, base),
        data,
        pagination: { total: page.total, limit, offset, next_offset: offset + page.items.length < page.total ? offset + limit : null },
      };
    },
  );

  const safeContent = async (r: ResultRow) => {
    try {
      return await resultsSvc.loadContent(r);
    } catch {
      return null;
    }
  };

  app.get(
    `${base}/jobs/:id/export`,
    {
      preValidation: auth,
      schema: {
        hide,
        tags,
        security,
        summary: "Download all results of a job",
        description: "Streams every result with content, as JSON Lines (default) or a JSON array.",
        params: IdParams,
        querystring: ExportQuery,
      },
    },
    async (req, reply) => {
      const userId = principalOf(req).userId;
      const job = await getJobOr404(userId, req.params.id);
      const format = req.query.format ?? "jsonl";
      async function* rows() {
        const pageSize = 100;
        let first = true;
        if (format === "json") yield "[\n";
        for (let offset = 0; ; offset += pageSize) {
          const page = await resultsRepo.listForJob(db, userId, job.id, { limit: pageSize, offset });
          for (const r of page.items) {
            const line = JSON.stringify(presentResultWithContent(r, await safeContent(r)));
            if (format === "json") {
              yield (first ? "" : ",\n") + line;
              first = false;
            } else yield line + "\n";
          }
          if (page.items.length < pageSize) break;
        }
        if (format === "json") yield "\n]\n";
      }
      reply
        .header("content-type", format === "json" ? "application/json" : "application/x-ndjson")
        .header("content-disposition", `attachment; filename="job-${job.id}.${format}"`);
      return reply.send(Readable.from(rows()));
    },
  );

  app.get(
    `${base}/results/:id`,
    {
      preValidation: auth,
      schema: {
        hide,
        tags: ["results"],
        security,
        summary: "Get one result with content",
        params: IdParams,
        response: { 200: ResultWithContent, 404: ErrorBody },
      },
    },
    async (req) => {
      const r = await resultsRepo.get(db, principalOf(req).userId, req.params.id);
      if (!r) throw new AppError("NOT_FOUND", "Result not found");
      return presentResultWithContent(r, await resultsSvc.loadContent(r));
    },
  );

  app.get(
    `${base}/results/:id/download`,
    {
      preValidation: auth,
      schema: {
        hide,
        tags: ["results"],
        security,
        summary: "Download one result",
        description: "`format` = markdown | html | text | json (json includes metadata and every stored format).",
        params: IdParams,
        querystring: DownloadQuery,
      },
    },
    async (req, reply) => {
      const r = await resultsRepo.get(db, principalOf(req).userId, req.params.id);
      if (!r) throw new AppError("NOT_FOUND", "Result not found");
      const content = await resultsSvc.loadContent(r);
      const format = req.query.format ?? "json";
      const name = filenameFor(r.url);
      // Never let a downloaded page execute in our origin.
      reply.header("x-content-type-options", "nosniff").header("content-security-policy", "sandbox");
      if (format === "json") {
        reply
          .header("content-type", "application/json; charset=utf-8")
          .header("content-disposition", `attachment; filename="${name}.json"`);
        return JSON.stringify(presentResultWithContent(r, content), null, 2);
      }
      const body = content[format];
      if (body === undefined) {
        throw new AppError("NOT_FOUND", `Format "${format}" was not requested for this job`, { available: r.formats });
      }
      const types = { markdown: ["text/markdown", "md"], html: ["text/html", "html"], text: ["text/plain", "txt"] } as const;
      const [ctype, ext] = types[format];
      reply.header("content-type", `${ctype}; charset=utf-8`).header("content-disposition", `attachment; filename="${name}.${ext}"`);
      return body;
    },
  );

  if (base === "/api") {
    app.get(
      `${base}/results`,
      {
        preValidation: auth,
        schema: {
          hide: true,
          querystring: Type.Object({
            project_id: Type.Optional(Type.String({ format: "uuid" })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            before: Type.Optional(Type.String({ format: "date-time" })),
          }),
        },
      },
      async (req) => {
        const list = await resultsRepo.list(db, principalOf(req).userId, {
          projectId: req.query.project_id,
          limit: req.query.limit ?? 50,
          before: req.query.before ? new Date(req.query.before) : undefined,
        });
        return { data: list.map((r) => ({ ...presentResult(r), job_type: r.job_type })) };
      },
    );
  }
};

function filenameFor(url: string): string {
  try {
    const u = new URL(url);
    const slug = `${u.hostname}${u.pathname}`.replace(/[^A-Za-z0-9.-]+/g, "_").replace(/_+$/, "");
    return slug.slice(0, 120) || "result";
  } catch {
    return "result";
  }
}
