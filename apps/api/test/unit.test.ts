import { describe, expect, it } from "vitest";
import { detectPlatform, discoverProducts, inScope, matchesPatterns, parseCatalogPage } from "../src/engine/catalog.js";
import { FirecrawlEngine } from "../src/engine/firecrawl.js";
import { applySizeLimit, htmlToText, sanitizeMetadata } from "../src/services/results.js";
import { generateApiKey, hashPassword, parseApiKey, verifyPassword } from "../src/lib/crypto.js";

describe("FirecrawlEngine mapping", () => {
  it("maps a successful document", () => {
    const p = FirecrawlEngine.toPageResult(
      {
        markdown: "# Hi",
        html: "<h1>Hi</h1>",
        links: ["https://a.dev"],
        metadata: { title: "Hi", statusCode: 200, sourceURL: "https://a.dev/", url: "https://a.dev/final", scrapeId: "x", proxyUsed: "basic", description: "d" },
      },
      "https://fallback/",
    );
    expect(p).toMatchObject({ url: "https://a.dev/", finalUrl: "https://a.dev/final", statusCode: 200, title: "Hi", success: true });
    expect(p.metadata).toEqual({ description: "d" });
  });

  it("treats 4xx/5xx target pages as failed pages with HTTP_ERROR, keeping content", () => {
    const p = FirecrawlEngine.toPageResult({ markdown: "Not found", metadata: { statusCode: 404, sourceURL: "https://a.dev/x" } }, "");
    expect(p).toMatchObject({ success: false, error: { code: "HTTP_ERROR" }, markdown: "Not found" });
  });

  it("recognises pages replaced by an egress-proxy denial", () => {
    const p = FirecrawlEngine.toPageResult(
      { markdown: "egress denied: Target address is not publicly routable (loopback)", metadata: { statusCode: 403, sourceURL: "https://a.dev/r" } },
      "",
    );
    expect(p).toMatchObject({ success: false, error: { code: "BLOCKED_URL" } });
    expect(p.markdown).toBeUndefined();
  });

  it.each([
    ["SCRAPE_TIMEOUT", "", 408, "TIMEOUT"],
    ["SCRAPE_DNS_RESOLUTION_ERROR", "", 200, "DNS_RESOLUTION_FAILED"],
    ["SCRAPE_SSL_ERROR", "", 500, "SSL_ERROR"],
    ["SCRAPE_SITE_ERROR", "net::ERR_CONNECTION_REFUSED", 500, "CONNECTION_FAILED"],
    ["SCRAPE_ALL_ENGINES_FAILED", "getaddrinfo ENOTFOUND x", 500, "DNS_RESOLUTION_FAILED"],
    ["SCRAPE_ALL_ENGINES_FAILED", "whatever", 500, "CONNECTION_FAILED"],
    ["BAD_REQUEST", "URL must have a valid top-level domain", 400, "INVALID_URL"],
    [undefined, "", 429, "ENGINE_UNAVAILABLE"],
    ["UNKNOWN_ERROR", "stack trace with internal hostnames", 500, "EXTRACTION_FAILED"],
  ])("maps %s (%s, HTTP %s) to %s without leaking upstream text", (code, msg, status, expected) => {
    const e = FirecrawlEngine.mapError(code, msg, status);
    expect(e.code).toBe(expected);
    if (msg) expect(e.message).not.toContain(msg);
  });
});

describe("result processing", () => {
  it("derives plain text from html", () => {
    expect(htmlToText("<h1>Title</h1><p>a <b>b</b></p><script>x()</script>")).toBe("Title\n\na b");
  });

  it("truncates oversized content, html first, and flags it", () => {
    const big = { markdown: "m".repeat(1000), html: "h".repeat(5000), text: "t".repeat(1000) };
    const { content, truncated } = applySizeLimit(big, 2500);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThanOrEqual(2500);
    expect(content.markdown).toHaveLength(1000);
    expect(content.html!.length).toBeLessThan(5000);
  });

  it("bounds metadata", () => {
    const m = sanitizeMetadata({ a: "x".repeat(5000), nested: { deep: 1 }, arr: ["a", 1, "b"], n: 3 });
    expect((m.a as string).length).toBe(1000);
    expect(m.nested).toBeUndefined();
    expect(m.arr).toEqual(["a", "b"]);
  });
});

describe("crypto", () => {
  it("hashes and verifies passwords", async () => {
    const h = await hashPassword("pässwörd-123");
    expect(await verifyPassword("pässwörd-123", h)).toBe(true);
    expect(await verifyPassword("password-123", h)).toBe(false);
  });

  it("generates parseable, unique API keys", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(parseApiKey(a.key)).toEqual({ prefix: a.prefix });
    expect(parseApiKey("wsk_short")).toBeNull();
  });
});

