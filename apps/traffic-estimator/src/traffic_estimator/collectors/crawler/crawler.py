"""Collector "crawl": our own lightweight, polite crawl of one site.

Budget (configurable): homepage (1) + robots.txt (1) + sitemap files (<= crawl_max_sitemaps) +
representative pages (<= crawl_pages). Respects robots.txt, Crawl-delay (capped), Retry-After and
status codes; never tries to get around bot protection: a challenge page is recorded as
`blocked = true` and the pipeline carries on with the other sources.
"""

from __future__ import annotations

import logging
import time
from collections import Counter
from urllib.parse import urlsplit

from ...domains import registrable_domain, same_site
from ...http import FetchResult, fetch
from ...ratelimit import HostThrottle
from ...settings import get_settings
from ..base import CollectorContext, CollectorResult, Observation
from .html import PageInfo, parse_html
from .robots import Robots, fetch_robots
from .sitemap import collect_sitemaps
from .tech import detect
from .urls import classify_path, language_prefix

log = logging.getLogger(__name__)

CRAWL_VERSION = "crawl_v1"
INTERESTING_HEADERS = (
    "server",
    "x-powered-by",
    "content-type",
    "cf-ray",
    "cf-mitigated",
    "x-vercel-id",
    "x-nf-request-id",
    "via",
    "x-served-by",
    "x-cache",
    "x-shopify-stage",
    "x-shopid",
    "x-wix-request-id",
    "x-akamai-transformed",
    "x-amz-cf-id",
    "x-generator",
    "x-drupal-cache",
    "x-aspnet-version",
    "x-kinsta-cache",
    "x-pantheon-styx-hostname",
    "x-azure-ref",
    "x-magento-cache-debug",
    "x-bc-apicontext",
    "x-fastly-request-id",
    "x-varnish",
    "last-modified",
)
_BLOCK_MARKERS = (
    b"just a moment",
    b"attention required",
    b"access denied",
    b"pardon our interruption",
    b"verify you are a human",
    b"are you a human",
    b"captcha",
    b"cf-challenge",
    b"challenge-platform",
    b"bot detection",
    b"request unsuccessful. incapsula",
    b"_incapsula_resource",
    b"perimeterx",
    b"px-captcha",
    b"ddos-guard",
    b"reference #18.",
    b"blocked by",
)
_PARKED_MARKERS = (
    b"this domain is for sale",
    b"domain for sale",
    b"buy this domain",
    b"is parked free",
    b"parked domain",
    b"sedoparking",
    b"parkingcrew",
    b"domain is parked",
    b"this web page is parked",
    b"hugedomains",
    b"dan.com",
    b"afternic",
    b"godaddy.com/domainsearch",
    b"namecheap.com/domains/registration",
    b"expired domain",
    b"renew your domain",
)


def looks_blocked(r: FetchResult) -> str | None:
    if r.status is None:
        return None
    if r.headers.get("cf-mitigated") == "challenge":
        return "cloudflare_challenge"
    if r.status in (401, 403, 429, 503, 406):
        head = r.body[:60_000].lower()
        for marker in _BLOCK_MARKERS:
            if marker in head:
                return f"http_{r.status}:{marker.decode()}"
        if r.status in (403, 429):
            return f"http_{r.status}"
    return None


def looks_parked(page: PageInfo, body: bytes) -> bool:
    head = body[:80_000].lower()
    hits = sum(1 for m in _PARKED_MARKERS if m in head)
    if hits >= 2:
        return True
    if hits == 1 and page.word_count < 400 and page.internal_links < 5:
        return True
    return False


async def fetch_homepage(domain: str) -> tuple[FetchResult, str]:
    """Try https/http with and without www. Returns the best response and the origin used."""
    best: FetchResult | None = None
    best_origin = f"https://{domain}"
    for origin in (f"https://{domain}", f"https://www.{domain}", f"http://{domain}", f"http://www.{domain}"):
        r = await fetch(origin + "/", max_bytes=get_settings().crawl_max_body_bytes, retries=1, backoff_s=3.0)
        if r.ok:
            return r, origin
        if best is None or (r.status is not None and best.status is None):
            best, best_origin = r, origin
        if r.status is not None and 300 <= r.status < 600 and r.status not in (404, 410) and best.status is None:
            best, best_origin = r, origin
    return best or FetchResult(url=best_origin, final_url=best_origin, status=None, error="no response"), best_origin


def _pick_representative(
    candidates: list[tuple[str, str]], domain: str, robots: Robots, ua: str, limit: int, exclude: set[str]
) -> list[str]:
    """Round-robin over URL kinds so products, articles, categories and plain pages are all sampled."""
    by_kind: dict[str, list[str]] = {}
    seen: set[str] = set(exclude)
    for url, kind in candidates:
        if url in seen:
            continue
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        if parts.scheme not in ("http", "https") or not same_site(host, domain):
            continue
        if kind == "media":
            continue
        if not robots.allowed(url, ua):
            continue
        seen.add(url)
        by_kind.setdefault(kind, []).append(url)
    order = ["product", "article", "category", "page", "home"]
    picked: list[str] = []
    while len(picked) < limit and any(by_kind.values()):
        for kind in order:
            lst = by_kind.get(kind)
            if lst:
                picked.append(lst.pop(0))
                if len(picked) >= limit:
                    break
    return picked


