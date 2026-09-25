/**
 * FirecrawlEngine: ScrapingEngine adapter over a self-hosted Firecrawl (pinned in firecrawl.lock).
 *
 * Talks to Firecrawl's public v2 HTTP API only (POST /v2/scrape, POST /v2/crawl,
 * GET /v2/crawl/:id, GET /v2/crawl/:id/errors, DELETE /v2/crawl/:id). No Firecrawl internals
 * are imported, so upgrading Firecrawl only requires re-validating this file.
 *
 * Notes on upstream behaviour (v2.11.0) that this adapter compensates for:
 *  - Self-hosted Firecrawl (USE_DB_AUTHENTICATION=false) accepts any caller and treats all
 *    callers as one team. Tenant isolation is ours; Firecrawl must stay on a private network.
 *  - There is no plain-text format; we request html and derive text in ResultService.
 *  - HTTP 4xx/5xx target pages come back as *successful* documents with metadata.statusCode.
 *  - `proxy: "auto"` (upstream default) escalates 401/403/429 to a stealth proxy that doesn't
 *    exist self-hosted and then fails the whole scrape, so we always send `proxy: "basic"`.
 *  - Crawl `limit` has no upstream maximum; limits are enforced before we get here.
 *  - Crawl status `total` excludes failed pages; failures are read from /errors.
 *  - Pages that render client-side come back empty (or "all engines failed") without a render
 *    wait; scrape() retries those once with a short waitFor.
 *  - The Playwright service picks a random User-Agent per page (often not Chrome), which bot
 *    walls flag against its headless Chromium; we always send a fixed Chrome UA header.
 */
import type { CrawlJobOptions, ScrapeJobOptions } from "../domain.js";
import type { ErrorCode } from "../lib/errors.js";
import type { CrawlSnapshot, EngineError, EngineJobStatus, PageResult, ScrapingEngine } from "./types.js";

export interface FirecrawlEngineConfig {
  apiUrl: string;
  apiKey: string;
  /** Extra time allowed on top of the scrape's own timeout for the HTTP round trip. */
  requestTimeoutMs: number;
  /** Fixed User-Agent for target requests (see DEFAULT_USER_AGENT in config.ts). */
  userAgent?: string;
}

interface FcDocument {
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  warning?: string;
  metadata?: Record<string, unknown> & {
    title?: string | string[];
    statusCode?: number;
    sourceURL?: string;
    url?: string;
    error?: string;
    contentType?: string;
  };
}

interface FcError {
  success?: false;
  code?: string;
  error?: string;
}

const STATUS_PAGE_SIZE = 50;
/** Render wait for the automatic retry of empty / JS-only pages. */
const RENDER_WAIT_RETRY_MS = 5_000;
/** Below this much Markdown a page is treated as "not rendered yet". */
const THIN_MARKDOWN_CHARS = 200;
const MAX_BATCHES_PER_CALL = 4;

export class EngineUnavailableError extends Error {}

export class FirecrawlEngine implements ScrapingEngine {
  readonly name = "firecrawl";

  constructor(private readonly cfg: FirecrawlEngineConfig) {}

