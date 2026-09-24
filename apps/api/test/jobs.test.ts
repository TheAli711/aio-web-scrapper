import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiKey, sameOrigin, setup, signup, teardown, waitForJob, type TestContext, type TestUser } from "./helpers.js";

let t: TestContext;
let user: TestUser;
let key: string;
let auth: Record<string, string>;

beforeAll(async () => {
  t = await setup();
  user = await signup(t.app);
  key = await createApiKey(t.app, user);
  auth = { authorization: `Bearer ${key}` };
});
afterAll(async () => teardown(t));

const scrape = (payload: Record<string, unknown>, headers = auth, url = "/api/v1/scrape") =>
  t.app.inject({ method: "POST", url, headers, payload: { project_id: user.projectId, ...payload } });

describe("POST /api/v1/scrape", () => {
  it("creates a job, completes it and exposes markdown/html/text results", async () => {
    const res = await scrape({ url: "https://example.com/page", formats: ["markdown", "html", "text"] });
    expect(res.statusCode).toBe(202);
    const job = res.json();
    expect(job).toMatchObject({ type: "scrape", target_url: "https://example.com/page", source: "api", project_id: user.projectId });
    expect(["queued", "running", "completed"]).toContain(job.status);
    expect(res.headers.location).toBe(`/api/v1/jobs/${job.id}`);

    const done = await waitForJob(t.app, auth, job.id, "/api/v1");
    expect(done.status).toBe("completed");
    expect(done.progress).toEqual({ pages_discovered: 1, pages_processed: 1, pages_succeeded: 1, pages_failed: 0 });
    expect(done.started_at).toBeTruthy();
    expect(done.completed_at).toBeTruthy();
    expect(done.error).toBeNull();

    const results = await t.app.inject({ method: "GET", url: `/api/v1/jobs/${job.id}/results?include_content=true`, headers: auth });
    expect(results.statusCode).toBe(200);
    const body = results.json();
    expect(body.pagination.total).toBe(1);
    const r = body.data[0];
    expect(r).toMatchObject({ url: "https://example.com/page", status_code: 200, success: true, title: "Title of https://example.com/page" });
    expect(r.content.markdown).toContain("Hello **world**");
    expect(r.content.html).toContain("<h1>");
    expect(r.content.text).toContain("Hello world");
    expect(r.content.links).toContain("https://example.com/other");
    expect(r.formats).toEqual(["markdown", "html", "text"]);

    // body is in object storage, not in Postgres
    const { rows } = await t.db.query("SELECT storage_key, metadata FROM results WHERE id = $1", [r.id]);
    expect(rows[0].storage_key).toMatch(new RegExp(`^users/${user.userId}/jobs/${job.id}/`));
    expect(JSON.stringify(rows[0].metadata)).not.toContain("Hello");
  });

  it("defaults to markdown only", async () => {
    const res = await scrape({ url: "https://example.com/default" });
    const done = await waitForJob(t.app, auth, res.json().id, "/api/v1");
    expect(done.options.formats).toEqual(["markdown"]);
    expect(done.options).toMatchObject({ only_main_content: true, timeout_ms: 30000, wait_for_ms: 0 });
    const r = await t.app.inject({ method: "GET", url: `/api/v1/jobs/${done.id}/results?include_content=true`, headers: auth });
    expect(Object.keys(r.json().data[0].content).sort()).toEqual(["links", "markdown"]);
  });

  it("downloads a single result in each format", async () => {
    const res = await scrape({ url: "https://example.com/dl", formats: ["markdown", "html", "text"] });
    const done = await waitForJob(t.app, auth, res.json().id, "/api/v1");
    const list = await t.app.inject({ method: "GET", url: `/api/v1/jobs/${done.id}/results`, headers: auth });
    const id = list.json().data[0].id;
    const cases = [
      ["markdown", "text/markdown", ".md"],
      ["html", "text/html", ".html"],
      ["text", "text/plain", ".txt"],
      ["json", "application/json", ".json"],
    ] as const;
    for (const [format, ctype, ext] of cases) {
      const dl = await t.app.inject({ method: "GET", url: `/api/v1/results/${id}/download?format=${format}`, headers: auth });
      expect(dl.statusCode, format).toBe(200);
      expect(dl.headers["content-type"]).toContain(ctype);
      expect(dl.headers["content-disposition"]).toContain(`attachment; filename="example.com_dl${ext}"`);
      expect(dl.headers["content-security-policy"]).toBe("sandbox");
    }
  });

  it("exports a whole job as JSON Lines", async () => {
    const res = await scrape({ url: "https://example.com/export" });
    const done = await waitForJob(t.app, auth, res.json().id, "/api/v1");
    const exp = await t.app.inject({ method: "GET", url: `/api/v1/jobs/${done.id}/export`, headers: auth });
    expect(exp.statusCode).toBe(200);
    const lines = exp.body.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].content.markdown).toContain("Hello");
  });

  it("records a failed page and a failed job for an HTTP error", async () => {
    const res = await scrape({ url: "https://notfound.example.com/x" });
    const done = await waitForJob(t.app, auth, res.json().id, "/api/v1");
    expect(done.status).toBe("failed");
    expect(done.error).toEqual({ code: "HTTP_ERROR", message: "Target responded with HTTP 404" });
    expect(done.progress.pages_failed).toBe(1);
    const results = await t.app.inject({ method: "GET", url: `/api/v1/jobs/${done.id}/results`, headers: auth });
    expect(results.json().data[0]).toMatchObject({ success: false, status_code: 404, error: { code: "HTTP_ERROR" } });
  });

  it("reports timeouts with a TIMEOUT code", async () => {
    const res = await scrape({ url: "https://slow.example.com/" });
    const done = await waitForJob(t.app, auth, res.json().id, "/api/v1");
    expect(done.status).toBe("failed");
    expect(done.error.code).toBe("TIMEOUT");
  });

  it("writes a job timeline", async () => {
    const res = await scrape({ url: "https://example.com/events" }, sameOrigin(user.cookie), "/api/scrape");
    const done = await waitForJob(t.app, { cookie: user.cookie }, res.json().id);
    expect(done.source).toBe("dashboard");
    const ev = await t.app.inject({ method: "GET", url: `/api/jobs/${done.id}/events`, headers: { cookie: user.cookie } });
    expect(ev.json().data.map((e: { event: string }) => e.event)).toEqual(["job.created", "job.started", "job.completed"]);
  });
});

