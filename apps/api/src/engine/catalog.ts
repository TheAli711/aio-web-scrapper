/**
 * Store catalog discovery: product URLs from an e-commerce platform's public storefront API.
 *
 * Link-following crawls miss products on stores whose mega-menu puts hundreds of category links
 * ahead of any product in the HTML (Firecrawl takes links in document order until the crawl
 * limit, e.g. a Magento store with ~330 menu links before the first product). These platforms
 * publish their catalog without auth, so crawl() and map() read product URLs from there:
 *   - Magento 2:   GET /graphql?query={products(search:"") ...}
 *   - Shopify:     GET /products.json
 *   - WooCommerce: GET /wp-json/wc/store/v1/products
 * Fetching is injected (the engine routes it through Firecrawl, i.e. the egress proxy), so this
 * module is pure parsing and paging.
 */

export type StorePlatform = "magento" | "shopify" | "woocommerce";

/** GET a URL and return its parsed JSON body, or null on any failure. */
export type JsonFetcher = (url: string) => Promise<unknown | null>;

const SIGNATURES: Array<[StorePlatform, RegExp]> = [
  ["magento", /Magento_[A-Za-z]+|data-mage-init|\/static\/version\d+\/frontend\//],
  ["shopify", /cdn\.shopify\.com|Shopify\.theme|myshopify\.com/],
  ["woocommerce", /wp-content\/plugins\/woocommerce|woocommerce-no-js|wc-block-/],
];

export function detectPlatform(rawHtml: string | undefined): StorePlatform | null {
  if (!rawHtml) return null;
  for (const [platform, re] of SIGNATURES) if (re.test(rawHtml)) return platform;
  return null;
}

const PAGE_SIZE: Record<StorePlatform, number> = {
  // Magento 2.4.7+ caps pageSize at 300 by default; Shopify caps limit at 250, the Store API per_page at 100.
  magento: 300,
  shopify: 250,
  woocommerce: 100,
};
const PARALLEL_PAGES = 4;

function pageUrl(platform: StorePlatform, origin: string, page: number): string {
  const size = PAGE_SIZE[platform];
  switch (platform) {
    case "magento": {
      const q = `{storeConfig{product_url_suffix} products(search:"",pageSize:${size},currentPage:${page}){items{url_key}}}`;
      return `${origin}/graphql?query=${encodeURIComponent(q)}`;
    }
    case "shopify":
      return `${origin}/products.json?limit=${size}&page=${page}`;
    case "woocommerce":
      return `${origin}/wp-json/wc/store/v1/products?per_page=${size}&page=${page}`;
  }
}

/** Product URLs in one catalog page, or null if the body isn't a catalog response. */
export function parseCatalogPage(platform: StorePlatform, origin: string, body: unknown): string[] | null {
  const b = body as Record<string, any> | null;
  if (!b || typeof b !== "object") return null;
  switch (platform) {
    case "magento": {
      const items = b.data?.products?.items;
      if (!Array.isArray(items)) return null;
      const suffix = typeof b.data?.storeConfig?.product_url_suffix === "string" ? b.data.storeConfig.product_url_suffix : ".html";
      return items.filter((i) => typeof i?.url_key === "string" && i.url_key).map((i) => `${origin}/${i.url_key}${suffix}`);
    }
    case "shopify": {
      if (!Array.isArray(b.products)) return null;
      return b.products.filter((p: any) => typeof p?.handle === "string" && p.handle).map((p: any) => `${origin}/products/${p.handle}`);
    }
    case "woocommerce": {
      if (!Array.isArray(b)) return null;
      return b.filter((p: any) => typeof p?.permalink === "string" && /^https?:\/\//.test(p.permalink)).map((p: any) => p.permalink as string);
    }
  }
}

/**
 * Up to `max` product URLs, fetching catalog pages a few at a time until the catalog runs out,
 * `max` is reached or `deadline` (epoch ms) passes. Returns what it has on any failure.
 */
export async function discoverProducts(
  platform: StorePlatform,
  origin: string,
  max: number,
  fetchJson: JsonFetcher,
  deadline: number,
): Promise<string[]> {
  const size = PAGE_SIZE[platform];
  const urls = new Set<string>();
  let page = 1;
  while (urls.size < max && Date.now() < deadline) {
    const want = Math.min(PARALLEL_PAGES, Math.ceil((max - urls.size) / size));
    const pages = await Promise.all(
      Array.from({ length: want }, (_, i) => fetchJson(pageUrl(platform, origin, page + i)).then((b) => (b === null ? null : parseCatalogPage(platform, origin, b)))),
    );
    page += want;
    let exhausted = false;
    for (const items of pages) {
      if (items === null || items.length === 0) {
        exhausted = true;
        break;
      }
      for (const u of items) urls.add(u);
      if (items.length < size) {
        exhausted = true;
        break;
      }
    }
    if (exhausted) break;
  }
  return [...urls].slice(0, max);
}

/** Whether `url` belongs to the crawl's site: the allowed domain, its www host, or (if allowed) any subdomain. */
export function inScope(url: string, allowedDomain: string, allowSubdomains: boolean): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const d = allowedDomain.toLowerCase().replace(/^www\./, "");
  return host === d || host === `www.${d}` || (allowSubdomains && host.endsWith(`.${d}`));
}

/** Firecrawl-style path filters: includes (any must match) and excludes (none may match), tested on the path. */
export function matchesPatterns(url: string, include: string[], exclude: string[]): boolean {
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return false;
  }
  if (include.length && !include.some((p) => new RegExp(p).test(path))) return false;
  return !exclude.some((p) => new RegExp(p).test(path));
}
