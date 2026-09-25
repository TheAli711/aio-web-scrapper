/**
 * brand-service: internal HTTP service that extracts branding (logo, favicon, colors, fonts).
 *
 *   POST /v1/brand  {"url": "https://...", "timeout_ms": 45000}  -> BrandResult
 *   GET  /healthz
 *
 * Runs on the internal backend network only. Chromium sends every request, including loopback,
 * through egress-proxy, so the same SSRF policy applies as for the scraping engine.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chromium, type Browser } from "playwright";
import { BrandError, extractBrand } from "./brand.js";

const PORT = Number(process.env.PORT ?? 4100);
const HOST = process.env.HOST ?? "0.0.0.0";
const MAX_CONCURRENCY = Number(process.env.BRAND_MAX_CONCURRENCY ?? 3);
const MAX_TIMEOUT_MS = Number(process.env.BRAND_MAX_TIMEOUT_MS ?? 90_000);
const PROXY_SERVER = process.env.PROXY_SERVER ?? "";

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let userAgent = process.env.BRAND_USER_AGENT ?? "";

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  launching ??= (async () => {
    const b = await chromium.launch({
      // Full Chromium in new headless mode (closer to a real browser than headless-shell).
      channel: "chromium",
      headless: true,
      proxy: PROXY_SERVER
        ? { server: PROXY_SERVER, username: process.env.PROXY_USERNAME, password: process.env.PROXY_PASSWORD, bypass: "" }
        : undefined,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        // Chromium never proxies loopback by default; force it through egress-proxy (which denies it).
        "--proxy-bypass-list=<-loopback>",
      ],
    });
    // A UA that matches the actual browser (no "HeadlessChrome"), so bot walls see no mismatch.
    if (!userAgent) {
      const major = b.version().split(".")[0];
      userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    }
    b.on("disconnected", () => {
      browser = null;
    });
    browser = b;
    return b;
  })().finally(() => {
    launching = null;
  });
  return launching;
}

// Simple semaphore: pages are memory-heavy, keep a bounded number in flight.
let active = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENCY) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      return send(res, 200, { ok: true, browser: !!browser?.isConnected(), active, queued: waiters.length });
    }
    if (req.method === "POST" && req.url === "/v1/brand") {
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: { code: "VALIDATION_ERROR", message: "Invalid JSON body" } });
      }
      const url = typeof body.url === "string" ? body.url : "";
      if (!/^https?:\/\//i.test(url)) return send(res, 400, { error: { code: "INVALID_URL", message: "url must be http(s)" } });
      const timeoutMs = Math.min(Math.max(Number(body.timeout_ms) || 45_000, 5_000), MAX_TIMEOUT_MS);
      try {
        const result = await withSlot(async () => extractBrand(await getBrowser(), url, { timeoutMs, userAgent, includeScreenshot: body.include_screenshot === true }));
        return send(res, 200, result);
      } catch (err) {
        if (err instanceof BrandError) {
          return send(res, 422, { error: { code: err.code, message: err.message, status_code: err.statusCode ?? null } });
        }
        console.error("brand extraction failed", err);
        return send(res, 500, { error: { code: "EXTRACTION_FAILED", message: "Branding extraction failed" } });
      }
    }
    send(res, 404, { error: { code: "NOT_FOUND", message: "Not found" } });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: { code: "INTERNAL_ERROR", message: "Internal error" } });
  }
});

server.requestTimeout = MAX_TIMEOUT_MS + 30_000;
server.listen(PORT, HOST, () => {
  console.log(`brand-service listening on ${HOST}:${PORT} (proxy: ${PROXY_SERVER ? "on" : "OFF"})`);
  getBrowser().catch((e) => console.error("browser launch failed", e));
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    server.close();
    await browser?.close().catch(() => {});
    process.exit(0);
  });
}
