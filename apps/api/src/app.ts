import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { randomUUID } from "node:crypto";
import type { Resolver } from "@ws/net-policy";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/pool.js";
import { projects } from "./db/repos.js";
import type { ScrapingEngine } from "./engine/types.js";
import { authPlugin, principalOf } from "./http/auth.js";
import { presentProject } from "./http/present.js";
import { AppError } from "./lib/errors.js";
import type { Metrics } from "./observability/metrics.js";
import { authRoutes } from "./routes/auth.js";
import { jobRoutes } from "./routes/jobs.js";
import { keyRoutes } from "./routes/keys.js";
import { projectRoutes } from "./routes/projects.js";
import { JobService } from "./services/jobs.js";
import { Reconciler } from "./services/reconciler.js";
import { ResultService } from "./services/results.js";
import type { ObjectStorage } from "./storage/object-storage.js";

export interface AppDeps {
  config: AppConfig;
  db: Db;
  engine: ScrapingEngine;
  storage: ObjectStorage;
  metrics: Metrics;
  /** Override DNS for tests. */
  resolver?: Resolver;
}

export interface AppContext extends AppDeps {
  jobsSvc: JobService;
  resultsSvc: ResultService;
  reconciler: Reconciler;
}

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

// <repo>/docs/agent-guide.md, from both src/ (dev) and dist/ (build); the Dockerfile copies it.
const AGENT_GUIDE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs/agent-guide.md");

