import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { projects } from "../db/repos.js";
import { AppError } from "../lib/errors.js";
import { principalOf } from "../http/auth.js";
import { presentProject } from "../http/present.js";
import { IdParams, ProjectCreate, ProjectUpdate } from "../http/schemas.js";
import type { AppContext } from "../app.js";

export const projectRoutes: FastifyPluginAsyncTypebox<{ ctx: AppContext }> = async (app, { ctx }) => {
  const { db, storage } = ctx;
  const any = app.authenticate(["session", "api_key"]);
  const sessionOnly = app.authenticate(["session"]);

  app.get("/api/projects", { preValidation: any, schema: { hide: true } }, async (req) => {
    const list = await projects.list(db, principalOf(req).userId);
    return { data: list.map(presentProject) };
  });

  app.post("/api/projects", { preValidation: sessionOnly, schema: { body: ProjectCreate, hide: true } }, async (req, reply) => {
    const p = await projects.create(db, principalOf(req).userId, req.body.name.trim(), req.body.description ?? null);
    return reply.code(201).send(presentProject(p));
  });

  app.get("/api/projects/:id", { preValidation: any, schema: { params: IdParams, hide: true } }, async (req) => {
    const p = await projects.get(db, principalOf(req).userId, req.params.id);
    if (!p) throw new AppError("NOT_FOUND", "Project not found");
    return presentProject(p);
  });

  app.patch(
    "/api/projects/:id",
    { preValidation: sessionOnly, schema: { params: IdParams, body: ProjectUpdate, hide: true } },
    async (req) => {
      const p = await projects.update(db, principalOf(req).userId, req.params.id, {
        name: req.body.name?.trim(),
        description: req.body.description,
      });
      if (!p) throw new AppError("NOT_FOUND", "Project not found");
      return presentProject(p);
    },
  );

  app.delete("/api/projects/:id", { preValidation: sessionOnly, schema: { params: IdParams, hide: true } }, async (req, reply) => {
    const userId = principalOf(req).userId;
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM jobs WHERE project_id = $1 AND user_id = $2`, [
      req.params.id,
      userId,
    ]);
    const ok = await projects.delete(db, userId, req.params.id);
    if (!ok) throw new AppError("NOT_FOUND", "Project not found");
    // DB rows cascade; remove the result blobs of every job that belonged to the project.
    for (const j of rows) {
      await storage.deletePrefix(`users/${userId}/jobs/${j.id}/`).catch((err) => req.log.warn({ err }, "blob cleanup failed"));
    }
    return reply.code(204).send();
  });
};
