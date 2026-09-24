/**
 * End-to-end tests against the running docker compose stack (real Firecrawl, egress proxy,
 * Postgres). Run with:
 *
 *   TRUSTED_TEST_HOSTS=testsite.test docker compose --profile e2e up -d --build
 *   npm run test:e2e
 *
 * Needs outbound internet for the example.com scrape.
 */
import { beforeAll, describe, expect, it } from "vitest";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:4000";
const ORIGIN = process.env.E2E_APP_ORIGIN ?? "http://localhost:3000";
const SITE = process.env.E2E_TESTSITE_URL ?? "http://testsite.test";

type Json = Record<string, any>;

async function call(method: string, path: string, opts: { cookie?: string; key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) {
    headers.cookie = opts.cookie;
    headers.origin = ORIGIN;
  }
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  const res = await fetch(BASE + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: Json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function newUser() {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.dev`;
  const res = await fetch(BASE + "/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: "e2e-password-123" }),
  });
  expect(res.status).toBe(201);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("ws_session="))!.split(";")[0]!;
  const projects = await call("GET", "/api/projects", { cookie });
  const keyRes = await call("POST", "/api/keys", { cookie, body: { name: "e2e" } });
  expect(keyRes.status).toBe(201);
  return { cookie, projectId: projects.json.data[0].id as string, key: keyRes.json.key as string };
}

async function waitFor(key: string, jobId: string, timeoutMs = 180_000): Promise<Json> {
  const start = Date.now();
  for (;;) {
    const r = await call("GET", `/api/v1/jobs/${jobId}`, { key });
    if (["completed", "failed", "cancelled"].includes(r.json.status)) return r.json;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} still ${r.json.status}`);
    await new Promise((res) => setTimeout(res, 1000));
  }
}

let user: Awaited<ReturnType<typeof newUser>>;

beforeAll(async () => {
  const ready = await fetch(BASE + "/readyz").then((r) => r.json(), () => null);
  if (!ready?.database || !ready?.engine) throw new Error(`stack not ready at ${BASE}: ${JSON.stringify(ready)}`);
  user = await newUser();
});

describe("e2e: single URL scrape", () => {
  it("scrapes https://example.com through Firecrawl and returns markdown/html/text", async () => {
    const created = await call("POST", "/api/v1/scrape", {
      key: user.key,
      body: { url: "https://example.com", project_id: user.projectId, formats: ["markdown", "html", "text"] },
    });
    expect(created.status).toBe(202);
    expect(["queued", "running"]).toContain(created.json.status);

    const job = await waitFor(user.key, created.json.id);
    expect(job.status).toBe("completed");
    expect(job.progress.pages_succeeded).toBe(1);

    const results = await call("GET", `/api/v1/jobs/${job.id}/results?include_content=true`, { key: user.key });
    const r = results.json.data[0];
    expect(r.status_code).toBe(200);
    expect(r.title).toBe("Example Domain");
    expect(r.content.markdown).toContain("Example Domain");
    expect(r.content.html).toContain("Example Domain");
    expect(r.content.text).toContain("Example Domain");

    const dl = await call("GET", `/api/v1/results/${r.id}/download?format=text`, { key: user.key });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(dl.text).toContain("Example Domain");
  });
});

