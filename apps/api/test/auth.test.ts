import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sameOrigin, sessionCookie, setup, signup, teardown, type TestContext } from "./helpers.js";

let t: TestContext;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => teardown(t));

describe("authentication", () => {
  it("signs up, creates a default project and sets an httpOnly session cookie", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "Alice@Example.com", password: "a-long-password" },
    });
    expect(res.statusCode).toBe(201);
    const c = res.cookies.find((x) => x.name === "ws_session")!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe("Lax");
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: sessionCookie(res) } });
    expect(me.json().user.email).toBe("Alice@Example.com");
    const projects = await t.app.inject({ method: "GET", url: "/api/projects", headers: { cookie: sessionCookie(res) } });
    expect(projects.json().data).toHaveLength(1);
  });

  it("never stores the raw password or session token", async () => {
    const { rows } = await t.db.query("SELECT password_hash FROM users WHERE lower(email) = 'alice@example.com'");
    expect(rows[0].password_hash).toMatch(/^scrypt\$/);
    expect(rows[0].password_hash).not.toContain("a-long-password");
    const s = await t.db.query("SELECT id FROM sessions");
    expect(s.rows[0].id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects duplicate emails case-insensitively", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "alice@example.com", password: "another-password" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("validates sign-up input with structured errors", async () => {
    const res = await t.app.inject({ method: "POST", url: "/api/auth/signup", payload: { email: "nope", password: "short" } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details.issues.length).toBeGreaterThan(0);
    expect(body.error.requestId).toBeTruthy();
  });

  it("logs in with the right password and rejects the wrong one with a generic message", async () => {
    const ok = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "alice@example.com", password: "a-long-password" } });
    expect(ok.statusCode).toBe(200);
    const bad = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "alice@example.com", password: "wrong-password" } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toMatchObject({ code: "INVALID_CREDENTIALS", message: "Invalid email or password" });
    const unknown = await t.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "nobody@example.com", password: "whatever-password" } });
    expect(unknown.json().error.message).toBe("Invalid email or password");
  });

  it("logout invalidates the session", async () => {
    const u = await signup(t.app);
    const out = await t.app.inject({ method: "POST", url: "/api/auth/logout", headers: sameOrigin(u.cookie) });
    expect(out.statusCode).toBe(200);
    const me = await t.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: u.cookie } });
    expect(me.statusCode).toBe(401);
  });

  it("requires authentication on protected routes", async () => {
    for (const [method, url] of [
      ["GET", "/api/projects"],
      ["GET", "/api/jobs"],
      ["POST", "/api/scrape"],
      ["GET", "/api/keys"],
      ["GET", "/api/v1/jobs/00000000-0000-0000-0000-000000000000"],
    ] as const) {
      const res = await t.app.inject({ method, url, payload: method === "POST" ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("rejects cookie-authenticated state changes from another origin (CSRF)", async () => {
    const u = await signup(t.app);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie: u.cookie, origin: "https://evil.example" },
      payload: { name: "x" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("honours ALLOW_SIGNUP=false", async () => {
    const closed = await setup({ allowSignup: false });
    try {
      const res = await closed.app.inject({ method: "POST", url: "/api/auth/signup", payload: { email: "x@y.dev", password: "long-enough-pw" } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("SIGNUP_DISABLED");
    } finally {
      await teardown(closed);
    }
  });
});
