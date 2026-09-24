import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { withTransaction } from "../db/pool.js";
import { projects, sessions, users } from "../db/repos.js";
import { dummyPasswordHash, hashPassword, randomToken, sha256Hex, verifyPassword } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { SESSION_COOKIE, principalOf } from "../http/auth.js";
import { Credentials, LoginBody } from "../http/schemas.js";
import type { AppContext } from "../app.js";

export const authRoutes: FastifyPluginAsyncTypebox<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, config } = ctx;
  const authLimit = { rateLimit: { max: config.rateLimit.authPerMinute, timeWindow: "1 minute" } };

  const startSession = async (reply: import("fastify").FastifyReply, userId: string, ua: string | undefined, ip: string) => {
    const token = randomToken(32);
    await sessions.create(db, sha256Hex(token), userId, config.sessionTtlHours, ua ?? null, ip);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      path: "/",
      maxAge: config.sessionTtlHours * 3600,
    });
  };

  app.post("/api/auth/signup", { schema: { body: Credentials, tags: ["auth"], hide: true }, config: authLimit }, async (req, reply) => {
    if (!config.allowSignup) throw new AppError("SIGNUP_DISABLED", "Self-service sign-up is disabled on this instance");
    const email = req.body.email.trim();
    if (await users.findByEmail(db, email)) {
      throw new AppError("CONFLICT", "An account with this email already exists");
    }
    const hash = await hashPassword(req.body.password);
    const user = await withTransaction(db, async (tx) => {
      const u = await users.create(tx, email, hash, req.body.name?.trim() || null);
      await projects.create(tx, u.id, "Default project", "Created automatically at sign-up");
      return u;
    });
    await startSession(reply, user.id, req.headers["user-agent"], req.ip);
    req.log.info({ event: "user.signup", userId: user.id }, "user signed up");
    return reply.code(201).send({ user: { id: user.id, email: user.email, name: user.name } });
  });

  app.post("/api/auth/login", { schema: { body: LoginBody, tags: ["auth"], hide: true }, config: authLimit }, async (req, reply) => {
    const user = await users.findByEmail(db, req.body.email.trim());
    // Always run a hash comparison so response time doesn't reveal whether the email exists.
    const ok = await verifyPassword(req.body.password, user?.password_hash ?? (await dummyPasswordHash()));
    if (!user || !ok) {
      req.log.warn({ event: "auth.login_failed" }, "login failed");
      throw new AppError("INVALID_CREDENTIALS", "Invalid email or password");
    }
    await startSession(reply, user.id, req.headers["user-agent"], req.ip);
    req.log.info({ event: "auth.login", userId: user.id }, "user logged in");
    return { user: { id: user.id, email: user.email, name: user.name } };
  });

  app.post("/api/auth/logout", { schema: { hide: true } }, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await sessions.delete(db, sha256Hex(token));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { schema: { hide: true }, preValidation: app.authenticate(["session"]) }, async (req) => {
    const p = principalOf(req);
    const user = await users.findById(db, p.userId);
    if (!user) throw new AppError("UNAUTHENTICATED", "Sign in required");
    return { user: { id: user.id, email: user.email, name: user.name, created_at: user.created_at } };
  });
};
