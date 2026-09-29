/**
 * FirecrawlEngine: ScrapingEngine adapter over a self-hosted Firecrawl (pinned in firecrawl.lock).
 *
 * Talks to Firecrawl's public v2 HTTP API only (POST /v2/scrape, POST /v2/map, POST /v2/crawl and
 * /v2/batch/scrape with their GET /:id, GET /:id/errors and DELETE /:id). No Firecrawl internals
 * are imported, so upgrading Firecrawl only requires re-validating this file.
 *
 * Store crawls: a crawl from a store's home page (Magento, Shopify, WooCommerce) reads product
 * URLs from the store's public catalog (see catalog.ts) and runs as a batch scrape of the start
 * page, the products, then the start page's links. Following links in document order would spend
 * the page budget on the mega-menu. Batch jobs carry a "batch:" prefix on their engine job id.
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
 *  - Storefront bot filters (e.g. Blockify on Shopify) send browsers reporting navigator.webdriver
 *    to google.com from page JS. Firecrawl still reports the requested URL and status, so the
 *    search homepage comes back as a "successful" scrape. scrape() detects that and retries with
 *    fastMode (the plain-HTTP fetch engine, no JS), which gets the server-rendered page; crawl()
 *    probes the start page the same way and crawls such sites with fastMode.
 */
import type { CrawlJobOptions, ScrapeJobOptions } from "../domain.js";
import type { ErrorCode } from "../lib/errors.js";
import { detectPlatform, discoverProducts, inScope, matchesPatterns, type StorePlatform } from "./catalog.js";
import type { CrawlSnapshot, EngineError, EngineJobStatus, MapOptions, MapResult, PageResult, ScrapingEngine } from "./types.js";

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
/** Start-page probe before a crawl or map (bot-bounce check, store detection, links). */
const CRAWL_PROBE_TIMEOUT_MS = 15_000;
/** Time allowed for reading a store catalog; the crawl start must finish well inside the reconciler's 120s. */
const CATALOG_BUDGET_MS = 15_000;
const CATALOG_REQUEST_TIMEOUT_MS = 10_000;
const BATCH_PREFIX = "batch:";
/** Share of a store crawl's page budget reserved for catalog products. */
const STORE_PRODUCT_SHARE = 0.25;
/** Store pages that are never worth a crawl slot when filling a store crawl with start-page links. */
const STORE_UTILITY_PATH = /\/(checkout|cart|customer|account|wishlist|compare|sales\/guest|catalogsearch|productalert|my-account|login|register)(\/|$|\?)/i;

interface StartProbe {
  page: PageResult;
  bounced: boolean;
  rawHtml?: string;
}

