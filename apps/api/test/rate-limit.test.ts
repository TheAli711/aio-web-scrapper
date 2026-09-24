import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiKey, setup, signup, teardown, type TestContext } from "./helpers.js";

let t: TestContext;
beforeAll(async () => {
  t = await setup({ rateLimit: { perMinute: 5, jobCreatePerMinute: 2, authPerMinute: 3 } });
});
afterAll(async () => teardown(t));

describe("rate limiting", () => {
  it("limits requests per API key with a structured 429", async () => {
    const u = await signup(t.app);
    const key = await createApiKey(t.app, u);
    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 7; i++) {
      last = await t.app.inject({ method: "GET", url: "/api/v1/projects", headers: { authorization: `Bearer ${key}` } });
      statuses.push(last.statusCode);
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
    expect(last!.json().error).toMatchObject({ code: "RATE_LIMITED" });
    expect(last!.json().error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(last!.headers["retry-after"]).toBeDefined();
  });

  it("keys are limited independently of each other", async () => {
    const u = await signup(t.app);
    const key = await createApiKey(t.app, u);
    const res = await t.app.inject({ method: "GET", url: "/api/v1/projects", headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(200);
  });

  it("applies a stricter limit to job creation", async () => {
    const u = await signup(t.app);
    const key = await createApiKey(t.app, u);
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await t.app.inject({
        method: "POST",
        url: "/api/v1/scrape",
        headers: { authorization: `Bearer ${key}` },
        payload: { url: `https://example.com/${i}`, project_id: u.projectId },
      });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([202, 202, 429]);
  });

  it("limits login attempts per client IP", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "x@y.dev", password: "whatever-pw" } });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes[3]).toBe(429);
  });
});