describe("e2e: small website crawl", () => {
  it("crawls the fixture site and reports successful and failed pages", async () => {
    const created = await call("POST", "/api/v1/crawl", {
      key: user.key,
      body: { url: `${SITE}/`, project_id: user.projectId, max_depth: 3, max_pages: 20, formats: ["markdown", "text"] },
    });
    expect(created.status).toBe(202);
    const job = await waitFor(user.key, created.json.id);
    expect(job.status).toBe("completed");
    // 7 good pages, a 404 and a 500 (see infra/testsite)
    expect(job.progress.pages_succeeded).toBe(7);
    expect(job.progress.pages_failed).toBe(2);

    const all = await call("GET", `/api/v1/jobs/${job.id}/results?limit=50`, { key: user.key });
    expect(all.json.pagination.total).toBe(9);
    const failed = all.json.data.filter((r: Json) => !r.success).map((r: Json) => [new URL(r.url).pathname, r.status_code, r.error.code]);
    expect(failed.sort()).toEqual([
      ["/missing-page.html", 404, "HTTP_ERROR"],
      ["/server-error", 500, "HTTP_ERROR"],
    ]);

    const exp = await fetch(`${BASE}/api/v1/jobs/${job.id}/export`, { headers: { authorization: `Bearer ${user.key}` } });
    const lines = (await exp.text()).trim().split("\n");
    expect(lines).toHaveLength(9);
  });

  it("honours exclude patterns and max_pages", async () => {
    const created = await call("POST", "/api/v1/crawl", {
      key: user.key,
      body: { url: `${SITE}/`, project_id: user.projectId, max_pages: 20, exclude_patterns: ["^/blog"] },
    });
    const job = await waitFor(user.key, created.json.id);
    const all = await call("GET", `/api/v1/jobs/${job.id}/results?limit=50`, { key: user.key });
    const paths = all.json.data.map((r: Json) => new URL(r.url).pathname);
    expect(paths.some((p: string) => p.startsWith("/blog"))).toBe(false);
    expect(paths).toContain("/about.html");
  });
});

describe("e2e: failed URLs", () => {
  it("records an HTTP error page as a failed job", async () => {
    const created = await call("POST", "/api/v1/scrape", { key: user.key, body: { url: `${SITE}/missing-page.html`, project_id: user.projectId } });
    const job = await waitFor(user.key, created.json.id);
    expect(job.status).toBe("failed");
    expect(job.error).toEqual({ code: "HTTP_ERROR", message: "Target responded with HTTP 404" });
  });

  it("rejects unresolvable hosts before creating a job", async () => {
    const res = await call("POST", "/api/v1/scrape", {
      key: user.key,
      body: { url: "https://nonexistent-host-abc123xyz.com/", project_id: user.projectId },
    });
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe("DNS_RESOLUTION_FAILED");
  });

  it("rejects private/metadata targets at the API", async () => {
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://api:3002/", "http://localhost:4000/"]) {
      const res = await call("POST", "/api/v1/scrape", { key: user.key, body: { url, project_id: user.projectId } });
      expect(res.json.error.code, url).toBe("BLOCKED_URL");
    }
  });

  it("blocks a redirect to the metadata endpoint at the egress proxy", async () => {
    const created = await call("POST", "/api/v1/scrape", { key: user.key, body: { url: `${SITE}/redirect-to-metadata`, project_id: user.projectId } });
    expect(created.status).toBe(202);
    const job = await waitFor(user.key, created.json.id);
    expect(job.status).toBe("failed");
    expect(job.error.code).toBe("BLOCKED_URL");
    const results = await call("GET", `/api/v1/jobs/${job.id}/results?include_content=true`, { key: user.key });
    expect(JSON.stringify(results.json)).not.toMatch(/ami-id|instance-id/);
  });
});

describe("e2e: unauthorized project access", () => {
  it("another user cannot use, read or cancel this user's project and jobs", async () => {
    const intruder = await newUser();
    const scrape = await call("POST", "/api/v1/scrape", { key: intruder.key, body: { url: "https://example.com", project_id: user.projectId } });
    expect(scrape.status).toBe(404);

    const mine = await call("GET", `/api/v1/jobs?limit=1`, { key: user.key });
    const jobId = mine.json.data[0].id;
    for (const [m, p] of [
      ["GET", `/api/v1/jobs/${jobId}`],
      ["GET", `/api/v1/jobs/${jobId}/results`],
      ["POST", `/api/v1/jobs/${jobId}/cancel`],
    ]) {
      const r = await call(m!, p!, { key: intruder.key });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    const noKey = await call("GET", `/api/v1/jobs/${jobId}`);
    expect(noKey.status).toBe(401);
  });
});
