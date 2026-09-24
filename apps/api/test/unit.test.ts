import { describe, expect, it } from "vitest";
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
