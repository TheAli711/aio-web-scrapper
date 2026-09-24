/**
 * Authentication boundary. Two credential types, resolved once per request in onRequest:
 *   - dashboard session cookie  (ws_session, httpOnly, SameSite=Lax; token stored hashed)
 *   - API key                   (Authorization: Bearer wsk_..., stored hashed)
 * Routes then declare which credential types they accept via `app.authenticate([...])`.
 * Firecrawl never sees user credentials; it is reached only from the engine adapter.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import fp from "fastify-plugin";
import type { Db } from "../db/pool.js";
import { apiKeys, sessions } from "../db/repos.js";
import type { Principal } from "../domain.js";
import { parseApiKey, safeEqualHex, sha256Hex } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";

export const SESSION_COOKIE = "ws_session";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyInstance {
    authenticate(accept: Array<Principal["via"]>): preHandlerHookHandler;
  }
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const authPlugin = fp<{ db: Db; appOrigin: string }>(async (app: FastifyInstance, opts) => {
  const { db } = opts;
  const allowedOrigin = new URL(opts.appOrigin).origin;

  app.decorateRequest("principal", null);

  app.addHook("onRequest", async (req) => {
    const header = req.headers.authorization;
    if (header) {
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      const parsed = m ? parseApiKey(m[1]!) : null;
      if (!parsed) throw new AppError("INVALID_API_KEY", "Malformed Authorization header; expected 'Bearer wsk_...'");
      const row = await apiKeys.findActiveByPrefix(db, parsed.prefix);
      if (!row || !safeEqualHex(row.key_hash, sha256Hex(m![1]!))) {
        throw new AppError("INVALID_API_KEY", "API key is invalid or has been revoked");
      }
      req.principal = { userId: row.user_id, email: row.email, via: "api_key", apiKeyId: row.id };
      void apiKeys.touch(db, row.id).catch(() => {});
      return;
    }

    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      const idHash = sha256Hex(token);
      const s = await sessions.findValid(db, idHash);
      if (s) {
        // CSRF: cookie-authenticated state changes must come from our own origin.
        if (UNSAFE_METHODS.has(req.method)) {
          const origin = req.headers.origin;
          if (origin && origin !== allowedOrigin) {
            throw new AppError("FORBIDDEN", "Cross-origin request rejected");
          }
          if (!origin && req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") {
            throw new AppError("FORBIDDEN", "Cross-site request rejected");
          }
        }
        req.principal = { userId: s.user_id, email: s.email, via: "session", sessionId: idHash };
      }
    }
  });

  app.decorate("authenticate", (accept: Array<Principal["via"]>): preHandlerHookHandler => {
    return async (req: FastifyRequest, _reply: FastifyReply) => {
      if (!req.principal) {
        throw new AppError(
          "UNAUTHENTICATED",
          accept.includes("api_key") ? "Authentication required: send 'Authorization: Bearer <API_KEY>'" : "Sign in required",
        );
      }
      if (!accept.includes(req.principal.via)) {
        throw new AppError(
          "FORBIDDEN",
          req.principal.via === "api_key" ? "This endpoint is not available to API keys" : "This endpoint requires an API key",
        );
      }
    };
  });
});

/** Request principal, asserting the route's authenticate() preHandler ran. */
export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw new AppError("UNAUTHENTICATED", "Authentication required");
  return req.principal;
}
