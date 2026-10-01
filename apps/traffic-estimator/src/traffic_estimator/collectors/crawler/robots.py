"""robots.txt: fetch, parse (Protego, RFC 9309), and answer allow/crawl-delay/sitemap questions."""

from __future__ import annotations

from dataclasses import dataclass, field

from protego import Protego

from ...http import FetchResult, fetch

MAX_CRAWL_DELAY_S = 10.0


@dataclass
class Robots:
    url: str | None
    status: int | None
    found: bool
    allow_all: bool = True  # True when no robots.txt or it does not restrict us
    disallow_all: bool = False
    crawl_delay: float | None = None
    sitemaps: list[str] = field(default_factory=list)
    _parser: Protego | None = field(default=None, repr=False)
    error: str | None = None

    def allowed(self, url: str, user_agent: str) -> bool:
        if self._parser is None:
            return True
        return bool(self._parser.can_fetch(url, user_agent))

    def to_dict(self) -> dict:
        return {
            "url": self.url,
            "status": self.status,
            "found": self.found,
            "disallow_all": self.disallow_all,
            "crawl_delay": self.crawl_delay,
            "sitemaps": self.sitemaps[:50],
            "sitemap_count": len(self.sitemaps),
            "error": self.error,
        }


def parse_robots(content: str, user_agent: str, url: str | None = None, status: int | None = 200) -> Robots:
    try:
        parser = Protego.parse(content)
    except Exception as e:  # noqa: BLE001 - malformed robots: treat as absent
        return Robots(url=url, status=status, found=True, error=f"parse error: {e}")
    delay = parser.crawl_delay(user_agent)
    if delay is None:
        rate = parser.request_rate(user_agent)
        if rate and rate.requests:
            delay = rate.seconds / rate.requests
    sitemaps = [s for s in parser.sitemaps if isinstance(s, str) and s.startswith(("http://", "https://"))]
    disallow_all = not parser.can_fetch("/", user_agent) and not parser.can_fetch("/index.html", user_agent)
    return Robots(
        url=url,
        status=status,
        found=True,
        allow_all=not disallow_all and parser.can_fetch("/", user_agent),
        disallow_all=disallow_all,
        crawl_delay=min(float(delay), MAX_CRAWL_DELAY_S) if delay else None,
        sitemaps=sitemaps,
        _parser=parser,
    )


async def fetch_robots(origin: str, user_agent: str) -> tuple[Robots, FetchResult]:
    """origin like https://example.com (no path)."""
    url = f"{origin.rstrip('/')}/robots.txt"
    r = await fetch(url, max_bytes=512_000, retries=1, backoff_s=2.0)
    if r.ok:
        ctype = r.headers.get("content-type", "")
        if "html" in ctype and b"<html" in r.body[:2000].lower():
            # Many sites return their 200 HTML page for unknown paths: no real robots.txt.
            return Robots(url=url, status=r.status, found=False), r
        return parse_robots(r.text(), user_agent, url=url, status=r.status), r
    if r.status is not None and 400 <= r.status < 500:
        return Robots(url=url, status=r.status, found=False), r
    # 5xx / network error: RFC 9309 says treat as full disallow when unreachable for a long time;
    # we are a one-shot crawler, so record the error and stay conservative: allow homepage only.
    return Robots(url=url, status=r.status, found=False, error=r.error or f"HTTP {r.status}"), r
