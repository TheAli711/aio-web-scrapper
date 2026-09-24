import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiKey, sameOrigin, setup, signup, teardown, waitForJob, type TestContext, type TestUser } from "./helpers.js";

let t: TestContext;
let alice: TestUser;
let bob: TestUser;
let aliceJobId: string;
let aliceResultId: string;

beforeAll(async () => {
  t = await setup();
  alice = await signup(t.app);
  bob = await signup(t.app);
  const res = await t.app.inject({
    method: "POST",
    url: "/api/scrape",
    headers: sameOrigin(alice.cookie),
    payload: { url: "https://example.com/", project_id: alice.projectId },
  });
  aliceJobId = res.json().id;
  await waitForJob(t.app, { cookie: alice.cookie }, aliceJobId);
  const results = await t.app.inject({ method: "GET", url: `/api/jobs/${aliceJobId}/results`, headers: { cookie: alice.cookie } });
  aliceResultId = results.json().data[0].id;
});
afterAll(async () => teardown(t));

describe("project ownership and tenant isolation", () => {
  it("users only see their own projects", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/projects", headers: { cookie: bob.cookie } });
    expect(res.json().data.map((p: { id: string }) => p.id)).toEqual([bob.projectId]);
  });

  it("another user's project is indistinguishable from a missing one", async () => {
    for (const [method, payload] of [
      ["GET", undefined],
      ["PATCH", { name: "pwned" }],
      ["DELETE", undefined],
    ] as const) {
      const res = await t.app.inject({ method, url: `/api/projects/${alice.projectId}`, headers: sameOrigin(bob.cookie), payload });
      expect(res.statusCode, method).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
    }
    const still = await t.app.inject({ method: "GET", url: `/api/projects/${alice.projectId}`, headers: { cookie: alice.cookie } });
    expect(still.json().name).toBe("Default project");
  });

  it("cannot start jobs in another user's project (session or API key)", async () => {
    const viaSession = await t.app.inject({
      method: "POST",
      url: "/api/scrape",
      headers: sameOrigin(bob.cookie),
      payload: { url: "https://example.com/", project_id: alice.projectId },
    });
    expect(viaSession.statusCode).toBe(404);
    const bobKey = await createApiKey(t.app, bob);
    const viaKey = await t.app.inject({
      method: "POST",
      url: "/api/v1/crawl",
      headers: { authorization: `Bearer ${bobKey}` },
      payload: { url: "https://example.com/", project_id: alice.projectId },
    });
    expect(viaKey.statusCode).toBe(404);
    expect(viaKey.json().error.code).toBe("NOT_FOUND");
  });

  it("cannot read, cancel or export another user's jobs and results", async () => {
    const bobKey = await createApiKey(t.app, bob);
    const auth = { authorization: `Bearer ${bobKey}` };
    const urls = [
      ["GET", `/api/v1/jobs/${aliceJobId}`],
      ["GET", `/api/v1/jobs/${aliceJobId}/results`],
      ["POST", `/api/v1/jobs/${aliceJobId}/cancel`],
      ["GET", `/api/v1/jobs/${aliceJobId}/export`],
      ["GET", `/api/v1/results/${aliceResultId}`],
      ["GET", `/api/v1/results/${aliceResultId}/download?format=markdown`],
    ] as const;
    for (const [method, url] of urls) {
      const res = await t.app.inject({ method, url, headers: auth });
      expect(res.statusCode, url).toBe(404);
    }
    const list = await t.app.inject({ method: "GET", url: "/api/jobs", headers: { cookie: bob.cookie } });
    expect(list.json().data).toHaveLength(0);
    const results = await t.app.inject({ method: "GET", url: "/api/results", headers: { cookie: bob.cookie } });
    expect(results.json().data).toHaveLength(0);
  });

  it("the database rejects a job whose project belongs to someone else", async () => {
    await expect(
      t.db.query(`INSERT INTO jobs (project_id, user_id, type, target_url) VALUES ($1, $2, 'scrape', 'https://x.dev')`, [
        alice.projectId,
        bob.userId,
      ]),
    ).rejects.toThrow(/foreign key/);
  });

  it("deleting a project removes its jobs, results and stored content", async () => {
    const p = await t.app.inject({ method: "POST", url: "/api/projects", headers: sameOrigin(alice.cookie), payload: { name: "temp" } });
    const pid = p.json().id;
    const job = await t.app.inject({
      method: "POST",
      url: "/api/scrape",
      headers: sameOrigin(alice.cookie),
      payload: { url: "https://example.com/x", project_id: pid },
    });
    await waitForJob(t.app, { cookie: alice.cookie }, job.json().id);
    const keysBefore = [...t.storage.objects.keys()].filter((k) => k.includes(job.json().id));
    expect(keysBefore.length).toBe(1);
    const del = await t.app.inject({ method: "DELETE", url: `/api/projects/${pid}`, headers: sameOrigin(alice.cookie) });
    expect(del.statusCode).toBe(204);
    expect([...t.storage.objects.keys()].filter((k) => k.includes(job.json().id))).toHaveLength(0);
    const gone = await t.app.inject({ method: "GET", url: `/api/jobs/${job.json().id}`, headers: { cookie: alice.cookie } });
    expect(gone.statusCode).toBe(404);
  });
});
