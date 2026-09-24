import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiKey, sameOrigin, setup, signup, teardown, type TestContext, type TestUser } from "./helpers.js";

let t: TestContext;
let user: TestUser;
beforeAll(async () => {
  t = await setup();
  user = await signup(t.app);
});
afterAll(async () => teardown(t));

describe("API keys", () => {
  it("shows the secret once and stores only a hash", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/keys", headers: sameOrigin(user.cookie), payload: { name: "ci" } });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const { key, prefix, id } = res.json();
    expect(key).toMatch(/^wsk_[0-9A-Za-z]{8}_[0-9A-Za-z]{40}$/);
    expect(key.startsWith(prefix)).toBe(true);

    const list = await t.app.inject({ method: "GET", url: "/api/keys", headers: { cookie: user.cookie } });
    const listed = list.json().data.find((k: { id: string }) => k.id === id);
    expect(listed).toMatchObject({ name: "ci", prefix, active: true });
    expect(JSON.stringify(list.json())).not.toContain(key);

    const { rows } = await t.db.query("SELECT key_hash FROM api_keys WHERE id = $1", [id]);
    expect(rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].key_hash).not.toContain(key);
  });

  it("authenticates public API calls with Authorization: Bearer", async () => {
    const key = await createApiKey(t.app, user);
    const res = await t.app.inject({ method: "GET", url: "/api/v1/projects", headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].id).toBe(user.projectId);
    const { rows } = await t.db.query("SELECT last_used_at FROM api_keys WHERE prefix = $1", [key.slice(0, 12)]);
    await new Promise((r) => setTimeout(r, 50));
    expect(rows).toHaveLength(1);
  });

  it("rejects malformed, unknown and tampered keys", async () => {
    const key = await createApiKey(t.app, user);
    const tampered = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
    for (const header of ["Bearer nope", "Basic abc", `Bearer ${tampered}`, "Bearer wsk_AAAAAAAA_" + "A".repeat(40)]) {
      const res = await t.app.inject({ method: "GET", url: "/api/v1/projects", headers: { authorization: header } });
      expect(res.statusCode, header).toBe(401);
      expect(res.json().error.code).toBe("INVALID_API_KEY");
    }
  });

  it("revoked keys stop working immediately", async () => {
    const create = await t.app.inject({ method: "POST", url: "/api/keys", headers: sameOrigin(user.cookie), payload: { name: "temp" } });
    const { key, id } = create.json();
    const del = await t.app.inject({ method: "DELETE", url: `/api/keys/${id}`, headers: sameOrigin(user.cookie) });
    expect(del.statusCode).toBe(204);
    const res = await t.app.inject({ method: "GET", url: "/api/v1/projects", headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(401);
    const again = await t.app.inject({ method: "DELETE", url: `/api/keys/${id}`, headers: sameOrigin(user.cookie) });
    expect(again.statusCode).toBe(404);
  });

  it("an API key cannot manage API keys (no privilege escalation)", async () => {
    const key = await createApiKey(t.app, user);
    const res = await t.app.inject({ method: "POST", url: "/api/keys", headers: { authorization: `Bearer ${key}` }, payload: { name: "x" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("a user cannot revoke another user's key", async () => {
    const other = await signup(t.app);
    const create = await t.app.inject({ method: "POST", url: "/api/keys", headers: sameOrigin(user.cookie), payload: { name: "mine" } });
    const res = await t.app.inject({ method: "DELETE", url: `/api/keys/${create.json().id}`, headers: sameOrigin(other.cookie) });
    expect(res.statusCode).toBe(404);
  });

  it("the public /api/v1 surface requires an API key, not a session", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie: user.cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/API key/);
  });
});
