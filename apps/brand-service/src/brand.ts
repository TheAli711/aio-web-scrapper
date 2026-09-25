/**
 * Branding extraction: loads a page in Chromium (all traffic through egress-proxy), collects
 * signals in-page (page-script.ts), then picks logo, favicon and brand colors (color.ts).
 * Heuristics only; `confidence` fields let callers decide whether to escalate (e.g. to an LLM).
 */
import type { Browser, BrowserContext, Page } from "playwright";
import { deltaE, logoInk, parseColor, pickColors, toHex as toHexSafe, type BrandColors, type RGB } from "./color.js";
import { collectSignals, hideOverlays, imageEdgeColor, scrollAndSample, verifySurface, type SurfaceSamples, paletteFromImage, type RawIcon, type RawLogoCandidate, type RawSignals } from "./page-script.js";

export interface BrandOptions {
  timeoutMs: number;
  userAgent: string;
  /** Also return an above-the-fold JPEG (data URI) for visual QA. */
  includeScreenshot?: boolean;
}

export interface Logo {
  url: string | null;
  /** PNG of the logo exactly as rendered on the page (data URI), when it could be captured. */
  image: string | null;
  source: "dom-img" | "dom-svg" | "dom-background" | "dom-text" | "json-ld" | "icon";
  /** Wordmark text when the logo is styled text rather than an image. */
  text: string | null;
  alt: string | null;
  width: number | null;
  height: number | null;
  /** "dark" logo for light backgrounds, "light" logo for dark backgrounds. */
  tone: "dark" | "light" | "color" | null;
  /** The logo's own ink colors (backdrop removed), most prominent first. */
  colors: string[];
  confidence: "high" | "medium" | "low";
}

export interface Favicon {
  url: string;
  sizes: string | null;
  type: string | null;
  source: "link" | "default";
}

export interface BrandResult {
  url: string;
  final_url: string;
  status_code: number | null;
  title: string;
  site_name: string | null;
  logo: Logo | null;
  logo_candidates: Array<{ url: string | null; kind: string; score: number; reasons: string[] }>;
  favicon: Favicon | null;
  icons: RawIcon[];
  colors: BrandColors;
  fonts: { heading: string | null; body: string | null };
  theme_color: string | null;
  og_image: string | null;
  screenshot?: string;
  debug?: unknown;
  timing_ms: number;
}

