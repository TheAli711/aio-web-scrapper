import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { sessions } from "./db/repos.js";
import { HttpBrandingService } from "./engine/branding.js";
import { FirecrawlEngine } from "./engine/firecrawl.js";
import { InMemoryMetrics } from "./observability/metrics.js";
import { LocalFsStorage } from "./storage/object-storage.js";

async function main() {
  const config = loadConfig();
  const db = createPool(config.databaseUrl);
  const engine = new FirecrawlEngine(config.firecrawl);
  const branding = new HttpBrandingService(config.branding);
  const storage = new LocalFsStorage(config.storage.localDir);
  const metrics = new InMemoryMetrics();

  const app = await buildApp({ config, db, engine, branding, storage, metrics });

  if (process.env.MIGRATE_ON_START !== "false") {
    const applied = await migrate(db, (m) => app.log.info(m));
    if (applied.length) app.log.info({ applied }, "database migrated");
  }

  await app.listen({ host: config.host, port: config.port });
  app.ctx.reconciler.start();

  const housekeeping = setInterval(() => {
    sessions.purgeExpired(db).catch((err) => app.log.warn({ err }, "session purge failed"));
  }, 60 * 60 * 1000);

  engine.health().then((ok) => {
    if (!ok) app.log.warn({ url: config.firecrawl.apiUrl }, "scraping engine not reachable yet; jobs will fail until it is up");
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    clearInterval(housekeeping);
    await app.ctx.reconciler.stop();
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", msg: "startup failed", err: String(err?.stack ?? err) }));
  process.exit(1);
});
