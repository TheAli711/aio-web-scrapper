/** Write the public OpenAPI document to docs/openapi.json without needing a database or engine. */
import { writeFile } from "node:fs/promises";
import pg from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { NoopMetrics } from "../observability/metrics.js";
import { MemoryStorage } from "../storage/object-storage.js";
import type { ScrapingEngine } from "../engine/types.js";

process.env.DATABASE_URL ??= "postgres://unused/unused";
process.env.LOG_LEVEL ??= "silent";
const config = loadConfig();
const app = await buildApp({
  config,
  db: new pg.Pool({ connectionString: config.databaseUrl }),
  engine: {} as ScrapingEngine,
  storage: new MemoryStorage(),
  metrics: new NoopMetrics(),
});
await app.ready();
const out = new URL("../../../../docs/openapi.json", import.meta.url);
await writeFile(out, JSON.stringify(app.swagger(), null, 2) + "\n");
console.log(`wrote ${out.pathname}`);
await app.close();
process.exit(0);