describe("URL validation and SSRF protection", () => {
  it.each([
    ["not a url", "INVALID_URL"],
    ["ftp://example.com/file", "UNSUPPORTED_URL"],
    ["file:///etc/passwd", "UNSUPPORTED_URL"],
    ["https://user:pw@example.com/", "UNSUPPORTED_URL"],
    ["http://localhost:3002/v2/crawl", "BLOCKED_URL"],
    ["http://127.0.0.1/", "BLOCKED_URL"],
    ["http://[::1]/", "BLOCKED_URL"],
    ["http://169.254.169.254/latest/meta-data/", "BLOCKED_URL"],
    ["http://metadata.google.internal/", "BLOCKED_URL"],
    ["http://10.0.0.1/", "BLOCKED_URL"],
    ["http://192.168.1.1/admin", "BLOCKED_URL"],
    ["http://2130706433/", "BLOCKED_URL"],
    ["http://redis:6379/", "BLOCKED_URL"],
    ["http://api:3002/", "BLOCKED_URL"],
    ["https://rebind.example/", "BLOCKED_URL"],
    ["https://mixed.example/", "BLOCKED_URL"],
    ["https://does-not-exist.example/", "DNS_RESOLUTION_FAILED"],
  ])("rejects %s with %s and creates no job", async (url, code) => {
    const before = await t.db.query("SELECT count(*)::int AS n FROM jobs");
    const res = await scrape({ url });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.json().error.code).toBe(code);
    const after = await t.db.query("SELECT count(*)::int AS n FROM jobs");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("applies the same checks to crawls", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/crawl",
      headers: auth,
      payload: { url: "http://169.254.169.254/", project_id: user.projectId },
    });
    expect(res.json().error.code).toBe("BLOCKED_URL");
  });

  it("does not leak internal details in error messages", async () => {
    const res = await scrape({ url: "https://rebind.example/" });
    expect(res.json().error.message).not.toMatch(/10\.0\.0\.7/);
  });
});

