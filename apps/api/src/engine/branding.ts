/**
 * BrandingService: extracts a site's logo, favicon, brand colors and fonts.
 *
 * The only implementation, HttpBrandingService, calls our internal brand-service
 * (apps/brand-service: its own Chromium, all traffic through egress-proxy). Heuristic only, no
 * LLM; confidence fields tell callers when a result is worth a second look.
 */
import type { ErrorCode } from "../lib/errors.js";
import type { EngineError } from "./types.js";

export interface Branding {
  final_url: string | null;
  site_name: string | null;
  logo: {
    url: string | null;
    /** PNG data URI of the logo as rendered on the page. */
    image: string | null;
    source: string;
    alt: string | null;
    width: number | null;
    height: number | null;
    tone: "dark" | "light" | "color" | null;
    colors: string[];
    confidence: "high" | "medium" | "low";
  } | null;
  favicon: { url: string; sizes: string | null; type: string | null; source: string } | null;
  icons: Array<{ url: string; rel: string; sizes: string | null; type: string | null }>;
  colors: {
    primary: string | null;
    secondary: string | null;
    accent: string | null;
    background: string | null;
    text: string | null;
    palette: Array<{ hex: string; weight: number; sources: string[] }>;
    basis: string;
    confidence: "high" | "medium" | "low";
  };
  fonts: { heading: string | null; body: string | null };
  theme_color: string | null;
  og_image: string | null;
}

export type BrandingOutcome = { ok: true; branding: Branding } | { ok: false; error: EngineError };

export interface BrandingService {
  extract(url: string, timeoutMs: number, signal?: AbortSignal): Promise<BrandingOutcome>;
}

const SERVICE_CODES: Record<string, ErrorCode> = {
  TIMEOUT: "TIMEOUT",
  CONNECTION_FAILED: "CONNECTION_FAILED",
  HTTP_ERROR: "HTTP_ERROR",
  INVALID_URL: "INVALID_URL",
};

/** Keep only the documented fields (the service may add debug data). */
export function pickBranding(j: Record<string, unknown>): Branding {
  const b = j as unknown as Branding & { url?: string };
  return {
    final_url: b.final_url ?? null,
    site_name: b.site_name ?? null,
    logo: b.logo ?? null,
    favicon: b.favicon ?? null,
    icons: Array.isArray(b.icons) ? b.icons.slice(0, 10) : [],
    colors: b.colors,
    fonts: b.fonts ?? { heading: null, body: null },
    theme_color: b.theme_color ?? null,
    og_image: b.og_image ?? null,
  };
}

export class HttpBrandingService implements BrandingService {
  constructor(private readonly cfg: { serviceUrl: string }) {}

  async extract(url: string, timeoutMs: number, signal?: AbortSignal): Promise<BrandingOutcome> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs + 15_000);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(`${this.cfg.serviceUrl}/v1/brand`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, timeout_ms: timeoutMs }),
        signal: ctrl.signal,
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { code?: string } };
      if (res.status === 200) return { ok: true, branding: pickBranding(json) };
      const code = SERVICE_CODES[json.error?.code ?? ""] ?? "EXTRACTION_FAILED";
      return { ok: false, error: { code, message: brandingMessage(code) } };
    } catch {
      if (signal?.aborted) return { ok: false, error: { code: "INTERRUPTED", message: "The scrape was cancelled" } };
      if (ctrl.signal.aborted) return { ok: false, error: { code: "TIMEOUT", message: brandingMessage("TIMEOUT") } };
      return { ok: false, error: { code: "ENGINE_UNAVAILABLE", message: "The branding service is unavailable" } };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function brandingMessage(code: ErrorCode): string {
  switch (code) {
    case "TIMEOUT":
      return "Branding extraction did not finish within the timeout";
    case "CONNECTION_FAILED":
      return "Could not load the page for branding extraction";
    case "HTTP_ERROR":
      return "The page returned an HTTP error, so branding was not extracted";
    default:
      return "Branding extraction failed";
  }
}