  // ------------------------------------------------------------------ transport

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs = this.cfg.requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<{ status: number; json: T }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("engine request timeout")), timeoutMs);
    const onAbort = () => ctrl.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`${this.cfg.apiUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: T;
      try {
        json = (text ? JSON.parse(text) : {}) as T;
      } catch {
        json = { error: "non-JSON response from engine" } as T;
      }
      return { status: res.status, json };
    } catch (err) {
      if (ctrl.signal.aborted && !signal?.aborted) {
        throw Object.assign(new Error("engine request timed out"), { kind: "timeout" as const });
      }
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { kind: "aborted" as const });
      throw new EngineUnavailableError(`engine unreachable: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // ------------------------------------------------------------------ mapping

  private scrapeOptions(o: ScrapeJobOptions) {
    // Firecrawl requires waitFor <= timeout / 2.
    const waitFor = Math.min(o.waitForMs, Math.floor(o.timeoutMs / 2));
    return {
      // html also feeds our derived "text" output; links are always captured for metadata.
      formats: ["markdown", "html", "links"],
      onlyMainContent: o.onlyMainContent,
      timeout: o.timeoutMs,
      waitFor,
      proxy: "basic",
      blockAds: true,
      removeBase64Images: true,
      ...(this.cfg.userAgent ? { headers: { "User-Agent": this.cfg.userAgent } } : {}),
    };
  }

  static toPageResult(doc: FcDocument, fallbackUrl: string): PageResult {
    const meta = { ...(doc.metadata ?? {}) };
    const statusCode = typeof meta.statusCode === "number" ? meta.statusCode : undefined;
    const rawTitle = meta.title;
    const title = Array.isArray(rawTitle) ? rawTitle[0] : rawTitle;
    const url = (meta.sourceURL as string) || fallbackUrl;
    const finalUrl = typeof meta.url === "string" && meta.url !== url ? meta.url : undefined;

    let error: EngineError | undefined;
    // egress-proxy answers plain-http requests to forbidden destinations with a 403 whose body
    // starts with "egress denied:". Firecrawl reports that as a normal 403 page (e.g. after a
    // redirect to an internal address), so recognise it and drop the body.
    if (statusCode === 403 && /^\s*egress denied:/i.test(doc.markdown ?? doc.html ?? "")) {
      return {
        url,
        finalUrl,
        statusCode,
        success: false,
        error: { code: "BLOCKED_URL", message: "The request (or a redirect) targeted a non-public address and was blocked" },
        metadata: {},
      };
    }
    if (statusCode !== undefined && statusCode >= 400) {
      error = { code: "HTTP_ERROR", message: `Target responded with HTTP ${statusCode}` };
    }

    // Drop upstream-internal / noisy fields before storing.
    for (const k of ["scrapeId", "proxyUsed", "cacheState", "cachedAt", "creditsUsed", "concurrencyLimited", "error", "sourceURL", "url", "statusCode", "title", "postprocessorsUsed", "indexId"]) {
      delete meta[k];
    }

    return {
      url,
      finalUrl,
      statusCode,
      title: typeof title === "string" ? title : undefined,
      contentType: typeof doc.metadata?.contentType === "string" ? doc.metadata.contentType : undefined,
      success: error === undefined,
      error,
      markdown: doc.markdown,
      html: doc.html,
      links: doc.links,
      metadata: meta,
    };
  }

  /** Map a Firecrawl error code / message to our vocabulary without leaking upstream text. */
  static mapError(code: string | undefined, message: string | undefined, httpStatus?: number): EngineError {
    const msg = message ?? "";
    const m = (c: ErrorCode, text: string): EngineError => ({ code: c, message: text });
    switch (code) {
      case "SCRAPE_TIMEOUT":
        return m("TIMEOUT", "The page did not finish loading within the timeout");
      case "SCRAPE_DNS_RESOLUTION_ERROR":
        return m("DNS_RESOLUTION_FAILED", "The target hostname could not be resolved");
      case "SCRAPE_SSL_ERROR":
        return m("SSL_ERROR", "TLS/SSL handshake with the target failed");
      case "SCRAPE_SITE_ERROR":
        return m("CONNECTION_FAILED", siteErrorText(msg));
      case "SCRAPE_UNSUPPORTED_FILE_ERROR":
        return m("UNSUPPORTED_URL", "The target content type is not supported");
      case "SCRAPE_JOB_CANCELLED":
        return m("INTERRUPTED", "The scrape was cancelled");
      case "BAD_REQUEST":
      case "BAD_REQUEST_INVALID_JSON":
        return /url/i.test(msg)
          ? m("INVALID_URL", "The engine rejected the URL")
          : m("INTERNAL_ERROR", "The engine rejected the request");
      case "SCRAPE_ALL_ENGINES_FAILED":
        if (/ENOTFOUND|EAI_AGAIN|DNS/i.test(msg)) return m("DNS_RESOLUTION_FAILED", "The target hostname could not be resolved");
        if (/timed? ?out|ETIMEDOUT|ERR_TIMED_OUT/i.test(msg)) return m("TIMEOUT", "The page did not finish loading within the timeout");
        if (/insecure|security rules|egress|TUNNEL/i.test(msg)) {
          return m("CONNECTION_FAILED", "Could not connect to the target (unreachable or blocked by network policy)");
        }
        return m("CONNECTION_FAILED", "The page could not be fetched");
      case "CRAWL_DENIAL":
        return m("ROBOTS_DISALLOWED", "Crawling this URL is not permitted");
    }
    if (httpStatus === 408) return m("TIMEOUT", "The page did not finish loading within the timeout");
    if (httpStatus === 429) return m("ENGINE_UNAVAILABLE", "The scraping engine is at capacity; retry shortly");
    if (httpStatus !== undefined && httpStatus >= 500) return m("EXTRACTION_FAILED", "The engine failed to process the page");
    return m("EXTRACTION_FAILED", "The engine failed to process the page");
  }

  // ------------------------------------------------------------------ operations

  async scrape(url: string, options: ScrapeJobOptions, signal?: AbortSignal): Promise<PageResult> {
    const first = await this.scrapeOnce(url, options, signal);
    // JS-rendered sites (Square Online, Wix, some SPAs) come back empty without a render wait,
    // and upstream then reports "all engines failed". One retry with a short wait fixes most.
    if (options.waitForMs === 0 && !signal?.aborted && first.retryWithWait) {
      const waitForMs = Math.min(RENDER_WAIT_RETRY_MS, Math.floor(options.timeoutMs / 2));
      const second = await this.scrapeOnce(url, { ...options, waitForMs }, signal);
      if (second.page.success || !first.page.success) return second.page;
    }
    return first.page;
  }

  private async scrapeOnce(url: string, options: ScrapeJobOptions, signal?: AbortSignal): Promise<{ page: PageResult; retryWithWait: boolean }> {
    const body = { url, ...this.scrapeOptions(options) };
    let res: { status: number; json: { success?: boolean; data?: FcDocument } & FcError };
    try {
      res = await this.request("POST", "/v2/scrape", body, options.timeoutMs + this.cfg.requestTimeoutMs, signal);
    } catch (err) {
      if ((err as { kind?: string }).kind === "timeout") {
        return { page: failed(url, { code: "TIMEOUT", message: "The page did not finish loading within the timeout" }), retryWithWait: false };
      }
      if ((err as { kind?: string }).kind === "aborted") {
        return { page: failed(url, { code: "INTERRUPTED", message: "The scrape was cancelled" }), retryWithWait: false };
      }
      throw err;
    }
    if (res.status === 200 && res.json.success && res.json.data) {
      const page = FirecrawlEngine.toPageResult(res.json.data, url);
      const thin = page.success && (page.markdown ?? "").trim().length < THIN_MARKDOWN_CHARS;
      return { page, retryWithWait: thin };
    }
    const error = FirecrawlEngine.mapError(res.json.code, res.json.error, res.status);
    // "All engines failed" with no network-level cause usually means the page was too empty.
    const retryWithWait = res.json.code === "SCRAPE_ALL_ENGINES_FAILED" && error.code === "CONNECTION_FAILED";
    return { page: failed(url, error), retryWithWait };
  }

  async crawl(url: string, o: CrawlJobOptions): Promise<{ engineJobId: string }> {
    const start = new URL(url);
    const body = {
      url,
      limit: o.maxPages,
      maxDiscoveryDepth: o.maxDepth,
      includePaths: o.includePatterns,
      excludePaths: o.excludePatterns,
      allowExternalLinks: false,
      allowSubdomains: o.allowSubdomains || start.hostname !== o.allowedDomain,
      crawlEntireDomain: true,
      sitemap: "include",
      scrapeOptions: this.scrapeOptions(o),
    };
    const res = await this.request<{ success?: boolean; id?: string } & FcError>("POST", "/v2/crawl", body);
    if (res.status === 200 && res.json.success && res.json.id) return { engineJobId: res.json.id };
    if (res.status === 429 || res.status >= 500) {
      throw new EngineUnavailableError(`crawl start failed with HTTP ${res.status}`);
    }
    const e = FirecrawlEngine.mapError(res.json.code, res.json.error, res.status);
    throw Object.assign(new Error(e.message), { engineError: e });
  }

  async getJobStatus(engineJobId: string, cursor: number): Promise<CrawlSnapshot> {
    const pages: PageResult[] = [];
    let skip = cursor;
    let status: EngineJobStatus = "running";
    let discovered = 0;
    let processed = 0;
    let hasMore = false;
    let error: EngineError | undefined;

    for (let i = 0; i < MAX_BATCHES_PER_CALL; i++) {
      const res = await this.request<{
        success?: boolean;
        status?: string;
        total?: number;
        completed?: number;
        data?: FcDocument[];
        next?: string;
      } & FcError>("GET", `/v2/crawl/${encodeURIComponent(engineJobId)}?skip=${skip}&limit=${STATUS_PAGE_SIZE}`);

      if (res.status === 404) {
        return { status: "failed", discovered: 0, processed: 0, pages, nextCursor: skip, hasMore: false, error: { code: "CRAWL_FAILED", message: "The crawl expired or was not found on the engine" } };
      }
      if (res.status >= 500 || res.status === 429) throw new EngineUnavailableError(`crawl status HTTP ${res.status}`);

      const j = res.json;
      status = mapCrawlStatus(j.status);
      discovered = j.total ?? discovered;
      processed = j.completed ?? processed;
      if (j.success === false && status === "failed") {
        error = { code: "CRAWL_FAILED", message: "The crawl could not be started for this URL" };
      }
      const batch = j.data ?? [];
      for (const d of batch) pages.push(FirecrawlEngine.toPageResult(d, d.metadata?.sourceURL ?? ""));
      skip += batch.length;
      hasMore = batch.length > 0 && skip < (j.total ?? 0);
      if (!hasMore) break;
    }
    return { status, discovered, processed, pages, nextCursor: skip, hasMore, error };
  }

  async getFailures(engineJobId: string): Promise<PageResult[]> {
    const res = await this.request<{
      errors?: Array<{ url: string; code?: string; error?: string }>;
      robotsBlocked?: string[];
    }>("GET", `/v2/crawl/${encodeURIComponent(engineJobId)}/errors`);
    if (res.status !== 200) return [];
    const out: PageResult[] = [];
    for (const e of res.json.errors ?? []) {
      out.push(failed(e.url, FirecrawlEngine.mapError(e.code, e.error)));
    }
    for (const u of res.json.robotsBlocked ?? []) {
      out.push(failed(u, { code: "ROBOTS_DISALLOWED", message: "Disallowed by the site's robots.txt" }));
    }
    return out;
  }

  async cancel(engineJobId: string): Promise<void> {
    const res = await this.request("DELETE", `/v2/crawl/${encodeURIComponent(engineJobId)}`);
    // 409 = already completed; 404 = already gone. Both fine for a cancel.
    if (res.status >= 500) throw new EngineUnavailableError(`cancel HTTP ${res.status}`);
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.request("GET", "/v0/health/liveness", undefined, 3000);
      return res.status === 200;
    } catch {
      return false;
    }
  }
}

function failed(url: string, error: EngineError): PageResult {
  return { url, success: false, error, metadata: {} };
}

function mapCrawlStatus(s: string | undefined): EngineJobStatus {
  switch (s) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

function siteErrorText(msg: string): string {
  if (/ERR_NAME_NOT_RESOLVED/.test(msg)) return "The target hostname could not be resolved";
  if (/ERR_CONNECTION_REFUSED/.test(msg)) return "The target refused the connection";
  if (/ERR_CONNECTION_RESET/.test(msg)) return "The connection to the target was reset";
  if (/ERR_TIMED_OUT/.test(msg)) return "The connection to the target timed out";
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/.test(msg)) {
    return "Could not connect to the target (unreachable or blocked by network policy)";
  }
  if (/ERR_CERT|SSL/.test(msg)) return "TLS/SSL error while connecting to the target";
  return "The target site could not be loaded";
}