// Redact anything credential-shaped from structured logs.
const REDACT = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['proxy-authorization']",
  "res.headers['set-cookie']",
  "*.password",
  "*.key",
  "*.token",
];

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, engine, storage, metrics } = deps;

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: REDACT, censor: "[redacted]" },
    },
    genReqId: (req) => {
      const incoming = req.headers["x-request-id"];
      return typeof incoming === "string" && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    },
    // Honour X-Forwarded-For only from private-network hops (the Next.js dashboard / ingress),
    // so internet clients cannot spoof their IP to dodge rate limits.
    trustProxy: "loopback,linklocal,uniquelocal",
    bodyLimit: 256 * 1024,
    requestTimeout: 120_000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: "array", useDefaults: true } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  const log: FastifyBaseLogger = app.log;
  const resultsSvc = new ResultService(db, storage, config.limits.maxResultBytes);
  const jobsSvc = new JobService(db, engine, resultsSvc, metrics, log, config.limits, config.urlPolicy, deps.resolver);
  const reconciler = new Reconciler(db, engine, jobsSvc, resultsSvc, metrics, log, config.limits, config.reconcileIntervalMs);
  const ctx: AppContext = { ...deps, jobsSvc, resultsSvc, reconciler };
  app.decorate("ctx", ctx);

  // ------------------------------------------------------------------ errors

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    let status: number;
    let code: string;
    let message: string;
    let details: Record<string, unknown> | undefined;

    if (err instanceof AppError) {
      ({ status, code, message, details } = err);
    } else if ((err as FastifyError).validation) {
      status = 400;
      code = "VALIDATION_ERROR";
      message = "Request validation failed";
      details = {
        issues: (err as FastifyError).validation!.map((v) => ({
          path: `${(err as FastifyError).validationContext ?? ""}${v.instancePath}`,
          message: v.message,
          ...(v.params && "additionalProperty" in v.params ? { field: v.params.additionalProperty } : {}),
        })),
      };
    } else if ((err as FastifyError).statusCode === 429) {
      status = 429;
      code = "RATE_LIMITED";
      message = err.message;
    } else if ((err as FastifyError).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      status = 413;
      code = "VALIDATION_ERROR";
      message = "Request body too large";
    } else if ((err as FastifyError).code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || (err as FastifyError).code === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      status = 400;
      code = "VALIDATION_ERROR";
      message = "Request body must be JSON";
    } else if ((err as FastifyError).statusCode === 400) {
      status = 400;
      code = "VALIDATION_ERROR";
      message = "Malformed request";
    } else {
      status = 500;
      code = "INTERNAL_ERROR";
      message = "An internal error occurred. Quote the requestId when reporting this.";
      req.log.error({ err }, "unhandled error");
    }

    metrics.increment("api_errors_total", { code, status });
    if (status < 500) req.log.info({ code, status }, "request rejected");
    return reply.code(status).send({ error: { code, message, ...(details ? { details } : {}), requestId: req.id } });
  });

  app.setNotFoundHandler((req, reply) => {
    metrics.increment("api_errors_total", { code: "NOT_FOUND", status: 404 });
    return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url.split("?")[0]} not found`, requestId: req.id } });
  });

  // ------------------------------------------------------------------ http metrics

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unmatched";
    metrics.increment("http_requests_total", { method: req.method, route, status: reply.statusCode });
    metrics.observe("http_request_duration_ms", reply.elapsedTime, { method: req.method, route });
  });
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  // ------------------------------------------------------------------ plugins

  await app.register(cookie);
  await app.register(authPlugin, { db, appOrigin: config.appOrigin });
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.perMinute,
    timeWindow: "1 minute",
    keyGenerator: (req) =>
      req.principal?.apiKeyId ? `key:${req.principal.apiKeyId}` : req.principal ? `user:${req.principal.userId}` : `ip:${req.ip}`,
    errorResponseBuilder: (_req, ctx) =>
      new AppError("RATE_LIMITED", `Rate limit exceeded: ${ctx.max} requests per ${ctx.after}. Retry after ${Math.ceil(ctx.ttl / 1000)}s.`, {
        limit: ctx.max,
        retryAfterSeconds: Math.ceil(ctx.ttl / 1000),
      }),
    allowList: (req) => req.url === "/healthz" || req.url === "/readyz",
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Web Scraper Public API",
        version: "1.0.0",
        description:
          "Authenticate with `Authorization: Bearer <API_KEY>`. Create keys in the dashboard under API keys. " +
          "Jobs are asynchronous: create, poll `GET /api/v1/jobs/{id}`, then read results. " +
          "Errors always have the shape `{ error: { code, message, details?, requestId } }`.",
      },
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "wsk_..." } } },
      tags: [
        { name: "jobs", description: "Scrape and crawl jobs" },
        { name: "results", description: "Page results" },
        { name: "projects", description: "Projects" },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/api/v1/docs", staticCSP: true });
  app.get("/api/v1/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  // Agent-oriented Markdown guide (llms.txt convention). Public, like the OpenAPI document.
  const guide = await readFile(AGENT_GUIDE_PATH, "utf8").catch(() => null);
  const serveGuide = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!guide) throw new AppError("NOT_FOUND", "Agent guide is not bundled with this build");
    const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() ?? req.headers.host ?? "localhost:4000";
    const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ?? req.protocol;
    return reply.header("content-type", "text/markdown; charset=utf-8").send(guide.replaceAll("{{BASE_URL}}", `${proto}://${host}`));
  };
  app.get("/api/v1/llms.txt", { schema: { hide: true } }, serveGuide);
  app.get("/api/v1/guide.md", { schema: { hide: true } }, serveGuide);

  // ------------------------------------------------------------------ routes

  await app.register(authRoutes, { ctx });
  await app.register(projectRoutes, { ctx });
  await app.register(keyRoutes, { ctx });
  await app.register(jobRoutes, { ctx, base: "/api", accept: ["session", "api_key"], public: false });
  await app.register(jobRoutes, { ctx, base: "/api/v1", accept: ["api_key"], public: true });

  app.get(
    "/api/v1/projects",
    {
      preValidation: app.authenticate(["api_key"]),
      schema: { tags: ["projects"], security: [{ bearerAuth: [] }], summary: "List your projects (to find a project_id)" },
    },
    async (req) => ({ data: (await projects.list(db, principalOf(req).userId)).map(presentProject) }),
  );

  // ------------------------------------------------------------------ system

  // Probes are polled constantly; keep them out of the request log.
  app.get("/healthz", { schema: { hide: true }, logLevel: "warn" }, async () => ({ ok: true }));

  app.get("/readyz", { schema: { hide: true }, logLevel: "warn" }, async (_req, reply) => {
    const [dbOk, engineOk] = await Promise.all([
      db.query("SELECT 1").then(() => true, () => false),
      engine.health(),
    ]);
    return reply.code(dbOk && engineOk ? 200 : 503).send({ database: dbOk, engine: engineOk });
  });

  app.get("/metrics", { schema: { hide: true }, config: { rateLimit: false } }, async (req, reply) => {
    if (config.metricsToken) {
      const ok = req.headers.authorization === `Bearer ${config.metricsToken}`;
      if (!ok) throw new AppError("UNAUTHENTICATED", "Metrics token required");
    } else if (config.env === "production") {
      throw new AppError("FORBIDDEN", "Set METRICS_TOKEN to expose metrics in production");
    }
    const active = await db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM jobs WHERE status IN ('queued','running') GROUP BY status`,
    );
    for (const s of ["queued", "running"]) {
      metrics.gauge("jobs_active", active.rows.find((r) => r.status === s)?.n ?? 0, { status: s });
    }
    return reply.header("content-type", "text/plain; version=0.0.4").send(metrics.render());
  });

  return app;
}
