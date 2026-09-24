import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createPolicyConfig, type Resolver } from "@ws/net-policy";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";
import { createPool, type Db } from "../src/db/pool.js";
import type { CrawlJobOptions, ScrapeJobOptions } from "../src/domain.js";
import type { CrawlSnapshot, PageResult, ScrapingEngine } from "../src/engine/types.js";
import { InMemoryMetrics } from "../src/observability/metrics.js";
import { MemoryStorage } from "../src/storage/object-storage.js";

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://webscraper:webscraper@localhost:5433/webscraper_test";

/** DNS stub: public names resolve publicly, "rebind.example" resolves to a private address. */
export const fakeResolver: Resolver = async (host) => {
  const table: Record<string, string[]> = {
    "example.com": ["93.184.215.14"],
    "docs.example.com": ["93.184.215.15"],
    "notfound.example.com": ["93.184.215.16"],
    "slow.example.com": ["93.184.215.17"],
    "site.example.com": ["93.184.215.18"],
    "rebind.example": ["10.0.0.7"],
    "mixed.example": ["93.184.215.19", "127.0.0.1"],
  };
  const r = table[host];
  if (!r) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return r;
};

/** Deterministic in-process ScrapingEngine used by API tests. */
export class FakeEngine implements ScrapingEngine {
  readonly name = "fake";
  crawls = new Map<string, { url: string; options: CrawlJobOptions; pages: PageResult[]; failures: PageResult[]; status: CrawlSnapshot["status"]; released: number }>();
  cancelled: string[] = [];
  scrapeDelayMs = 0;
  healthy = true;
  private seq = 0;

  static page(url: string, status = 200): PageResult {
    const ok = status < 400;
    return {
      url,
      statusCode: status,
      title: ok ? `Title of ${url}` : `${status}`,
      success: ok,
      error: ok ? undefined : { code: "HTTP_ERROR", message: `Target responded with HTTP ${status}` },
      markdown: `# Page ${url}\n\nHello **world**.`,
      html: `<html><body><h1>Page ${url}</h1><p>Hello <b>world</b>.</p></body></html>`,
      links: [`${url}#a`, "https://example.com/other"],
      metadata: { description: "desc", language: "en" },
    };
  }

  async scrape(url: string, _o: ScrapeJobOptions, signal?: AbortSignal): Promise<PageResult> {
    if (this.scrapeDelayMs) {
      await new Promise((r, rej) => {
        const t = setTimeout(r, this.scrapeDelayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          rej(new Error("aborted"));
        });
      }).catch(() => undefined);
      if (signal?.aborted) return { url, success: false, error: { code: "INTERRUPTED", message: "cancelled" }, metadata: {} };
    }
    const host = new URL(url).hostname;
    if (host === "notfound.example.com") return FakeEngine.page(url, 404);
    if (host === "slow.example.com") {
      return { url, success: false, error: { code: "TIMEOUT", message: "The page did not finish loading within the timeout" }, metadata: {} };
    }
    return FakeEngine.page(url);
  }

  async crawl(url: string, options: CrawlJobOptions) {
    const id = `crawl-${++this.seq}`;
    const pages = [
      FakeEngine.page(url),
      FakeEngine.page(new URL("/a", url).href),
      FakeEngine.page(new URL("/b", url).href),
      FakeEngine.page(new URL("/missing", url).href, 404),
    ].slice(0, options.maxPages);
    const failures: PageResult[] = [
      { url: new URL("/broken", url).href, success: false, error: { code: "CONNECTION_FAILED", message: "The page could not be fetched" }, metadata: {} },
    ];
    this.crawls.set(id, { url, options, pages, failures, status: "running", released: 0 });
    return { engineJobId: id };
  }

  /** Test control: make `n` more pages visible, optionally finishing the crawl. */
  advance(id: string, n: number, finish = false) {
    const c = this.crawls.get(id)!;
    c.released = Math.min(c.pages.length, c.released + n);
    if (finish) c.status = "completed";
  }

  async getJobStatus(id: string, cursor: number): Promise<CrawlSnapshot> {
    const c = this.crawls.get(id);
    if (!c) return { status: "failed", discovered: 0, processed: 0, pages: [], nextCursor: cursor, hasMore: false };
    const visible = c.pages.slice(0, c.released);
    const pages = visible.slice(cursor);
    return {
      status: c.status,
      discovered: c.pages.length,
      processed: visible.length,
      pages,
      nextCursor: cursor + pages.length,
      hasMore: false,
    };
  }

  async getFailures(id: string) {
    return this.crawls.get(id)?.failures ?? [];
  }

  async cancel(id: string) {
    this.cancelled.push(id);
    const c = this.crawls.get(id);
    if (c) c.status = "cancelled";
  }

  async health() {
    return this.healthy;
  }
}

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  engine: FakeEngine;
  storage: MemoryStorage;
  metrics: InMemoryMetrics;
  config: AppConfig;
}