/** Where bot filters send detected browsers: page title, and the hosts that legitimately have it. */
const BOT_BOUNCE_TARGETS = [
  { title: /^google$/i, host: /(^|\.)google\.[a-z.]+$/i },
  { title: /^(bing|search - microsoft bing)$/i, host: /(^|\.)bing\.com$/i },
];
const BOT_BOUNCE_ERROR: EngineError = {
  code: "EXTRACTION_FAILED",
  message: "The site's bot protection redirected the browser away from the page",
};

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

  /** `noJs` selects Firecrawl's fetch engine (fastMode), which requires waitFor 0. */
  private scrapeOptions(o: ScrapeJobOptions, noJs = false) {
    // Firecrawl requires waitFor <= timeout / 2.
    const waitFor = noJs ? 0 : Math.min(o.waitForMs, Math.floor(o.timeoutMs / 2));
    return {
      // html also feeds our derived "text" output; links are always captured for metadata.
      formats: ["markdown", "html", "links"],
      onlyMainContent: o.onlyMainContent,
      timeout: o.timeoutMs,
      waitFor,
      proxy: "basic",
      blockAds: true,
      removeBase64Images: true,
      ...(noJs ? { fastMode: true } : {}),
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
    if (isBotBounce(title, url)) {
      return { url, finalUrl, statusCode, success: false, error: BOT_BOUNCE_ERROR, metadata: {} };
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
    // Page JS bounced the browser to a search engine: the server-rendered HTML is the real page.
    if (first.page.error === BOT_BOUNCE_ERROR && !signal?.aborted) {
      const second = await this.scrapeOnce(url, options, signal, true);
      return second.page.success ? second.page : first.page;
    }
    // JS-rendered sites (Square Online, Wix, some SPAs) come back empty without a render wait,
    // and upstream then reports "all engines failed". One retry with a short wait fixes most.
    if (options.waitForMs === 0 && !signal?.aborted && first.retryWithWait) {
      const waitForMs = Math.min(RENDER_WAIT_RETRY_MS, Math.floor(options.timeoutMs / 2));
      const second = await this.scrapeOnce(url, { ...options, waitForMs }, signal);
      if (second.page.success || !first.page.success) return second.page;
    }
    return first.page;
  }

  private async scrapeOnce(
    url: string,
    options: ScrapeJobOptions,
    signal?: AbortSignal,
    noJs = false,
    withRawHtml = false,
  ): Promise<{ page: PageResult; retryWithWait: boolean; rawHtml?: string }> {
    const scrapeOpts = this.scrapeOptions(options, noJs);
    const body = { url, ...scrapeOpts, ...(withRawHtml ? { formats: [...scrapeOpts.formats, "rawHtml"] } : {}) };
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
      return { page, retryWithWait: thin, rawHtml: withRawHtml ? res.json.data.rawHtml : undefined };
    }
    const error = FirecrawlEngine.mapError(res.json.code, res.json.error, res.status);
    // "All engines failed" with no network-level cause usually means the page was too empty.
    const retryWithWait = res.json.code === "SCRAPE_ALL_ENGINES_FAILED" && error.code === "CONNECTION_FAILED";
    return { page: failed(url, error), retryWithWait };
  }

  async crawl(url: string, o: CrawlJobOptions): Promise<{ engineJobId: string }> {
    const start = new URL(url);
    const probe = await this.probeStart(url, o);
    // A bot filter that bounces the browser bounces every page, so crawl such sites without JS.
    const noJs = probe.bounced;
    const storeUrls = isStoreCrawl(start, o) ? await this.storeCrawlUrls(url, probe, o) : null;
    if (storeUrls) {
      const body = { urls: storeUrls, ignoreInvalidURLs: true, ...this.scrapeOptions(o, noJs) };
      return this.started(await this.request("POST", "/v2/batch/scrape", body), BATCH_PREFIX);
    }
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
      scrapeOptions: this.scrapeOptions(o, noJs),
    };
    return this.started(await this.request("POST", "/v2/crawl", body));
  }

  private started(res: { status: number; json: unknown }, prefix = ""): { engineJobId: string } {
    const j = res.json as { success?: boolean; id?: string } & FcError;
    if (res.status === 200 && j.success && j.id) return { engineJobId: prefix + j.id };
    if (res.status === 429 || res.status >= 500) {
      throw new EngineUnavailableError(`crawl start failed with HTTP ${res.status}`);
    }
    const e = FirecrawlEngine.mapError(j.code, j.error, res.status);
    throw Object.assign(new Error(e.message), { engineError: e });
  }

  /**
   * Scrape the start page with its raw HTML (store detection) and links. A page bounced by a bot
   * filter is fetched again without JS for those. Bounded; any failure is a failed page.
   */
  private async probeStart(url: string, o: ScrapeJobOptions): Promise<StartProbe> {
    const opts = { ...o, timeoutMs: CRAWL_PROBE_TIMEOUT_MS, waitForMs: 0 };
    const once = (noJs: boolean) => this.scrapeOnce(url, opts, AbortSignal.timeout(CRAWL_PROBE_TIMEOUT_MS + 5_000), noJs, true);
    try {
      const first = await once(false);
      if (first.page.error !== BOT_BOUNCE_ERROR) return { page: first.page, bounced: false, rawHtml: first.rawHtml };
      const second = await once(true).catch(() => null);
      return second?.page.success ? { page: second.page, bounced: true, rawHtml: second.rawHtml } : { page: first.page, bounced: true };
    } catch {
      return { page: failed(url, { code: "CONNECTION_FAILED", message: "The page could not be fetched" }), bounced: false };
    }
  }

  /** Product URLs from the store's public catalog, if the probed page is a supported store. */
  private async storeProducts(probe: StartProbe, url: string, max: number, scope: Scope): Promise<{ platform: StorePlatform; urls: string[] } | null> {
    const platform = detectPlatform(probe.rawHtml);
    if (!platform || max < 1) return null;
    const origin = siteOrigin(probe, url, scope);
    const deadline = Date.now() + CATALOG_BUDGET_MS;
    const found = await discoverProducts(platform, origin, max, (u) => this.fetchJson(u, deadline), deadline);
    return { platform, urls: found.filter((u) => inScope(u, scope.allowedDomain, scope.allowSubdomains) && matchesPatterns(u, scope.includePatterns, scope.excludePatterns)) };
  }

  /** A store crawl's URLs (see withProductShare); null when the store has no readable catalog. */
  private async storeCrawlUrls(url: string, probe: StartProbe, o: CrawlJobOptions): Promise<string[] | null> {
    if (!detectPlatform(probe.rawHtml) || o.maxPages < 2) return null;
    const [store, sitemap] = await Promise.all([this.storeProducts(probe, url, o.maxPages - 1, o), this.sitemapUrls(url, { ...o, limit: o.maxPages })]);
    if (!store?.urls.length) return null;
    const links = (probe.page.links ?? []).filter((l) => !STORE_UTILITY_PATH.test(l));
    return withProductShare(url, store.urls, [...sitemap, ...links], o, o.maxPages).urls;
  }

  /** GET a URL through Firecrawl's plain-HTTP engine (so through the egress proxy) and parse it as JSON. */
  private async fetchJson(url: string, deadline: number): Promise<unknown | null> {
    const timeout = Math.min(CATALOG_REQUEST_TIMEOUT_MS, deadline - Date.now());
    if (timeout < 1000) return null;
    try {
      const body = {
        url,
        formats: ["rawHtml"],
        fastMode: true,
        proxy: "basic",
        timeout,
        ...(this.cfg.userAgent ? { headers: { "User-Agent": this.cfg.userAgent } } : {}),
      };
      const res = await this.request<{ success?: boolean; data?: FcDocument }>("POST", "/v2/scrape", body, timeout + 2_000);
      const d = res.json.data;
      if (res.status !== 200 || !res.json.success || d?.metadata?.statusCode !== 200 || !d.rawHtml) return null;
      return JSON.parse(d.rawHtml);
    } catch {
      return null;
    }
  }

  async map(url: string, o: MapOptions): Promise<MapResult> {
    const probe = await this.probeStart(url, { formats: ["markdown"], onlyMainContent: false, timeoutMs: CRAWL_PROBE_TIMEOUT_MS, waitForMs: 0 });
    const [sitemap, store] = await Promise.all([this.sitemapUrls(url, o), this.storeProducts(probe, url, o.limit - 1, o)]);
    const links = probe.page.success ? (probe.page.links ?? []) : [];
    const { urls, products } = withProductShare(url, store?.urls ?? [], [...sitemap, ...links], o, o.limit);
    if (urls.length <= 1 && !probe.page.success) {
      return { urls: [], platform: null, productUrls: 0, error: probe.page.error };
    }
    return { urls, platform: store?.platform ?? null, productUrls: products };
  }

  /** Sitemap URLs via Firecrawl's map (self-hosted it has no search index, so this is sitemaps only). */
  private async sitemapUrls(url: string, o: MapOptions): Promise<string[]> {
    try {
      const body = {
        url,
        limit: o.limit,
        sitemap: "include",
        includeSubdomains: o.allowSubdomains,
        ignoreQueryParameters: true,
        timeout: CATALOG_BUDGET_MS,
        ...(this.cfg.userAgent ? { headers: { "User-Agent": this.cfg.userAgent } } : {}),
      };
      const res = await this.request<{ success?: boolean; links?: Array<string | { url?: string }> }>("POST", "/v2/map", body, CATALOG_BUDGET_MS + 5_000);
      if (res.status !== 200 || !res.json.success) return [];
      return (res.json.links ?? []).map((l) => (typeof l === "string" ? l : l?.url)).filter((u): u is string => typeof u === "string");
    } catch {
      return [];
    }
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
      } & FcError>("GET", `${jobPath(engineJobId)}?skip=${skip}&limit=${STATUS_PAGE_SIZE}`);

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
    }>("GET", `${jobPath(engineJobId)}/errors`);
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
    const res = await this.request("DELETE", jobPath(engineJobId));
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