class CrawlCollector:
    name = "crawl"
    sources = ("crawl",)
    cache_hours = 24 * 14

    async def collect(self, ctx: CollectorContext) -> CollectorResult:
        s = get_settings()
        ua = s.user_agent
        started = time.monotonic()
        requests = 0
        domain = ctx.domain
        throttle = HostThrottle(s.crawl_per_domain_delay_s)

        home, origin = await fetch_homepage(domain)
        requests += 4 if not home.ok else 1
        final_host = (urlsplit(home.final_url).hostname or "").lower()
        final_domain = (registrable_domain(final_host) or final_host) if final_host else None
        redirected_elsewhere = bool(final_domain and final_domain != domain)
        blocked_reason = looks_blocked(home)
        reachable = home.status is not None
        homepage_payload: dict = {
            "url": home.url,
            "final_url": home.final_url,
            "status": home.status,
            "error": home.error,
            "elapsed_ms": home.elapsed_ms,
            "headers": {k: v[:200] for k, v in home.headers.items() if k in INTERESTING_HEADERS},
            "redirected_to_other_domain": redirected_elsewhere,
            "final_domain": final_domain,
        }
        set_cookies = [v for k, v in home.headers.items() if k == "set-cookie"]
        home_page: PageInfo | None = None
        parked = False
        if home.ok and b"html" in home.headers.get("content-type", "text/html").encode():
            home_page = parse_html(home.body, home.final_url, domain)
            homepage_payload["page"] = home_page.to_dict()
            parked = looks_parked(home_page, home.body)
        elif home.ok:
            home_page = parse_html(home.body, home.final_url, domain)
            homepage_payload["page"] = home_page.to_dict()

        # Use the final origin (after redirects) for robots and sitemaps when it stays on our domain.
        crawl_origin = origin
        if home.ok and not redirected_elsewhere and final_host:
            crawl_origin = f"{urlsplit(home.final_url).scheme}://{final_host}"

        if not reachable:
            payload = {
                "domain": domain,
                "crawl_version": CRAWL_VERSION,
                "reachable": False,
                "blocked": False,
                "homepage": homepage_payload,
                "requests": requests,
                "duration_ms": int((time.monotonic() - started) * 1000),
            }
            return CollectorResult.ok([Observation("crawl", payload, CRAWL_VERSION, records=0)], http_status=None)

        await throttle.wait(urlsplit(crawl_origin).hostname or domain)
        robots, robots_resp = await fetch_robots(crawl_origin, ua)
        requests += 1
        if robots.crawl_delay:
            throttle.set_delay_for(urlsplit(crawl_origin).hostname or domain, max(robots.crawl_delay, s.crawl_per_domain_delay_s))
        if blocked_reason is None and looks_blocked(robots_resp):
            blocked_reason = looks_blocked(robots_resp)

        sitemaps = await collect_sitemaps(
            crawl_origin,
            robots.sitemaps,
            max_files=s.crawl_max_sitemaps,
            max_urls=s.crawl_max_sitemap_urls,
            throttle=throttle,
        )
        requests += sitemaps.fetched + sitemaps.failed

        # Representative pages.
        candidates: list[tuple[str, str]] = []
        for u in sitemaps.sample_urls:
            candidates.append((u, classify_path(urlsplit(u).path)))
        if home_page:
            for u in home_page.internal_urls:
                candidates.append((u, classify_path(urlsplit(u).path)))
        exclude = {home.final_url, home.url, crawl_origin + "/"}
        page_limit = (
            0 if (blocked_reason or parked or redirected_elsewhere or (s.crawl_respect_robots and robots.disallow_all)) else s.crawl_pages
        )
        to_fetch = _pick_representative(candidates, domain, robots, ua, page_limit, exclude) if page_limit else []

        pages: list[PageInfo] = []
        page_results: list[dict] = []
        statuses: Counter[str] = Counter()
        blocked_pages = 0
        html_samples: list[str] = [home.text()[:300_000]] if home.ok else []
        script_urls: list[str] = list(home_page.scripts) if home_page else []
        for url in to_fetch:
            host = urlsplit(url).hostname or domain
            await throttle.wait(host)
            r = await fetch(url, max_bytes=s.crawl_max_body_bytes, retries=0)
            requests += 1
            statuses[str(r.status or "error")] += 1
            if looks_blocked(r):
                blocked_pages += 1
            entry = {"url": url[:300], "status": r.status, "kind": classify_path(urlsplit(url).path)}
            if r.ok and b"html" in (r.headers.get("content-type", "text/html")).encode():
                p = parse_html(r.body, r.final_url, domain)
                pages.append(p)
                entry.update({"word_count": p.word_count, "title": (p.title or "")[:120] or None, "jsonld_types": p.jsonld_types[:6]})
                if len(html_samples) < 6:
                    html_samples.append(r.text()[:150_000])
                script_urls.extend(p.scripts)
                set_cookies.extend(v for k, v in r.headers.items() if k == "set-cookie")
            page_results.append(entry)
            if blocked_pages >= 3:
                break

        all_pages = ([home_page] if home_page else []) + pages
        tech = detect(
            html_samples=html_samples,
            script_urls=script_urls,
            headers=home.headers,
            set_cookies=set_cookies,
            generator=home_page.generator if home_page else None,
            dns_names=[],
        )

        # Structure signals.
        langs: set[str] = set(sitemaps.languages)
        hosts: set[str] = {h for h in sitemaps.hosts}
        schema_types: Counter[str] = Counter()
        jsonld_types: Counter[str] = Counter()
        kinds_from_links: Counter[str] = Counter()
        for p in all_pages:
            langs.update(p.hreflang)
            hosts.update(p.internal_hosts)
            schema_types.update(p.schema_types)
            jsonld_types.update(p.jsonld_types)
            for u in p.internal_urls:
                kinds_from_links[classify_path(urlsplit(u).path)] += 1
                lp = language_prefix(urlsplit(u).path)
                if lp:
                    langs.add(lp)
        langs.discard("x-default")
        if not langs and home_page and home_page.lang:
            langs.add(home_page.lang.split("-")[0])
        subdomains = sorted(h for h in hosts if h not in (domain, f"www.{domain}") and same_site(h, domain))
        sitemap_scale = (sitemaps.url_count_estimated / sitemaps.url_count) if sitemaps.url_count else 1.0
        structure = {
            "page_count_from_sitemap": sitemaps.url_count_estimated,
            "product_count": int(sitemaps.kinds.get("product", 0) * sitemap_scale),
            "article_count": int(sitemaps.kinds.get("article", 0) * sitemap_scale),
            "category_count": int(sitemaps.kinds.get("category", 0) * sitemap_scale),
            "counts_source": "sitemap" if sitemaps.url_count else "links",
            "links_product": kinds_from_links.get("product", 0),
            "links_article": kinds_from_links.get("article", 0),
            "links_category": kinds_from_links.get("category", 0),
            "language_count": len(langs),
            "languages": sorted(langs)[:30],
            "subdomain_count": len(subdomains),
            "subdomains": subdomains[:30],
        }
        if not sitemaps.url_count:
            structure["product_count"] = kinds_from_links.get("product", 0)
            structure["article_count"] = kinds_from_links.get("article", 0)
            structure["category_count"] = kinds_from_links.get("category", 0)

        n_ok = len(pages)
        pages_payload = {
            "requested": len(to_fetch),
            "fetched": len(page_results),
            "ok": n_ok,
            "blocked": blocked_pages,
            "statuses": dict(statuses),
            "avg_word_count": int(sum(p.word_count for p in pages) / n_ok) if n_ok else None,
            "avg_html_bytes": int(sum(p.html_bytes for p in pages) / n_ok) if n_ok else None,
            "avg_internal_links": int(sum(p.internal_links for p in pages) / n_ok) if n_ok else None,
            "noindex": sum(1 for p in pages if p.noindex),
            "schema_types": dict(schema_types.most_common(15)),
            "jsonld_types": dict(jsonld_types.most_common(15)),
            "sample": page_results[:20],
        }
        signals = {
            "has_rss": any(p.rss_feeds for p in all_pages),
            "has_search": any(p.has_search_form for p in all_pages),
            "og_present": bool(home_page and home_page.og),
            "jsonld_present": bool(home_page and home_page.jsonld_types),
            "generator": home_page.generator if home_page else None,
            "title": (home_page.title if home_page else None),
            "html_lang": home_page.lang if home_page else None,
            "homepage_word_count": home_page.word_count if home_page else None,
            "homepage_internal_links": home_page.internal_links if home_page else None,
            "homepage_external_links": home_page.external_links if home_page else None,
            "parked": parked,
        }
        payload = {
            "domain": domain,
            "crawl_version": CRAWL_VERSION,
            "origin": crawl_origin,
            "reachable": True,
            "blocked": blocked_reason is not None or blocked_pages >= 3,
            "blocked_reason": blocked_reason,
            "homepage": homepage_payload,
            "robots": robots.to_dict(),
            "sitemaps": sitemaps.to_dict(),
            "pages": pages_payload,
            "structure": structure,
            "tech": tech.to_dict(),
            "signals": signals,
            "requests": requests,
            "duration_ms": int((time.monotonic() - started) * 1000),
        }
        records = 1 + n_ok + sitemaps.fetched
        return CollectorResult.ok([Observation("crawl", payload, CRAWL_VERSION, records=records)], http_status=home.status)