let migrated = false;

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    env: "test",
    host: "127.0.0.1",
    port: 0,
    logLevel: process.env.TEST_LOG_LEVEL ?? "silent",
    databaseUrl: TEST_DB_URL,
    appOrigin: "http://localhost:3000",
    cookieSecure: false,
    sessionTtlHours: 1,
    allowSignup: true,
    firecrawl: { apiUrl: "http://unused", apiKey: "x", requestTimeoutMs: 1000 },
    storage: { driver: "local", localDir: "/tmp/unused" },
    urlPolicy: createPolicyConfig(),
    limits: {
      maxCrawlPages: 100,
      maxCrawlDepth: 5,
      maxPatterns: 20,
      maxPatternLength: 200,
      defaultScrapeTimeoutMs: 30000,
      maxScrapeTimeoutMs: 60000,
      maxResultBytes: 1024 * 1024,
      maxActiveJobsPerUser: 5,
      maxCrawlDurationMs: 3600000,
    },
    rateLimit: { perMinute: 1000, jobCreatePerMinute: 1000, authPerMinute: 1000 },
    reconcileIntervalMs: 60_000,
    metricsToken: "",
    ...overrides,
  };
}

export async function setup(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  const config = testConfig(overrides);
  const db = createPool(config.databaseUrl);
  if (!migrated) {
    await migrate(db);
    migrated = true;
  }
  await db.query("TRUNCATE users, sessions, projects, api_keys, jobs, results, job_events RESTART IDENTITY CASCADE");
  const engine = new FakeEngine();
  const storage = new MemoryStorage();
  const metrics = new InMemoryMetrics();
  const app = await buildApp({ config, db, engine, storage, metrics, resolver: fakeResolver });
  await app.ready();
  return { app, db, engine, storage, metrics, config };
}

export async function teardown(ctx: TestContext) {
  await ctx.app.ctx.reconciler.stop();
  await ctx.app.close();
  await ctx.db.end();
}

export interface TestUser {
  cookie: string;
  userId: string;
  email: string;
  projectId: string;
}

let userSeq = 0;

/** Sign up a fresh user; returns its session cookie and default project id. */
export async function signup(app: FastifyInstance, email = `user${++userSeq}-${Date.now()}@test.dev`): Promise<TestUser> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    headers: { origin: "http://localhost:3000" },
    payload: { email, password: "correct horse battery" },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const cookie = sessionCookie(res);
  const projects = await app.inject({ method: "GET", url: "/api/projects", headers: { cookie } });
  return { cookie, userId: res.json().user.id, email, projectId: projects.json().data[0].id };
}

export function sessionCookie(res: LightMyRequestResponse): string {
  const c = res.cookies.find((x) => x.name === "ws_session");
  if (!c) throw new Error("no session cookie");
  return `ws_session=${c.value}`;
}

export async function createApiKey(app: FastifyInstance, user: TestUser, name = "test key"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/keys",
    headers: { cookie: user.cookie, origin: "http://localhost:3000" },
    payload: { name },
  });
  if (res.statusCode !== 201) throw new Error(`key create failed: ${res.body}`);
  return res.json().key;
}

/** Wait until the job reaches a terminal state (dispatch runs in the background). */
export async function waitForJob(app: FastifyInstance, headers: Record<string, string>, id: string, base = "/api", timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    const res = await app.inject({ method: "GET", url: `${base}/jobs/${id}`, headers });
    const job = res.json();
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${id} still ${job.status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const sameOrigin = (cookie: string) => ({ cookie, origin: "http://localhost:3000" });