describe("FirecrawlEngine requests", () => {
  it("sends a fixed Chrome User-Agent with every scrape", async () => {
    const bodies: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ success: true, data: { markdown: "x", metadata: { statusCode: 200, sourceURL: "https://a.dev/" } } }), { status: 200 });
    }) as typeof fetch;
    try {
      const engine = new FirecrawlEngine({ apiUrl: "http://fc", apiKey: "k", requestTimeoutMs: 1000, userAgent: "Mozilla/5.0 Test Chrome/149" });
      await engine.scrape("https://a.dev/", { formats: ["markdown"], onlyMainContent: true, timeoutMs: 1000, waitForMs: 0 });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(bodies[0]).toMatchObject({ url: "https://a.dev/", proxy: "basic", headers: { "User-Agent": "Mozilla/5.0 Test Chrome/149" } });
  });
});

describe("FirecrawlEngine render-wait retry", () => {
  const withFetch = async (responses: unknown[], fn: (bodies: Array<Record<string, unknown>>) => Promise<void>) => {
    const bodies: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(responses[bodies.length - 1]), { status: 200 });
    }) as typeof fetch;
    try {
      await fn(bodies);
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const engine = new FirecrawlEngine({ apiUrl: "http://fc", apiKey: "k", requestTimeoutMs: 1000 });
  const opts = { formats: ["markdown" as const], onlyMainContent: true, timeoutMs: 30000, waitForMs: 0 };
  const full = { success: true, data: { markdown: "x".repeat(500), metadata: { statusCode: 200, sourceURL: "https://a.dev/" } } };

  it("retries an 'all engines failed' page once with a render wait", async () => {
    await withFetch([{ success: false, code: "SCRAPE_ALL_ENGINES_FAILED", error: "All scraping engines failed" }, full], async (bodies) => {
      const page = await engine.scrape("https://a.dev/", opts);
      expect(page.success).toBe(true);
      expect(bodies.map((b) => b.waitFor)).toEqual([0, 5000]);
    });
  });

  const bounced = { success: true, data: { markdown: "x".repeat(2000), metadata: { title: "Google", statusCode: 200, sourceURL: "https://shop.dev/" } } };

  it("retries a page bounced to a search engine by bot filters without JS", async () => {
    await withFetch([bounced, { ...full, data: { ...full.data, metadata: { title: "Shop", statusCode: 200, sourceURL: "https://shop.dev/" } } }], async (bodies) => {
      const page = await engine.scrape("https://shop.dev/", { ...opts, waitForMs: 2000 });
      expect(page).toMatchObject({ success: true, title: "Shop" });
      expect(bodies.map((b) => [b.fastMode, b.waitFor])).toEqual([[undefined, 2000], [true, 0]]);
    });
  });

  it("fails a bounced page instead of returning the search homepage", async () => {
    await withFetch([bounced, { success: false, code: "SCRAPE_ALL_ENGINES_FAILED", error: "x" }], async () => {
      const page = await engine.scrape("https://shop.dev/", opts);
      expect(page).toMatchObject({ success: false, error: { code: "EXTRACTION_FAILED" } });
      expect(page.markdown).toBeUndefined();
    });
    const google = FirecrawlEngine.toPageResult({ markdown: "x", metadata: { title: "Google", statusCode: 200, sourceURL: "https://www.google.com/" } }, "");
    expect(google.success).toBe(true);
  });

  it("crawls sites that bounce the browser without JS", async () => {
    const crawlOpts = { ...opts, maxDepth: 2, maxPages: 10, includePatterns: [], excludePatterns: [], allowedDomain: "shop.dev", allowSubdomains: false };
    // Bounced probe, its no-JS re-probe, the crawl; then a normal site's probe and crawl.
    await withFetch([bounced, full, { success: true, id: "c1" }, full, { success: true, id: "c2" }], async (bodies) => {
      await engine.crawl("https://shop.dev/", crawlOpts);
      expect(bodies[1]!.fastMode).toBe(true);
      expect((bodies[2]!.scrapeOptions as Record<string, unknown>).fastMode).toBe(true);
      await engine.crawl("https://a.dev/", { ...crawlOpts, allowedDomain: "a.dev" });
      expect((bodies[4]!.scrapeOptions as Record<string, unknown>).fastMode).toBeUndefined();
    });
  });

  it("does not retry a full page or a caller-chosen wait", async () => {
    await withFetch([full], async (bodies) => {
      await engine.scrape("https://a.dev/", opts);
      expect(bodies).toHaveLength(1);
    });
    await withFetch([{ success: false, code: "SCRAPE_ALL_ENGINES_FAILED", error: "x" }], async (bodies) => {
      const page = await engine.scrape("https://a.dev/", { ...opts, waitForMs: 2000 });
      expect(page.success).toBe(false);
      expect(bodies).toHaveLength(1);
    });
  });
});