export class BrandError extends Error {
  constructor(
    readonly code: "TIMEOUT" | "CONNECTION_FAILED" | "HTTP_ERROR" | "EXTRACTION_FAILED",
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

const MAX_LOGO_PNG_BYTES = 300_000;
const MAX_ELEMENTS = 6000;

function iconSize(i: RawIcon): number {
  if (i.type?.includes("svg") || /\.svg(\?|$)/i.test(i.url)) return 512;
  const m = i.sizes?.match(/(\d+)x(\d+)/i);
  if (m) return parseInt(m[1]!, 10);
  if (i.rel.includes("apple-touch")) return 180;
  return 32;
}

export function pickFavicon(icons: RawIcon[], pageUrl: string): Favicon {
  // Browser-tab icon: prefer rel=icon at 32-64px (what the site shows in the tab), then any icon.
  const tab = icons.filter((i) => /(^|\s)icon(\s|$)|shortcut/.test(i.rel) && !i.rel.includes("apple") && !i.rel.includes("mask"));
  const pool = tab.length ? tab : icons.filter((i) => !i.rel.includes("mask"));
  if (pool.length) {
    const score = (i: RawIcon) => {
      const s = iconSize(i);
      return s >= 32 && s <= 64 ? 1000 - Math.abs(s - 48) : s >= 64 ? 500 - s / 10 : s;
    };
    const best = [...pool].sort((a, b) => score(b) - score(a))[0]!;
    return { url: best.url, sizes: best.sizes, type: best.type, source: "link" };
  }
  return { url: new URL("/favicon.ico", pageUrl).href, sizes: null, type: null, source: "default" };
}

function logoConfidence(c: RawLogoCandidate): Logo["confidence"] {
  const strong = c.reasons.includes("logo-attr") || c.reasons.includes("home-link");
  if (c.score >= 9 && strong) return "high";
  if (c.score >= 6) return "medium";
  return "low";
}

async function settle(page: Page, deadline: number) {
  const left = () => Math.max(0, deadline - Date.now());
  await page.waitForLoadState("load", { timeout: Math.min(left(), 15_000) }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: Math.min(left(), 3_000) }).catch(() => {});
  // Let entrance animations / lazy headers finish.
  await page.waitForTimeout(Math.min(left(), 1_200));
}

export async function extractBrand(browser: Browser, url: string, opts: BrandOptions): Promise<BrandResult> {
  const t0 = Date.now();
  const deadline = t0 + opts.timeoutMs;
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      userAgent: opts.userAgent,
      viewport: { width: 1366, height: 900 },
      deviceScaleFactor: 1,
      locale: "en-US",
      ignoreHTTPSErrors: false,
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      return t === "media" || t === "websocket" || t === "eventsource" ? route.abort() : route.continue();
    });
    const page = await context.newPage();
    let status: number | null = null;
    try {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.max(1000, deadline - Date.now()) });
      status = res?.status() ?? null;
    } catch (err) {
      const msg = (err as Error).message;
      if (/Timeout/i.test(msg)) throw new BrandError("TIMEOUT", "The page did not finish loading within the timeout");
      throw new BrandError("CONNECTION_FAILED", siteError(msg));
    }
    if (status !== null && status >= 400) throw new BrandError("HTTP_ERROR", `Target responded with HTTP ${status}`, status);
    await settle(page, deadline - 5_000);
    // Newsletter / discount modals: try the polite way first, then hide what is left.
    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate(hideOverlays).catch(() => 0);
    // Rendered logo capture: exactly what a visitor sees (works for <img>, inline SVG, CSS backgrounds).
    // Pixels matching the backdrop behind the logo are dropped so the palette is the logo's own ink.
    const analysis = await context.newPage();
    let logoImage: string | null = null;
    let logoPalette: Array<{ rgb: RGB; weight: number }> = [];
    // Logo pass runs before scrolling: sticky headers change layout once the page has scrolled.
    let first: RawSignals = await page.evaluate(collectSignals, MAX_ELEMENTS);
    // Under load, lazy-loaded logos may not have laid out yet: give a weak first pass one more look.
    if ((first.logoCandidates[0]?.score ?? 0) < 6 && deadline - Date.now() > 12_000) {
      await page.waitForTimeout(1_500);
      // The latest pass reflects the current DOM (and owns the data-ws-logo marks).
      first = await page.evaluate(collectSignals, MAX_ELEMENTS);
    }
    const top0 = first.logoCandidates[0];
    if (top0) {
      try {
        const el = page.locator(`[data-ws-logo="${top0.index}"]`).first();
        await el.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => {});
        const png = await el.screenshot({ omitBackground: true, timeout: 6_000, animations: "disabled" });
        const dataUrl = "data:image/png;base64," + png.toString("base64");
        if (png.length <= MAX_LOGO_PNG_BYTES) logoImage = dataUrl;
        const pal = (await analysis.evaluate(paletteFromImage, [dataUrl, true] as const)) as Array<{ rgb: RGB; weight: number }>;
        const edge = (await analysis.evaluate(imageEdgeColor, dataUrl).catch(() => null)) as RGB | null;
        const backdrop = edge ?? parseColor(top0.backdrop) ?? parseColor(first.colors.body) ?? [255, 255, 255];
        const ink = pal.filter((p) => deltaE(p.rgb, backdrop) >= 12);
        const inkTotal = ink.reduce((a, p) => a + p.weight, 0);
        logoPalette = inkTotal > 0 ? ink.map((p) => ({ rgb: p.rgb, weight: p.weight / inkTotal })) : [];
      } catch (err) {
        console.warn(`logo capture failed for ${url}: ${(err as Error).message.split("\n")[0]}`);
      }
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" })).catch(() => {});
    }


    // Scroll like a visitor (fires lazy-loading / scroll-reveal) and sample visible surfaces.
    const surface = await page.evaluate(scrollAndSample, 5_000).catch((): SurfaceSamples => ({ shares: {}, points: [] }));
    await page.waitForTimeout(Math.max(0, Math.min(600, deadline - Date.now() - 5_000)));
    await page.evaluate(hideOverlays).catch(() => 0);

    // Color pass after scrolling, so revealed sections count. Logo / icon fields come from `first`.
    const raw: RawSignals = { ...first, colors: (await page.evaluate(collectSignals, MAX_ELEMENTS)).colors };
    if (Object.keys(surface.shares).length) raw.colors.background = surface.shares;

    // Page screenshot palette (top 4000px): what the site looks like overall. A weak brand signal,
    // but the best measure of the page surface color (sections cover each other; pixels don't lie).
    let screenshot: Array<{ rgb: RGB; weight: number }> = [];
    let screenshotJpeg: string | undefined;
    try {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      const height = Math.min(4_000, (await page.evaluate(() => document.documentElement.scrollHeight)) || 900);
      const shot = await page
        .screenshot({ type: "png", fullPage: true, clip: { x: 0, y: 0, width: 1366, height }, timeout: 10_000, animations: "disabled" })
        .catch(() => page.screenshot({ type: "png", timeout: 8_000, animations: "disabled" }));
      const shotUrl = "data:image/png;base64," + shot.toString("base64");
      screenshot = (await analysis.evaluate(paletteFromImage, [shotUrl, false] as const)) as typeof screenshot;
      if (surface.points.length) {
        const verified = (await analysis.evaluate(verifySurface, [shotUrl, surface.points] as const).catch(() => ({}))) as Record<string, number>;
        if (Object.keys(verified).length) raw.colors.background = verified;
      }
      if (opts.includeScreenshot) {
        const jpg = await page
          .screenshot({ type: "jpeg", quality: 45, fullPage: true, clip: { x: 0, y: 0, width: 1366, height }, timeout: 10_000, animations: "disabled" })
          .catch(() => page.screenshot({ type: "jpeg", quality: 55, timeout: 8_000 }));
        screenshotJpeg = "data:image/jpeg;base64," + jpg.toString("base64");
      }
    } catch {
      /* optional signal */
    }

    const top = raw.logoCandidates[0];
    let logo: Logo | null = null;
    if (top && (top.score >= 5 || (top.score >= 3 && !raw.jsonLdLogos.length))) {
      const source = `dom-${top.kind}` as Logo["source"];
      logo = { url: top.url, image: logoImage, source, text: top.text, alt: top.alt, width: top.width, height: top.height, ...logoInk(logoPalette), confidence: logoConfidence(top) };
    } else if (raw.jsonLdLogos[0]) {
      logo = { url: raw.jsonLdLogos[0], image: null, source: "json-ld", text: null, alt: null, width: null, height: null, tone: null, colors: [], confidence: "medium" };
    } else {
      const icon = [...raw.icons].sort((a, b) => iconSize(b) - iconSize(a))[0];
      if (icon) logo = { url: icon.url, image: null, source: "icon", text: null, alt: null, width: null, height: null, tone: null, colors: [], confidence: "low" };
    }
    // JSON-LD agreeing with the DOM pick raises confidence.
    if (logo && logo.confidence !== "high" && logo.url && raw.jsonLdLogos.some((u) => sameAsset(u, logo!.url!))) logo.confidence = "high";

    const colors = pickColors({
      ...raw.colors,
      themeColor: raw.themeColor,
      cssVars: raw.cssVars,
      logo: logo?.source.startsWith("dom") ? logoPalette : [],
      screenshot,
    });

    return {
      url,
      final_url: raw.finalUrl,
      status_code: status,
      title: raw.title,
      site_name: raw.siteName,
      logo,
      logo_candidates: raw.logoCandidates.slice(0, 3).map((c) => ({ url: c.url && c.url.length > 300 ? c.url.slice(0, 300) + "…" : c.url, kind: c.kind, score: c.score, reasons: c.reasons })),
      favicon: pickFavicon(raw.icons, raw.finalUrl),
      icons: raw.icons.slice(0, 10),
      colors,
      fonts: raw.fonts,
      theme_color: raw.themeColor,
      og_image: raw.ogImage,
      ...(screenshotJpeg ? { screenshot: screenshotJpeg } : {}),
      ...(opts.includeScreenshot
        ? { debug: { screenshot: screenshot.slice(0, 6).map((c) => ({ hex: toHexSafe(c.rgb), w: Math.round(c.weight * 1000) / 1000 })), background: raw.colors.background, body: raw.colors.body } }
        : {}),
      timing_ms: Date.now() - t0,
    };
  } catch (err) {
    if (err instanceof BrandError) throw err;
    const msg = (err as Error).message ?? "";
    if (/Timeout/i.test(msg)) throw new BrandError("TIMEOUT", "The page did not finish loading within the timeout");
    throw new BrandError("EXTRACTION_FAILED", "Branding extraction failed");
  } finally {
    await context?.close().catch(() => {});
  }
}

/** Same file ignoring CDN resize params / protocol (e.g. ...logo.png?w=300 vs //host/logo.png). */
function sameAsset(a: string, b: string): boolean {
  const key = (u: string) => {
    try {
      const p = new URL(u, "https://x/").pathname;
      return p.split("/").pop()!.replace(/-\d+x\d+(?=\.)/, "").toLowerCase();
    } catch {
      return u;
    }
  };
  return key(a) === key(b);
}

function siteError(msg: string): string {
  if (/ERR_NAME_NOT_RESOLVED/.test(msg)) return "The target hostname could not be resolved";
  if (/ERR_CONNECTION_REFUSED/.test(msg)) return "The target refused the connection";
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY/.test(msg)) return "Could not connect to the target (unreachable or blocked by network policy)";
  if (/ERR_CERT|SSL/.test(msg)) return "TLS/SSL error while connecting to the target";
  return "The target site could not be loaded";
}
