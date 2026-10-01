"""HTML page analysis: metadata, structure and link signals. Keeps counts and short strings, never
the page body."""

from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlsplit

from lxml import etree
from lxml import html as lxml_html

from ...domains import same_site

_WS_RE = re.compile(r"\s+")


@dataclass
class PageInfo:
    url: str
    title: str | None = None
    meta_description: str | None = None
    lang: str | None = None
    canonical: str | None = None
    meta_robots: str | None = None
    generator: str | None = None
    headings: dict[str, int] = field(default_factory=dict)
    og: dict[str, str] = field(default_factory=dict)
    jsonld_types: list[str] = field(default_factory=list)
    schema_types: list[str] = field(default_factory=list)  # microdata itemtype + JSON-LD @type
    hreflang: list[str] = field(default_factory=list)
    internal_links: int = 0
    external_links: int = 0
    internal_hosts: set = field(default_factory=set)
    internal_urls: list[str] = field(default_factory=list)  # sample for crawling
    scripts: list[str] = field(default_factory=list)  # external script src (lower-cased)
    inline_script_bytes: int = 0
    images: int = 0
    forms: int = 0
    word_count: int = 0
    html_bytes: int = 0
    noindex: bool = False
    rss_feeds: int = 0
    has_search_form: bool = False
    text_sample: str = ""  # first 2k characters of visible text, for tech detection
    comments_sample: str = ""

    def to_dict(self) -> dict:
        return {
            "url": self.url,
            "title": (self.title or "")[:300] or None,
            "meta_description": (self.meta_description or "")[:500] or None,
            "lang": self.lang,
            "canonical": self.canonical,
            "meta_robots": self.meta_robots,
            "generator": self.generator,
            "headings": self.headings,
            "og": {k: v[:200] for k, v in list(self.og.items())[:12]},
            "jsonld_types": self.jsonld_types[:20],
            "schema_types": self.schema_types[:20],
            "hreflang": self.hreflang[:50],
            "internal_links": self.internal_links,
            "external_links": self.external_links,
            "internal_hosts": sorted(self.internal_hosts)[:30],
            "images": self.images,
            "forms": self.forms,
            "word_count": self.word_count,
            "html_bytes": self.html_bytes,
            "noindex": self.noindex,
            "rss_feeds": self.rss_feeds,
            "has_search_form": self.has_search_form,
            "script_count": len(self.scripts),
        }


def _norm_space(s: str | None) -> str | None:
    if not s:
        return None
    s = _WS_RE.sub(" ", s).strip()
    return s or None


def _collect_types(node: object, out: list[str]) -> None:
    if isinstance(node, dict):
        t = node.get("@type")
        if isinstance(t, str):
            out.append(t)
        elif isinstance(t, list):
            out.extend(x for x in t if isinstance(x, str))
        for v in node.values():
            if isinstance(v, (dict, list)):
                _collect_types(v, out)
    elif isinstance(node, list):
        for v in node:
            _collect_types(v, out)


def parse_html(body: bytes, url: str, domain: str) -> PageInfo:
    info = PageInfo(url=url, html_bytes=len(body))
    try:
        doc = lxml_html.fromstring(body, base_url=url)
    except (etree.ParserError, ValueError):
        return info
    if doc is None:
        return info
    head_title = doc.find(".//title")
    info.title = _norm_space(head_title.text_content() if head_title is not None else None)
    info.lang = (doc.get("lang") or "").strip().lower() or None

    for meta in doc.iter("meta"):
        name = (meta.get("name") or "").strip().lower()
        prop = (meta.get("property") or "").strip().lower()
        content = meta.get("content")
        if name == "description":
            info.meta_description = _norm_space(content)
        elif name == "robots":
            info.meta_robots = _norm_space(content)
            if content and "noindex" in content.lower():
                info.noindex = True
        elif name == "generator":
            info.generator = _norm_space(content)
        elif prop.startswith("og:") and content and len(info.og) < 20:
            info.og[prop[3:]] = _norm_space(content) or ""

    heads: Counter[str] = Counter()
    for tag in ("h1", "h2", "h3"):
        heads[tag] = sum(1 for _ in doc.iter(tag))
    info.headings = dict(heads)

    for link in doc.iter("link"):
        rel = (link.get("rel") or "").lower().split()
        href = link.get("href")
        if "canonical" in rel and href:
            info.canonical = urljoin(url, href.strip())
        elif "alternate" in rel:
            hl = link.get("hreflang")
            if hl:
                info.hreflang.append(hl.lower())
            typ = (link.get("type") or "").lower()
            if "rss" in typ or "atom" in typ:
                info.rss_feeds += 1

    jsonld: list[str] = []
    for script in doc.iter("script"):
        src = script.get("src")
        if src:
            info.scripts.append(urljoin(url, src.strip()).lower()[:300])
            continue
        typ = (script.get("type") or "").lower()
        text = script.text or ""
        if "ld+json" in typ:
            try:
                _collect_types(json.loads(text), jsonld)
            except (ValueError, TypeError):
                pass
        else:
            info.inline_script_bytes += len(text)
    info.jsonld_types = sorted(set(jsonld))
    micro = {it.rsplit("/", 1)[-1] for it in doc.xpath("//*[@itemtype]/@itemtype") if isinstance(it, str)}
    info.schema_types = sorted(set(jsonld) | micro)

    page_host = (urlsplit(url).hostname or "").lower()
    internal_sample: list[str] = []
    seen: set[str] = set()
    for a in doc.iter("a"):
        href = a.get("href")
        if not href:
            continue
        href = href.strip()
        if href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        absolute = urljoin(url, href)
        parts = urlsplit(absolute)
        if parts.scheme not in ("http", "https"):
            continue
        host = (parts.hostname or "").lower()
        if host and (host == page_host or same_site(host, domain)):
            info.internal_links += 1
            info.internal_hosts.add(host)
            clean = parts._replace(fragment="").geturl()
            if clean not in seen and len(internal_sample) < 300:
                seen.add(clean)
                internal_sample.append(clean)
        elif host:
            info.external_links += 1
    info.internal_urls = internal_sample

    info.images = sum(1 for _ in doc.iter("img"))
    forms = list(doc.iter("form"))
    info.forms = len(forms)
    for f in forms:
        role = (f.get("role") or "").lower()
        if role == "search" or f.xpath(".//input[@type='search']") or "search" in (f.get("action") or "").lower():
            info.has_search_form = True
            break

    # Visible text: drop script/style/noscript/template before extracting.
    for bad in doc.xpath("//script|//style|//noscript|//template|//svg"):
        parent = bad.getparent()
        if parent is not None:
            parent.remove(bad)
    text = _WS_RE.sub(" ", doc.text_content() or "").strip()
    info.word_count = len(text.split())
    info.text_sample = text[:2000]
    comments = [c.text or "" for c in doc.iter(etree.Comment)]
    info.comments_sample = " ".join(comments)[:2000]
    return info
