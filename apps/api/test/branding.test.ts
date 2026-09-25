import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiKey, setup, signup, teardown, type TestContext, type TestUser } from "./helpers.js";

let t: TestContext;
let user: TestUser;
let auth: Record<string, string>;

beforeAll(async () => {
  t = await setup();
  user = await signup(t.app);
  auth = { authorization: `Bearer ${await createApiKey(t.app, user)}` };
});
afterAll(async () => teardown(t));

const scrapeSync = (payload: Record<string, unknown>) =>
  t.app.inject({ method: "POST", url: "/api/v1/scrape?wait=true", headers: auth, payload: { project_id: user.projectId, ...payload } });

describe("branding format", () => {
  it("returns logo, favicon and brand colors alongside the page content", async () => {
    const res = await scrapeSync({ url: "https://example.com/brand", formats: ["markdown", "branding"] });
    expect(res.statusCode).toBe(200);
    const { job, result } = res.json();
    expect(job.status).toBe("completed");
    expect(result.formats).toEqual(["markdown", "branding"]);
    expect(result.content.markdown).toContain("Hello **world**");
    expect(result.content.branding.colors.primary).toBe("#6B8F71");
    expect(result.content.branding.colors.secondary).toBe("#B4795A");
    expect(result.content.branding.logo.url).toBe("https://example.com/logo.png");
    expect(result.content.branding.favicon.url).toBe("https://example.com/favicon.ico");
    expect(result.content.branding_error).toBeNull();
    expect(t.branding.calls).toContain("https://example.com/brand");
  });

  it("does not call the branding service unless asked", async () => {
    const before = t.branding.calls.length;
    const res = await scrapeSync({ url: "https://example.com/plain" });
    expect(res.json().result.content.branding).toBeUndefined();
    expect(t.branding.calls.length).toBe(before);
  });

  it("keeps the scrape successful when branding fails, and says why", async () => {
    const res = await scrapeSync({ url: "https://brandfail.example.com/", formats: ["markdown", "branding"] });
    const { job, result } = res.json();
    expect(job.status).toBe("completed");
    expect(result.content.markdown).toBeDefined();
    expect(result.content.branding).toBeNull();
    expect(result.content.branding_error.code).toBe("TIMEOUT");
  });

  it("is rejected for crawls", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/crawl",
      headers: auth,
      payload: { project_id: user.projectId, url: "https://example.com/", formats: ["branding"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});
