"""Sitemap discovery and parsing with a budget. Produces size and freshness signals, never traffic."""

from __future__ import annotations

import gzip
import logging
import random
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime
from urllib.parse import urlsplit

from lxml import etree

from ...http import fetch
from .urls import classify_path

log = logging.getLogger(__name__)

WELL_KNOWN = ("/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml", "/sitemap/sitemap.xml", "/wp-sitemap.xml")
MAX_SITEMAP_BYTES = 52_428_800  # 50 MB, the protocol limit


@dataclass
class SitemapStats:
    discovered: list[str] = field(default_factory=list)  # sitemap URLs found (robots + well-known)
    fetched: int = 0
    failed: int = 0
    indexes: int = 0  # sitemap index files seen
    children_declared: int = 0  # <sitemap> entries across all indexes
    children_parsed: int = 0
    url_count: int = 0  # <url> entries actually seen
    url_count_estimated: int = 0  # extrapolated when the budget stopped us
    truncated: bool = False
    kinds: Counter = field(default_factory=Counter)  # product/article/category/page/other/media
    lastmod_buckets: Counter = field(default_factory=Counter)  # 30d / 90d / 365d / older
    lastmod_min: str | None = None
    lastmod_max: str | None = None
    lastmod_count: int = 0
    hosts: Counter = field(default_factory=Counter)
    languages: set = field(default_factory=set)
    sample_urls: list[str] = field(default_factory=list)  # representative pages for the crawler
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "discovered": self.discovered[:20],
            "discovered_count": len(self.discovered),
            "fetched": self.fetched,
            "failed": self.failed,
            "indexes": self.indexes,
            "children_declared": self.children_declared,
            "children_parsed": self.children_parsed,
            "url_count": self.url_count,
            "url_count_estimated": self.url_count_estimated,
            "truncated": self.truncated,
            "kinds": dict(self.kinds),
            "lastmod_buckets": dict(self.lastmod_buckets),
            "lastmod_min": self.lastmod_min,
            "lastmod_max": self.lastmod_max,
            "lastmod_count": self.lastmod_count,
            "hosts": dict(self.hosts.most_common(20)),
            "languages": sorted(self.languages)[:50],
            "errors": self.errors[:10],
        }


def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def _maybe_gunzip(body: bytes, url: str, content_type: str) -> bytes:
    if body[:2] == b"\x1f\x8b":
        try:
            return gzip.decompress(body)
        except (OSError, EOFError):
            return body
    return body


_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")


def _lastmod_bucket(value: str, now: datetime) -> tuple[str, str] | None:
    m = _DATE_RE.match(value.strip())
    if not m:
        return None
    try:
        d = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=UTC)
    except ValueError:
        return None
    age = (now - d).days
    if age < 0:
        b = "30d"
    elif age <= 30:
        b = "30d"
    elif age <= 90:
        b = "90d"
    elif age <= 365:
        b = "365d"
    else:
        b = "older"
    return b, d.date().isoformat()


def parse_sitemap(body: bytes, base_url: str) -> tuple[str, list[dict]]:
    """Returns ("index", [{"loc", "lastmod"}]) or ("urlset", [{"loc", "lastmod", "langs"}]).
    Also accepts plain-text sitemaps (one URL per line)."""
    stripped = body.lstrip()
    if not stripped.startswith(b"<"):
        urls = [
            {"loc": line.strip(), "lastmod": None, "langs": []}
            for line in body.decode("utf-8", errors="replace").splitlines()
            if line.strip().startswith(("http://", "https://"))
        ]
        return "urlset", urls
    parser = etree.XMLParser(recover=True, huge_tree=True, resolve_entities=False, no_network=True)
    try:
        root = etree.fromstring(stripped, parser=parser)
    except (etree.XMLSyntaxError, ValueError):
        return "urlset", []
    if root is None:
        return "urlset", []
    kind = _localname(root.tag)
    items: list[dict] = []
    if kind == "sitemapindex":
        for sm in root:
            if _localname(sm.tag) != "sitemap":
                continue
            loc = lastmod = None
            for c in sm:
                ln = _localname(c.tag)
                if ln == "loc":
                    loc = (c.text or "").strip()
                elif ln == "lastmod":
                    lastmod = (c.text or "").strip()
            if loc:
                items.append({"loc": loc, "lastmod": lastmod})
        return "index", items
    for u in root:
        if _localname(u.tag) != "url":
            continue
        loc = lastmod = None
        langs: list[str] = []
        for c in u:
            ln = _localname(c.tag)
            if ln == "loc":
                loc = (c.text or "").strip()
            elif ln == "lastmod":
                lastmod = (c.text or "").strip()
            elif ln == "link":  # xhtml:link rel="alternate" hreflang="xx"
                hl = c.get("hreflang")
                if hl:
                    langs.append(hl.lower())
        if loc:
            items.append({"loc": loc, "lastmod": lastmod, "langs": langs})
    return "urlset", items


