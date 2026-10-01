/**
 * Traffic estimate routes. Registered like the job routes:
 *   /api/...     dashboard (session cookie) and API keys
 *   /api/v1/...  the documented public API (API keys only)
 * Estimates come from the internal traffic-estimator service (engine/traffic.ts). They are per
 * domain and shared between users; requesting one never exposes anything user-specific.
 */
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import type { AppContext } from "../app.js";
import type { Principal } from "../domain.js";
import type { TrafficEstimator, TrafficState } from "../engine/traffic.js";
import { principalOf } from "../http/auth.js";
import { presentTraffic, TRAFFIC_DISCLAIMER } from "../http/present.js";
import {
  ErrorBody,
  TrafficBody,
  TrafficBulkBody,
  TrafficBulkRequest,
  TrafficCreateQuery,
  TrafficGetQuery,
  TrafficParams,
  TrafficRequest,
} from "../http/schemas.js";
import { AppError } from "../lib/errors.js";

export interface TrafficRouteOptions {
  ctx: AppContext;
  base: "/api" | "/api/v1";
  accept: Array<Principal["via"]>;
  /** Include in the OpenAPI document. */
  public: boolean;
}

const errorResponses = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 429: ErrorBody, 503: ErrorBody };
const POLL_MS = 1000;
const BULK_LOOKUP_CONCURRENCY = 8;

/** Ready, or failed: nothing left to wait for. */
const settled = (s: TrafficState) => {
  const p = presentTraffic(s);
  return p.status !== "pending" && !p.refreshing;
};

export const trafficRoutes: FastifyPluginAsyncTypebox<TrafficRouteOptions> = async (app, opts) => {
  const { ctx, base } = opts;
  const auth = app.authenticate(opts.accept);
  const hide = !opts.public;
  const tags = ["traffic"];
  const security = [{ bearerAuth: [] }];
  const createLimit = { rateLimit: { max: ctx.config.rateLimit.jobCreatePerMinute, timeWindow: "1 minute" } };

  const estimator = (): TrafficEstimator => {
    if (!ctx.traffic) throw new AppError("TRAFFIC_UNAVAILABLE", "Traffic estimation is not enabled on this server");
    return ctx.traffic;
  };
  const present = (s: TrafficState) => ({ ...presentTraffic(s, base), disclaimer: TRAFFIC_DISCLAIMER });

  app.post(
    `${base}/traffic`,
    {
      preValidation: auth,
      config: createLimit,
      schema: {
        hide,
        tags,
        security,
        summary: "Estimate a website's monthly visits",
        description:
          "Starts an estimate for the domain, or returns the existing one if it is less than 7 days old (`refresh: true` forces new data). " +
          "Returns 200 when the estimate is ready and 202 while it is being computed; poll `GET /traffic/{domain}`. " +
          "With `?wait=true` the request blocks until it is ready (a new domain usually takes 10-30 s). " +
          "Estimates are inferred from public signals, not measured traffic.",
        querystring: TrafficCreateQuery,
        body: TrafficRequest,
        response: { 200: TrafficBody, 202: TrafficBody, ...errorResponses },
      },
    },
    async (req, reply) => {
      principalOf(req);
      const t = estimator();
      const [sub] = await t.submit([req.body.domain], req.body.refresh ?? false);
      if (!sub?.domain || sub.status === "invalid") throw new AppError("INVALID_DOMAIN", `Invalid domain: ${sub?.error ?? "not a valid domain"}`);
      let state = await t.get(sub.domain, false);
      if (req.query.wait) {
        const deadline = Date.now() + ctx.config.traffic.waitMs;
        while (state && !settled(state) && Date.now() < deadline && !req.socket.destroyed) {
          await new Promise((r) => setTimeout(r, POLL_MS));
          state = await t.get(sub.domain, false);
        }
      }
      if (state && req.query.details) state = (await t.get(sub.domain, true)) ?? state;
      if (!state) throw new AppError("TRAFFIC_UNAVAILABLE", "The traffic estimator lost the request; retry");
      const done = settled(state);
      if (!done) reply.header("location", `${base}/traffic/${state.domain}`);
      return reply.code(done ? 200 : 202).send(present(state));
    },
  );

  app.get(
    `${base}/traffic/:domain`,
    {
      preValidation: auth,
      schema: {
        hide,
        tags,
        security,
        summary: "Get a domain's traffic estimate",
        description:
          "The latest estimate for a domain requested earlier with `POST /traffic` (by anyone: estimates describe public sites and are shared). " +
          "`status` is `pending` until the first estimate exists; `refreshing` is true while a newer one is computed. 404 if never requested.",
        params: TrafficParams,
        querystring: TrafficGetQuery,
        response: { 200: TrafficBody, ...errorResponses },
      },
    },
    async (req) => {
      principalOf(req);
      const state = await estimator().get(req.params.domain, req.query.details ?? false);
      if (!state) {
        throw new AppError("NOT_FOUND", `No traffic estimate for ${req.params.domain} yet; request one with POST ${base}/traffic`);
      }
      return present(state);
    },
  );

  app.post(
    `${base}/traffic/bulk`,
    {
      preValidation: auth,
      config: createLimit,
      schema: {
        hide,
        tags,
        security,
        summary: "Estimate up to 100 websites at once",
        description:
          "Submits every domain like `POST /traffic` and answers at once (202): domains estimated in the last 7 days come back `ready`, " +
          "new ones `pending` (poll `GET /traffic/{domain}`), unusable input `invalid`. Items keep the order of `domains`.",
        body: TrafficBulkRequest,
        response: { 202: TrafficBulkBody, ...errorResponses },
      },
    },
    async (req, reply) => {
      principalOf(req);
      const t = estimator();
      const subs = await t.submit(req.body.domains, req.body.refresh ?? false);
      const domains = [...new Set(subs.filter((s) => s.domain && s.status !== "invalid").map((s) => s.domain!))];
      const states = new Map<string, TrafficState | null>();
      for (let i = 0; i < domains.length; i += BULK_LOOKUP_CONCURRENCY) {
        const chunk = domains.slice(i, i + BULK_LOOKUP_CONCURRENCY);
        const got = await Promise.all(chunk.map((d) => t.get(d, false)));
        chunk.forEach((d, j) => states.set(d, got[j] ?? null));
      }
      const data = subs.map((s) => {
        const state = s.domain && s.status !== "invalid" ? states.get(s.domain) : null;
        if (!state) {
          return {
            input: s.input,
            domain: s.domain,
            status: "invalid" as const,
            refreshing: false,
            estimate: null,
            error: { code: "INVALID_DOMAIN", message: `Invalid domain: ${s.error ?? "not a valid domain"}` },
            links: null,
          };
        }
        return { input: s.input, ...presentTraffic(state, base) };
      });
      return reply.code(202).send({ data, disclaimer: TRAFFIC_DISCLAIMER });
    },
  );
};
