import { createPolicyConfig, type NetPolicyConfig } from "@ws/net-policy";

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback === undefined) throw new Error(`Missing required environment variable ${name}`);
    return fallback;
  }
  return v;
}

function int(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Environment variable ${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export interface Limits {
  maxCrawlPages: number;
  maxCrawlDepth: number;
  maxPatterns: number;
  maxPatternLength: number;
  defaultScrapeTimeoutMs: number;
  maxScrapeTimeoutMs: number;
  maxResultBytes: number;
  maxActiveJobsPerUser: number;
  maxCrawlDurationMs: number;
}

export interface AppConfig {
  env: "development" | "production" | "test";
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  appOrigin: string;
  cookieSecure: boolean;
  sessionTtlHours: number;
  allowSignup: boolean;
  firecrawl: { apiUrl: string; apiKey: string; requestTimeoutMs: number };
  storage: { driver: "local"; localDir: string };
  urlPolicy: NetPolicyConfig;
  limits: Limits;
  rateLimit: { perMinute: number; jobCreatePerMinute: number; authPerMinute: number };
  reconcileIntervalMs: number;
  metricsToken: string;
}

export function loadConfig(): AppConfig {
  const env = (process.env.NODE_ENV ?? "development") as AppConfig["env"];
  return {
    env,
    host: str("API_HOST", "0.0.0.0"),
    port: int("API_PORT", 4000, 1, 65535),
    logLevel: str("LOG_LEVEL", env === "test" ? "silent" : "info"),
    databaseUrl: str("DATABASE_URL"),
    appOrigin: str("APP_ORIGIN", "http://localhost:3000"),
    cookieSecure: bool("COOKIE_SECURE", env === "production"),
    sessionTtlHours: int("SESSION_TTL_HOURS", 24 * 7, 1, 24 * 90),
    allowSignup: bool("ALLOW_SIGNUP", true),
    firecrawl: {
      apiUrl: str("FIRECRAWL_API_URL", "http://localhost:3002").replace(/\/+$/, ""),
      apiKey: str("FIRECRAWL_API_KEY", "self-hosted"),
      requestTimeoutMs: int("FIRECRAWL_REQUEST_TIMEOUT_MS", 30_000, 1000),
    },
    storage: { driver: "local", localDir: str("STORAGE_LOCAL_DIR", "./data/objects") },
    urlPolicy: createPolicyConfig({
      allowHosts: process.env.URL_POLICY_ALLOW_HOSTS ?? "",
      allowedPorts: process.env.URL_POLICY_ALLOWED_PORTS ?? "",
    }),
    limits: {
      maxCrawlPages: int("MAX_CRAWL_PAGES", 500, 1, 100_000),
      maxCrawlDepth: int("MAX_CRAWL_DEPTH", 10, 0, 100),
      maxPatterns: 20,
      maxPatternLength: 200,
      defaultScrapeTimeoutMs: int("DEFAULT_SCRAPE_TIMEOUT_MS", 30_000, 1000),
      maxScrapeTimeoutMs: int("MAX_SCRAPE_TIMEOUT_MS", 90_000, 1000),
      maxResultBytes: int("MAX_RESULT_BYTES", 5 * 1024 * 1024, 1024),
      maxActiveJobsPerUser: int("MAX_ACTIVE_JOBS_PER_USER", 10, 1),
      maxCrawlDurationMs: int("MAX_CRAWL_DURATION_MS", 60 * 60 * 1000, 60_000),
    },
    rateLimit: {
      perMinute: int("RATE_LIMIT_PER_MINUTE", 300, 1),
      jobCreatePerMinute: int("RATE_LIMIT_JOB_CREATE_PER_MINUTE", 30, 1),
      authPerMinute: int("RATE_LIMIT_AUTH_PER_MINUTE", 10, 1),
    },
    reconcileIntervalMs: int("RECONCILE_INTERVAL_MS", 2000, 100),
    metricsToken: str("METRICS_TOKEN", ""),
  };
}
