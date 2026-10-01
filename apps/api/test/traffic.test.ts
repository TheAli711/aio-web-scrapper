import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpTrafficEstimator } from "../src/engine/traffic.js";
import { createApiKey, sameOrigin, setup, signup, teardown, type TestContext, type TestUser } from "./helpers.js";

let t: TestContext;
let user: TestUser;
let auth: Record<string, string>;
beforeAll(async () => {
  t = await setup();
  user = await signup(t.app);
  auth = { authorization: `Bearer ${await createApiKey(t.app, user)}` };
});
afterAll(async () => teardown(t));
beforeEach(() => {
  t.traffic.states.clear();
  t.traffic.reads.clear();
  t.traffic.submissions = [];
  t.traffic.autoFinishAfterGets = Infinity;
  t.traffic.available = true;
  t.app.ctx.traffic = t.traffic;
});

const post = (payload: unknown, query = "", headers = auth) =>
  t.app.inject({ method: "POST", url: `/api/v1/traffic${query}`, headers, payload: payload as object });
const get = (domain: string, query = "", headers = auth) => t.app.inject({ method: "GET", url: `/api/v1/traffic/${domain}${query}`, headers });

describe("traffic estimates API", () => {
  it("requires an API key", async () => {
    expect((await post({ domain: "example.com" }, "", {})).json().error.code).toBe("UNAUTHENTICATED");
    const bad = await get("example.com", "", { authorization: "Bearer wsk_AAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("INVALID_API_KEY");
  });

  it("starts an estimate (202), then serves it once ready (200)", async () => {
    const res = await post({ domain: "https://www.Shop.example.com/products/x" });
    expect(res.statusCode).toBe(202);
    expect(res.headers.location).toBe("/api/v1/traffic/shop.example.com");
    expect(res.json()).toMatchObject({ domain: "shop.example.com", status: "pending", refreshing: false, estimate: null, error: null });
    expect(res.json().disclaimer).toMatch(/not measured traffic/);
    expect((await get("shop.example.com")).json().status).toBe("pending");

    t.traffic.finish("shop.example.com");
    const ready = await get("shop.example.com");
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      domain: "shop.example.com",
      status: "ready",
      refreshing: false,
      estimate: {
        estimated_monthly_visits: 18256,
        lower_bound: 3651,
        upper_bound: 91280,
        traffic_bucket: "10K-100K",
        confidence: "high",
        confidence_score: 0.81,
        model_version: "heuristic_v2",
        generated_at: "2026-10-01T12:00:00.000Z",
      },
      error: null,
      disclaimer: expect.any(String),
      links: { self: "/api/v1/traffic/shop.example.com" },
    });
  });

  it("returns a recent estimate at once and refreshes only when asked", async () => {
    await post({ domain: "example.com" });
    t.traffic.finish("example.com");
    const again = await post({ domain: "example.com" });
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe("ready");
    expect(t.traffic.submissions.at(-1)).toEqual({ domains: ["example.com"], refresh: false });

    const refresh = await post({ domain: "example.com", refresh: true });
    expect(refresh.statusCode).toBe(202);
    expect(refresh.json()).toMatchObject({ status: "ready", refreshing: true, estimate: { estimated_monthly_visits: 18256 } });
    t.traffic.finish("example.com", 50_000);
    expect((await get("example.com")).json()).toMatchObject({ refreshing: false, estimate: { estimated_monthly_visits: 50_000 } });
  });

  it("waits for the estimate with ?wait=true", async () => {
    t.traffic.autoFinishAfterGets = 2;
    const res = await post({ domain: "docs.example.com" }, "?wait=true");
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ready");
  });

  it("gives up waiting after TRAFFIC_WAIT_MS and returns 202", async () => {
    const waitMs = t.app.ctx.config.traffic.waitMs;
    t.app.ctx.config.traffic.waitMs = 0;
    try {
      const res = await post({ domain: "slow.example.com" }, "?wait=true");
      expect(res.statusCode).toBe(202);
      expect(res.json().status).toBe("pending");
    } finally {
      t.app.ctx.config.traffic.waitMs = waitMs;
    }
  });

  it("includes the per-signal breakdown only with details=true", async () => {
    await post({ domain: "example.com" });
    t.traffic.finish("example.com");
    expect((await get("example.com")).json().estimate.details).toBeUndefined();
    expect((await get("example.com", "?details=true")).json().estimate.details).toEqual({ signal_estimates_log10: { tranco: 4.2 } });
    expect((await post({ domain: "example.com" }, "?details=true")).json().estimate.details).toBeDefined();
  });

  it("reports a failed estimate", async () => {
    await post({ domain: "broken.example.com" });
    t.traffic.fail("broken.example.com");
    const res = await get("broken.example.com");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "failed", estimate: null, error: { code: "ESTIMATION_FAILED", message: "all collectors failed" } });
  });

  it("rejects invalid domains and unknown ones", async () => {
    const bad = await post({ domain: "not-a-domain" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("INVALID_DOMAIN");
    expect((await post({})).json().error.code).toBe("VALIDATION_ERROR");
    const unknown = await get("never-asked.example.com");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.message).toMatch(/POST \/api\/v1\/traffic/);
  });

  it("estimates many domains at once", async () => {
    await post({ domain: "known.example.com" });
    t.traffic.finish("known.example.com");
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/traffic/bulk",
      headers: auth,
      payload: { domains: ["known.example.com", "new.example.com", "invalid-one", "https://www.new.example.com/"] },
    });
    expect(res.statusCode).toBe(202);
    const items = res.json().data;
    expect(items.map((i: { input: string; status: string }) => [i.input, i.status])).toEqual([
      ["known.example.com", "ready"],
      ["new.example.com", "pending"],
      ["invalid-one", "invalid"],
      ["https://www.new.example.com/", "pending"],
    ]);
    expect(items[0].estimate.estimated_monthly_visits).toBe(18256);
    expect(items[2]).toMatchObject({ domain: null, links: null, error: { code: "INVALID_DOMAIN" } });
    expect(items[3]).toMatchObject({ domain: "new.example.com", links: { self: "/api/v1/traffic/new.example.com" } });
    expect(res.json().disclaimer).toMatch(/not measured/);

    const tooMany = await t.app.inject({
      method: "POST",
      url: "/api/v1/traffic/bulk",
      headers: auth,
      payload: { domains: Array.from({ length: 101 }, (_, i) => `d${i}.example.com`) },
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it("answers 503 when the estimator is down or not configured", async () => {
    t.traffic.available = false;
    const down = await post({ domain: "example.com" });
    expect(down.statusCode).toBe(503);
    expect(down.json().error.code).toBe("TRAFFIC_UNAVAILABLE");
    t.app.ctx.traffic = null;
    const off = await get("example.com");
    expect(off.statusCode).toBe(503);
    expect(off.json().error.message).toMatch(/not enabled/);
  });

  it("is available to the dashboard under /api, and to API keys only under /api/v1", async () => {
    const dash = await t.app.inject({ method: "POST", url: "/api/traffic", headers: sameOrigin(user.cookie), payload: { domain: "example.com" } });
    expect(dash.statusCode).toBe(202);
    expect(dash.json().links.self).toBe("/api/traffic/example.com");
    const cookieOnV1 = await get("example.com", "", { cookie: user.cookie });
    expect(cookieOnV1.statusCode).toBe(403);
  });

  it("is documented in the OpenAPI spec", async () => {
    const spec = (await t.app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json();
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/api/v1/traffic", "/api/v1/traffic/{domain}", "/api/v1/traffic/bulk"]));
    expect(Object.keys(spec.paths)).not.toContain("/api/traffic");
  });
});

describe("HttpTrafficEstimator", () => {
  let server: Server;
  let url: string;
  const calls: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.method === "POST" && req.url === "/domains/bulk") {
        return send(202, {
          accepted: 1,
          queued: 1,
          results: [
            { input: "Example.com", domain: "example.com", domain_id: 1, job_id: 7, status: "queued", error: null },
            { input: "bad", domain: null, domain_id: null, job_id: null, status: "invalid", error: "no dot" },
          ],
        });
      }
      const estimate = {
        domain: "example.com",
        estimated_monthly_visits: 1200,
        lower_bound: 400,
        upper_bound: 3800,
        traffic_bucket: "1K-10K",
        confidence: "medium",
        confidence_score: 0.55,
        model_version: "heuristic_v2",
        feature_version: "v2",
        generated_at: "2026-10-01T12:00:00Z",
        job_id: 7,
        disclaimer: "x",
        details: null,
      };
      if (req.url === "/domains/example.com") {
        return send(200, {
          domain: "example.com",
          domain_id: 1,
          latest_job: { job_id: 7, status: "completed", error: null, created_at: "2026-10-01T11:59:40Z", finished_at: "2026-10-01T12:00:00Z", tasks: [] },
          latest_estimate: estimate,
          collection_log: [{ source: "crawl" }],
        });
      }
      if (req.url === "/domains/example.com/estimate?details=true") return send(200, { ...estimate, details: { notes: ["n"] } });
      if (req.url === "/domains/bad") return send(400, { detail: "invalid domain: no dot" });
      if (req.url === "/domains/boom.example.com") return send(500, { detail: "boom" });
      return send(404, { detail: "unknown" });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("maps the service's responses to the public shapes", async () => {
    const c = new HttpTrafficEstimator({ serviceUrl: url, timeoutMs: 2000 });
    expect(await c.submit(["Example.com", "bad"], true)).toEqual([
      { input: "Example.com", domain: "example.com", status: "queued", error: null },
      { input: "bad", domain: null, status: "invalid", error: "no dot" },
    ]);
    const state = await c.get("example.com", false);
    expect(state).toEqual({
      domain: "example.com",
      run: { status: "completed", error: null, created_at: "2026-10-01T11:59:40Z", finished_at: "2026-10-01T12:00:00Z" },
      estimate: {
        estimated_monthly_visits: 1200,
        lower_bound: 400,
        upper_bound: 3800,
        traffic_bucket: "1K-10K",
        confidence: "medium",
        confidence_score: 0.55,
        model_version: "heuristic_v2",
        generated_at: "2026-10-01T12:00:00Z",
      },
    });
    expect((await c.get("example.com", true))?.estimate?.details).toEqual({ notes: ["n"] });
    expect(await c.get("unknown.example.com", false)).toBeNull();
    await expect(c.get("bad", false)).rejects.toMatchObject({ code: "INVALID_DOMAIN", message: "Invalid domain: no dot" });
    await expect(c.get("boom.example.com", false)).rejects.toMatchObject({ code: "TRAFFIC_UNAVAILABLE" });
    expect(calls).toContain("POST /domains/bulk");
  });

  it("reports an unreachable service as TRAFFIC_UNAVAILABLE", async () => {
    const c = new HttpTrafficEstimator({ serviceUrl: "http://127.0.0.1:1", timeoutMs: 1000 });
    await expect(c.get("example.com", false)).rejects.toMatchObject({ code: "TRAFFIC_UNAVAILABLE", status: 503 });
  });
});