describe("request validation and limits", () => {
  it("rejects unknown fields and bad types", async () => {
    const res = await scrape({ url: "https://example.com/", formats: ["pdf"], extra: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("enforces the scrape timeout maximum", async () => {
    const res = await scrape({ url: "https://example.com/", timeout_ms: 600000 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: "LIMIT_EXCEEDED", details: { field: "timeout_ms", max: 60000 } });
  });

  it("enforces crawl page/depth limits and pattern validity", async () => {
    const crawl = (extra: Record<string, unknown>) =>
      t.app.inject({ method: "POST", url: "/api/v1/crawl", headers: auth, payload: { url: "https://example.com/", project_id: user.projectId, ...extra } });
    expect((await crawl({ max_pages: 1000 })).json().error.code).toBe("LIMIT_EXCEEDED");
    expect((await crawl({ max_depth: 50 })).json().error.code).toBe("LIMIT_EXCEEDED");
    expect((await crawl({ include_patterns: ["(unclosed"] })).json().error.code).toBe("VALIDATION_ERROR");
    expect((await crawl({ allowed_domain: "other.com" })).json().error.code).toBe("VALIDATION_ERROR");
  });

  it("caps concurrently active jobs per user", async () => {
    const u = await signup(t.app);
    t.engine.scrapeDelayMs = 2000;
    try {
      const k = await createApiKey(t.app, u);
      const h = { authorization: `Bearer ${k}` };
      const codes: number[] = [];
      for (let i = 0; i < t.config.limits.maxActiveJobsPerUser + 1; i++) {
        const r = await t.app.inject({ method: "POST", url: "/api/v1/scrape", headers: h, payload: { url: `https://example.com/${i}`, project_id: u.projectId } });
        codes.push(r.statusCode);
        if (r.statusCode === 429) expect(r.json().error.code).toBe("TOO_MANY_ACTIVE_JOBS");
      }
      expect(codes.filter((c) => c === 202)).toHaveLength(t.config.limits.maxActiveJobsPerUser);
      expect(codes.at(-1)).toBe(429);
    } finally {
      t.engine.scrapeDelayMs = 0;
    }
  });

  it("returns 404 with a structured body for unknown jobs and routes", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/jobs/00000000-0000-0000-0000-000000000000", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    const bad = await t.app.inject({ method: "GET", url: "/api/v1/jobs/not-a-uuid", headers: auth });
    expect(bad.statusCode).toBe(400);
    const route = await t.app.inject({ method: "GET", url: "/api/v1/nope", headers: auth });
    expect(route.statusCode).toBe(404);
  });
});

describe("POST /api/v1/crawl", () => {
  it("tracks progress, ingests pages incrementally and records failed pages", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/crawl",
      headers: auth,
      payload: {
        url: "https://site.example.com/",
        project_id: user.projectId,
        max_depth: 2,
        max_pages: 10,
        include_patterns: ["^/"],
        exclude_patterns: ["^/private"],
        formats: ["markdown", "text"],
      },
    });
    expect(res.statusCode).toBe(202);
    const jobId = res.json().id;

    // dispatch hands the crawl to the engine
    let engineId: string | undefined;
    for (let i = 0; i < 100 && !engineId; i++) {
      engineId = [...t.engine.crawls.keys()].pop();
      await new Promise((r) => setTimeout(r, 10));
    }
    const started = t.engine.crawls.get(engineId!)!;
    expect(started.options).toMatchObject({ maxDepth: 2, maxPages: 10, includePatterns: ["^/"], excludePatterns: ["^/private"], allowedDomain: "site.example.com" });

    t.engine.advance(engineId!, 2);
    await t.app.ctx.reconciler.tick();
    let job = (await t.app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}`, headers: auth })).json();
    expect(job.status).toBe("running");
    expect(job.progress).toMatchObject({ pages_discovered: 4, pages_processed: 2, pages_succeeded: 2, pages_failed: 0 });

    t.engine.advance(engineId!, 10, true);
    await t.app.ctx.reconciler.tick();
    job = (await t.app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}`, headers: auth })).json();
    expect(job.status).toBe("completed");
    // 3 x 200, 1 x 404 page, 1 engine failure
    expect(job.progress).toMatchObject({ pages_succeeded: 3, pages_failed: 2, pages_processed: 5 });

    const ok = await t.app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}/results?success=true`, headers: auth });
    expect(ok.json().pagination.total).toBe(3);
    const failed = await t.app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}/results?success=false`, headers: auth });
    const codes = failed.json().data.map((r: { error: { code: string } }) => r.error.code).sort();
    expect(codes).toEqual(["CONNECTION_FAILED", "HTTP_ERROR"]);

    const paged = await t.app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}/results?limit=2&offset=0`, headers: auth });
    expect(paged.json().pagination).toMatchObject({ total: 5, limit: 2, next_offset: 2 });
  });

  it("cancels a running crawl on the engine", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/v1/crawl", headers: auth, payload: { url: "https://site.example.com/c", project_id: user.projectId } });
    const jobId = res.json().id;
    for (let i = 0; i < 100; i++) {
      const j = (await t.app.inject({ method: "GET", url: `/api/v1/jobs/${jobId}`, headers: auth })).json();
      if (j.status === "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 50));
    const cancel = await t.app.inject({ method: "POST", url: `/api/v1/jobs/${jobId}/cancel`, headers: auth });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("cancelled");
    expect(t.engine.cancelled.length).toBeGreaterThan(0);
    const again = await t.app.inject({ method: "POST", url: `/api/v1/jobs/${jobId}/cancel`, headers: auth });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("JOB_NOT_CANCELLABLE");
  });
});

describe("observability", () => {
  it("counts jobs, pages and API errors", async () => {
    expect(t.metrics.counter("jobs_created_total", { source: "api", type: "scrape" })).toBeGreaterThan(0);
    expect(t.metrics.counter("jobs_finished_total", { status: "completed", type: "scrape" })).toBeGreaterThan(0);
    expect(t.metrics.counter("pages_total", { outcome: "success", type: "crawl" })).toBeGreaterThan(0);
    expect(t.metrics.counter("api_errors_total", { code: "BLOCKED_URL", status: 400 })).toBeGreaterThan(0);
    const res = await t.app.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("job_duration_ms_bucket");
    expect(res.body).toContain('jobs_active{status="running"}');
  });

  it("serves an OpenAPI document for the public API", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    const doc = res.json();
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(["/api/v1/scrape", "/api/v1/crawl", "/api/v1/jobs/{id}", "/api/v1/jobs/{id}/results"]),
    );
    expect(Object.keys(doc.paths).some((p) => p.startsWith("/api/auth"))).toBe(false);
  });
});

describe("agent conveniences", () => {
  it("POST /scrape?wait=true returns the finished job with content inline", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/scrape?wait=true",
      headers: auth,
      payload: { url: "https://example.com/sync", formats: ["markdown", "text"] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.job.status).toBe("completed");
    expect(body.job.project_id).toBe(user.projectId); // defaulted
    expect(body.result.content.markdown).toContain("Hello **world**");
    expect(body.result.content.text).toContain("Hello world");
  });

  it("POST /scrape?wait=true reports failures with 200 and job.error", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/v1/scrape?wait=true", headers: auth, payload: { url: "https://notfound.example.com/" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().job.error.code).toBe("HTTP_ERROR");
    expect(res.json().result.status_code).toBe(404);
  });

  it("serves the agent guide with the caller's base URL", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/llms.txt", headers: { host: "scraper.local:4000" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.body).toContain("http://scraper.local:4000/api/v1/scrape?wait=true");
    expect(res.body).not.toContain("{{BASE_URL}}");
  });
});