async def collect_sitemaps(
    origin: str,
    robots_sitemaps: list[str],
    *,
    max_files: int,
    max_urls: int,
    sample_size: int = 40,
    throttle=None,
) -> SitemapStats:
    """Breadth-first over sitemap indexes with a file and URL budget."""
    stats = SitemapStats()
    now = datetime.now(UTC)
    seen: set[str] = set()
    queue: list[str] = []
    for u in robots_sitemaps:
        if u not in seen:
            seen.add(u)
            queue.append(u)
    stats.discovered = list(queue)
    probe_well_known = not queue
    if probe_well_known:
        for path in WELL_KNOWN:
            u = origin.rstrip("/") + path
            seen.add(u)
            queue.append(u)
    reservoir: list[str] = []
    reservoir_seen = 0
    index_child_counts: list[int] = []  # urls per parsed child, for extrapolation
    children_total = 0

    while queue and stats.fetched + stats.failed < max_files:
        url = queue.pop(0)
        host = urlsplit(url).hostname or ""
        if throttle is not None and host:
            await throttle.wait(host)
        r = await fetch(url, max_bytes=MAX_SITEMAP_BYTES, retries=1, backoff_s=2.0, timeout_s=30.0)
        if not r.ok:
            stats.failed += 1
            if r.status not in (404, 403, 410, None) or not probe_well_known:
                stats.errors.append(f"{url}: {r.status or r.error}")
            continue
        if probe_well_known and url not in stats.discovered:
            stats.discovered.append(url)
        body = _maybe_gunzip(r.body, url, r.headers.get("content-type", ""))
        if b"<html" in body[:1000].lower():
            stats.failed += 1
            continue
        stats.fetched += 1
        kind, items = parse_sitemap(body, url)
        if kind == "index":
            stats.indexes += 1
            stats.children_declared += len(items)
            children_total += len(items)
            # Parse a spread of children (first, middle, last ...) rather than only the first ones,
            # so product/article sitemaps far down the index are represented.
            budget_left = max_files - (stats.fetched + stats.failed) - len(queue)
            picks = items if len(items) <= budget_left else _spread(items, max(budget_left, 1))
            for child in picks:
                loc = child["loc"]
                if loc not in seen:
                    seen.add(loc)
                    queue.append(loc)
            if len(picks) < len(items):
                stats.truncated = True
            if probe_well_known:
                # A real index was found at a well-known path: stop probing the other guesses.
                queue = [q for q in queue if q not in (origin.rstrip("/") + p for p in WELL_KNOWN)]
                probe_well_known = False
            continue
        if probe_well_known and items:
            queue = [q for q in queue if q not in (origin.rstrip("/") + p for p in WELL_KNOWN)]
            probe_well_known = False
        n = len(items)
        stats.children_parsed += 1
        index_child_counts.append(n)
        for it in items:
            stats.url_count += 1
            loc = it["loc"]
            parts = urlsplit(loc)
            if parts.hostname:
                stats.hosts[parts.hostname.lower()] += 1
            stats.kinds[classify_path(parts.path or "/")] += 1
            for lang in it.get("langs") or []:
                stats.languages.add(lang)
            lm = it.get("lastmod")
            if lm:
                b = _lastmod_bucket(lm, now)
                if b:
                    stats.lastmod_count += 1
                    stats.lastmod_buckets[b[0]] += 1
                    stats.lastmod_min = b[1] if stats.lastmod_min is None or b[1] < stats.lastmod_min else stats.lastmod_min
                    stats.lastmod_max = b[1] if stats.lastmod_max is None or b[1] > stats.lastmod_max else stats.lastmod_max
            # Reservoir sample of URLs for the representative crawl.
            reservoir_seen += 1
            if len(reservoir) < sample_size:
                reservoir.append(loc)
            else:
                j = random.randint(0, reservoir_seen - 1)
                if j < sample_size:
                    reservoir[j] = loc
            if stats.url_count >= max_urls:
                stats.truncated = True
                break
        if stats.url_count >= max_urls:
            break
    if queue:
        stats.truncated = True
    # Extrapolate total size when we could not parse every child of the index(es).
    if stats.truncated and index_child_counts and children_total > stats.children_parsed:
        avg = sum(index_child_counts) / len(index_child_counts)
        stats.url_count_estimated = int(stats.url_count + avg * (children_total - stats.children_parsed))
    else:
        stats.url_count_estimated = stats.url_count
    stats.sample_urls = reservoir
    return stats


def _spread(items: list, k: int) -> list:
    if k >= len(items):
        return list(items)
    step = len(items) / k
    return [items[int(i * step)] for i in range(k)]
