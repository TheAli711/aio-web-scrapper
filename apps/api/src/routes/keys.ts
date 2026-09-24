import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { apiKeys } from "../db/repos.js";
import { generateApiKey } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { principalOf } from "../http/auth.js";
import { presentApiKey } from "../http/present.js";
import { ApiKeyCreate, IdParams } from "../http/schemas.js";
import type { AppContext } from "../app.js";

const MAX_ACTIVE_KEYS = 25;

/** API key management is session-only: an API key can never mint or revoke keys. */
export const keyRoutes: FastifyPluginAsyncTypebox<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db } = ctx;
  const sessionOnly = app.authenticate(["session"]);

  app.get("/api/keys", { preValidation: sessionOnly, schema: { hide: true } }, async (req) => {
    const list = await apiKeys.list(db, principalOf(req).userId);
    return { data: list.map(presentApiKey) };
  });

  app.post("/api/keys", { preValidation: sessionOnly, schema: { body: ApiKeyCreate, hide: true } }, async (req, reply) => {
    const userId = principalOf(req).userId;
    const existing = await apiKeys.list(db, userId);
    if (existing.filter((k) => !k.revoked_at).length >= MAX_ACTIVE_KEYS) {
      throw new AppError("LIMIT_EXCEEDED", `At most ${MAX_ACTIVE_KEYS} active API keys are allowed; revoke one first`);
    }
    const { key, prefix, hash } = generateApiKey();
    const row = await apiKeys.create(db, userId, req.body.name.trim(), prefix, hash);
    req.log.info({ event: "api_key.created", userId, apiKeyId: row.id, prefix }, "api key created");
    // The raw key is returned exactly once and never stored.
    return reply.code(201).header("cache-control", "no-store").send({ ...presentApiKey(row), key });
  });

  app.delete("/api/keys/:id", { preValidation: sessionOnly, schema: { params: IdParams, hide: true } }, async (req, reply) => {
    const userId = principalOf(req).userId;
    const ok = await apiKeys.revoke(db, userId, req.params.id);
    if (!ok) throw new AppError("NOT_FOUND", "API key not found or already revoked");
    req.log.info({ event: "api_key.revoked", userId, apiKeyId: req.params.id }, "api key revoked");
    return reply.code(204).send();
  });
};