describe("store catalog", () => {
  it("detects the store platform from page markup", () => {
    expect(detectPlatform('<script type="text/x-magento-init">{"*":{"Magento_Ui/js/core/app":{}}}</script>')).toBe("magento");
    expect(detectPlatform('<link href="//cdn.shopify.com/s/files/1/theme.css">')).toBe("shopify");
    expect(detectPlatform('<body class="home woocommerce-no-js">')).toBe("woocommerce");
    expect(detectPlatform("<html><body>blog</body></html>")).toBeNull();
    expect(detectPlatform(undefined)).toBeNull();
  });

  it("parses each platform's catalog into product URLs", () => {
    const magento = { data: { storeConfig: { product_url_suffix: "/" }, products: { items: [{ url_key: "iphone-17" }, { url_key: "" }] } } };
    expect(parseCatalogPage("magento", "https://m.dev", magento)).toEqual(["https://m.dev/iphone-17/"]);
    const noSuffix = { data: { products: { items: [{ url_key: "tv" }] } } };
    expect(parseCatalogPage("magento", "https://m.dev", noSuffix)).toEqual(["https://m.dev/tv.html"]);
    expect(parseCatalogPage("shopify", "https://s.dev", { products: [{ handle: "shoe" }] })).toEqual(["https://s.dev/products/shoe"]);
    expect(parseCatalogPage("woocommerce", "https://w.dev", [{ permalink: "https://w.dev/product/mug/" }, { permalink: "javascript:x" }])).toEqual([
      "https://w.dev/product/mug/",
    ]);
    expect(parseCatalogPage("magento", "https://m.dev", { errors: [{ message: "no" }] })).toBeNull();
    expect(parseCatalogPage("shopify", "https://s.dev", "<html>")).toBeNull();
  });

  it("pages through the catalog until it runs out or the cap is reached", async () => {
    const requested: string[] = [];
    const shop = (n: number, from: number) => ({ products: Array.from({ length: n }, (_, i) => ({ handle: `p${from + i}` })) });
    const fetchJson = async (url: string) => {
      requested.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      return page === 1 ? shop(250, 0) : page === 2 ? shop(10, 250) : shop(0, 0);
    };
    const all = await discoverProducts("shopify", "https://s.dev", 1000, fetchJson, Date.now() + 5000);
    expect(all).toHaveLength(260);
    const capped = await discoverProducts("shopify", "https://s.dev", 100, fetchJson, Date.now() + 5000);
    expect(capped).toHaveLength(100);
    expect(requested.at(-1)).toContain("page=1");
    expect(await discoverProducts("shopify", "https://s.dev", 100, async () => null, Date.now() + 5000)).toEqual([]);
  });

  it("scopes URLs to the site and path filters", () => {
    expect(inScope("https://www.shop.dev/a", "shop.dev", false)).toBe(true);
    expect(inScope("https://shop.dev/a", "www.shop.dev", false)).toBe(true);
    expect(inScope("https://blog.shop.dev/a", "shop.dev", false)).toBe(false);
    expect(inScope("https://blog.shop.dev/a", "shop.dev", true)).toBe(true);
    expect(inScope("https://other.dev/a", "shop.dev", true)).toBe(false);
    expect(matchesPatterns("https://shop.dev/products/a", ["^/products"], [])).toBe(true);
    expect(matchesPatterns("https://shop.dev/blog/a", ["^/products"], [])).toBe(false);
    expect(matchesPatterns("https://shop.dev/products/a", [], ["/a$"])).toBe(false);
  });
});