type Scope = Pick<CrawlJobOptions, "allowedDomain" | "allowSubdomains" | "includePatterns" | "excludePatterns">;

function jobPath(engineJobId: string): string {
  return engineJobId.startsWith(BATCH_PREFIX)
    ? `/v2/batch/scrape/${encodeURIComponent(engineJobId.slice(BATCH_PREFIX.length))}`
    : `/v2/crawl/${encodeURIComponent(engineJobId)}`;
}

/** Catalog crawls apply to crawls from a store's home page that aren't restricted to some paths. */
function isStoreCrawl(start: URL, o: CrawlJobOptions): boolean {
  return (start.pathname === "/" || start.pathname === "") && o.maxDepth >= 1 && o.includePatterns.length === 0;
}

/** `start` first, then in-scope candidates matching the path filters, deduplicated (ignoring #fragments and www.), up to `max`. */
function siteUrls(start: string, candidates: string[], scope: Scope, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return;
    }
    u.hash = "";
    const key = urlKey(u.href);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(u.href);
  };
  add(start);
  for (const c of candidates) {
    if (out.length >= max) break;
    if (inScope(c, scope.allowedDomain, scope.allowSubdomains) && matchesPatterns(c, scope.includePatterns, scope.excludePatterns)) add(c);
  }
  return out;
}