describe("FirecrawlEngine store crawls", () => {
  const magentoHome = {
    success: true,
    data: {
      markdown: "x".repeat(500),
      rawHtml: '<script>{"Magento_Theme/js/x":{}}</script>',
      links: ["https://www.shop.dev/c1", "https://www.shop.dev/checkout/cart/", "https://www.shop.dev/c2", "https://www.shop.dev/c3", "https://www.shop.dev/c4", "https://other.dev/x"],
      // Firecrawl doesn't report the apex -> www redirect; the page's links show where the store lives.
      metadata: { statusCode: 200, sourceURL: "https://shop.dev/" },
    },
  };
  const catalog = { data: { storeConfig: { product_url_suffix: "/" }, products: { items: [{ url_key: "p1" }, { url_key: "p2" }, { url_key: "p3" }] } } };

  const withStore = async (fn: (calls: Array<{ path: string; body: Record<string, any> }>) => Promise<void>) => {
    const calls: Array<{ path: string; body: Record<string, any> }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
      if (path === "/v2/scrape" && String(body.url).includes("/graphql")) {
        return json({ success: true, data: { rawHtml: JSON.stringify(catalog), metadata: { statusCode: 200 } } });
      }
      if (path === "/v2/scrape") return json(magentoHome);
      if (path === "/v2/map") return json({ success: true, links: [{ url: "https://www.shop.dev/about" }, { url: "https://www.shop.dev/p1/" }] });
      if (path === "/v2/batch/scrape") return json({ success: true, id: "b1" });
      if (path === "/v2/crawl") return json({ success: true, id: "c1" });
      if (path.startsWith("/v2/batch/scrape/b1")) return json({ success: true, status: "completed", total: 1, completed: 1, data: [] });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    try {
      await fn(calls);
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const engine = new FirecrawlEngine({ apiUrl: "http://fc", apiKey: "k", requestTimeoutMs: 1000 });
  const crawlOpts = {
    formats: ["markdown" as const], onlyMainContent: true, timeoutMs: 30000, waitForMs: 0,
    maxDepth: 3, maxPages: 5, includePatterns: [], excludePatterns: [], allowedDomain: "shop.dev", allowSubdomains: false,
  };

  it("batch-scrapes a store's products with a reserved share of the budget, then its other pages", async () => {
    await withStore(async (calls) => {
      const { engineJobId } = await engine.crawl("https://shop.dev/", crawlOpts);
      expect(engineJobId).toBe("batch:b1");
      const batch = calls.find((c) => c.path === "/v2/batch/scrape")!.body;
      // 4 slots after the start page: 25% (1) reserved for products, the rest for other pages.
      expect(batch.urls).toEqual(["https://shop.dev/", "https://www.shop.dev/p1/", "https://www.shop.dev/about", "https://www.shop.dev/c1", "https://www.shop.dev/c2"]);
      expect(calls.some((c) => c.path === "/v2/crawl")).toBe(false);
      expect(calls.find((c) => String(c.body.url).includes("/graphql"))!.body.url).toMatch(/^https:\/\/www\.shop\.dev\/graphql\?/);

      await engine.crawl("https://shop.dev/", { ...crawlOpts, maxPages: 50 });
      const big = calls.filter((c) => c.path === "/v2/batch/scrape").at(-1)!.body;
      // Other pages don't fill the budget, so every product gets in; cart and off-site links never do.
      expect(big.urls).toHaveLength(9);
      expect(big.urls.filter((u: string) => /\/p\d\/$/.test(u))).toHaveLength(3);
      expect(big.urls.some((u: string) => /checkout|other\.dev/.test(u))).toBe(false);

      const snap = await engine.getJobStatus(engineJobId, 0);
      expect(snap.status).toBe("completed");
      expect(calls.at(-1)!.path).toBe("/v2/batch/scrape/b1");
    });
  });

  it("uses a normal crawl below the home page or when restricted to some paths", async () => {
    await withStore(async (calls) => {
      await engine.crawl("https://shop.dev/c1", crawlOpts);
      await engine.crawl("https://shop.dev/", { ...crawlOpts, includePatterns: ["^/blog"] });
      expect(calls.filter((c) => c.path === "/v2/crawl")).toHaveLength(2);
      expect(calls.some((c) => c.path === "/v2/batch/scrape" || String(c.body.url).includes("/graphql"))).toBe(false);
    });
  });

  it("maps a store: start URL, products, sitemap, then start-page links", async () => {
    await withStore(async () => {
      const r = await engine.map("https://shop.dev/", { limit: 100, includePatterns: [], excludePatterns: [], allowedDomain: "shop.dev", allowSubdomains: false });
      expect(r).toMatchObject({ platform: "magento", productUrls: 3 });
      expect(r.urls.slice(0, 5)).toEqual(["https://shop.dev/", "https://www.shop.dev/p1/", "https://www.shop.dev/p2/", "https://www.shop.dev/p3/", "https://www.shop.dev/about"]);
      expect(r.urls).toContain("https://www.shop.dev/checkout/cart/");
      expect(r.urls).not.toContain("https://other.dev/x");
    });
  });
});