/**
 * `start`, then catalog products and the site's other pages within `budget` URLs:
 * STORE_PRODUCT_SHARE of the budget is reserved for products, other pages get the rest, and
 * slots they leave unused go to more products.
 */
function withProductShare(start: string, productUrls: string[], otherUrls: string[], scope: Scope, budget: number): { urls: string[]; products: number } {
  const [first, ...products] = siteUrls(start, productUrls, scope, Infinity);
  const productKeys = new Set(products.map(urlKey));
  const others = siteUrls(start, otherUrls, scope, Infinity)
    .slice(1)
    .filter((u) => !productKeys.has(urlKey(u)));
  const rest = Math.max(0, budget - 1);
  const reserved = Math.min(products.length, Math.ceil(rest * STORE_PRODUCT_SHARE));
  const nOthers = Math.min(others.length, rest - reserved);
  const nProducts = Math.min(products.length, rest - nOthers);
  return { urls: [first!, ...products.slice(0, nProducts), ...others.slice(0, nOthers)], products: nProducts };
}

/**
 * The origin the store's pages live on: the one most of the start page's own links use
 * (e.g. www. after an apex redirect Firecrawl doesn't report), else the final or start URL's.
 */
function siteOrigin(probe: StartProbe, url: string, scope: Scope): string {
  const counts = new Map<string, number>();
  for (const l of probe.page.links ?? []) {
    if (!inScope(l, scope.allowedDomain, scope.allowSubdomains)) continue;
    const o = new URL(l).origin;
    counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : new URL(probe.page.finalUrl ?? url).origin;
}

/** Identity of a page URL for deduplication: no #fragment, host without www. */
function urlKey(href: string): string {
  const u = new URL(href);
  return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname}${u.search}`;
}

function failed(url: string, error: EngineError): PageResult {
  return { url, success: false, error, metadata: {} };
}

function isBotBounce(title: string | undefined, url: string): boolean {
  const t = typeof title === "string" ? title.trim() : "";
  if (!t) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return BOT_BOUNCE_TARGETS.some((b) => b.title.test(t) && !b.host.test(host));
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
