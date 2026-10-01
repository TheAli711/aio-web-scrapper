"""Collector "commoncrawl": per-domain query of the Common Crawl CDX index server.

What it gives: how many URLs of the domain (and its subdomains) Common Crawl captured in the N most
recent crawls, unique paths/subdomains, status and content-type distribution, first/last capture.

Limits (verified 2026-10-01): index.commoncrawl.org is "frequently abused and therefore heavily
rate limited"; 503/504 are common and repeated offenders are blocked for ~24h. This collector runs
with a global concurrency of 1 and ~0.5 req/s, retries with long back-off and gives up cleanly. It is
fine for hundreds of domains a day; for 100k+ domains disable it (TE_ENABLED_COLLECTORS) and rely on
the web graph + bulk lists, or run the offline columnar-index aggregation described in the docs.
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from datetime import UTC, datetime, timedelta
from urllib.parse import quote, urlsplit

from sqlalchemy import text

from ..db import connection
from ..http import fetch
from ..settings import get_settings
from .base import CollectorContext, CollectorResult, Observation

log = logging.getLogger(__name__)

COLLINFO_TTL = timedelta(hours=24)
FIELDS = "url,timestamp,status,mime-detected,digest"


COOLDOWN_KEY = "commoncrawl:cooldown"
CONSECUTIVE_FAILURES_TO_COOL = 3
COOLDOWN = timedelta(minutes=15)


class CommonCrawlCollector:
    name = "commoncrawl"
    sources = ("commoncrawl",)
    cache_hours = 24 * 30

    async def collect(self, ctx: CollectorContext) -> CollectorResult:
        s = get_settings()
        cooldown = await _cooldown_state()
        until = cooldown.get("until")
        if until and datetime.fromisoformat(until) > datetime.now(UTC):
            # Circuit breaker: the index server is throttling us; do not burn attempts, let the
            # estimate proceed without this source (confidence drops accordingly).
            return CollectorResult.failed(f"CDX index unavailable (cooldown until {until})", retryable=False)
        crawls = await latest_crawls(s.commoncrawl_crawl_count)
        if not crawls:
            return CollectorResult.failed("cannot list Common Crawl indexes (collinfo.json)")
        per_crawl: dict[str, dict] = {}
        last_status: int | None = None
        for crawl in crawls:
            url = (
                f"{crawl['cdx-api']}?url={quote(ctx.domain, safe='')}&matchType=domain&output=json"
                f"&fl={FIELDS}&limit={s.commoncrawl_max_records}"
            )
            # The index gateway times out after ~60 s when throttling; do not wait longer than that.
            r = await fetch(url, limiter_key="commoncrawl", max_bytes=20_000_000, retries=1, backoff_s=10.0, timeout_s=45.0)
            last_status = r.status
            if r.status == 404:
                per_crawl[crawl["id"]] = {"url_count": 0, "status": "no_captures"}
                continue
            if not r.ok:
                await _record_failure(r.status)
                # One failing crawl fails the whole task so that the retry (with back-off) re-queries
                # everything; a partial answer would under-count.
                return CollectorResult.failed(f"CDX {crawl['id']}: status={r.status} err={r.error}", http_status=r.status)
            per_crawl[crawl["id"]] = summarize_cdx(r.body, truncated=r.truncated or False)
            per_crawl[crawl["id"]]["limit_hit"] = per_crawl[crawl["id"]]["url_count"] >= s.commoncrawl_max_records
        await _record_success()
        payload = aggregate(ctx.domain, per_crawl)
        payload["crawls"] = [c["id"] for c in crawls]
        return CollectorResult.ok(
            [Observation(source="commoncrawl", payload=payload, source_version=",".join(payload["crawls"]), records=payload["url_count"])],
            http_status=last_status,
        )


async def _cooldown_state() -> dict:
    async with connection() as conn:
        row = (await conn.execute(text("SELECT value FROM kv_cache WHERE key = :k"), {"k": COOLDOWN_KEY})).first()
    return dict(row[0]) if row else {}


async def _save_cooldown(state: dict) -> None:
    async with connection() as conn:
        await conn.execute(
            text(
                "INSERT INTO kv_cache (key, value, fetched_at) VALUES (:k, CAST(:v AS jsonb), now())"
                " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, fetched_at = now()"
            ),
            {"k": COOLDOWN_KEY, "v": json.dumps(state)},
        )


async def _record_failure(status: int | None) -> None:
    if status is not None and status < 500 and status != 429:
        return
    state = await _cooldown_state()
    failures = int(state.get("failures", 0)) + 1
    state["failures"] = failures
    if failures >= CONSECUTIVE_FAILURES_TO_COOL:
        state["until"] = (datetime.now(UTC) + COOLDOWN).isoformat()
        state["failures"] = 0
        log.warning("Common Crawl index throttling us (%d consecutive failures); cooling down until %s", failures, state["until"])
    await _save_cooldown(state)


async def _record_success() -> None:
    state = await _cooldown_state()
    if state.get("failures") or state.get("until"):
        await _save_cooldown({"failures": 0})


async def latest_crawls(n: int) -> list[dict]:
    s = get_settings()
    async with connection() as conn:
        row = (await conn.execute(text("SELECT value, fetched_at FROM kv_cache WHERE key = 'commoncrawl:collinfo'"))).first()
    if row and row[1] and row[1] > datetime.now(UTC) - COLLINFO_TTL:
        return list(row[0])[:n]
    r = await fetch(f"{s.commoncrawl_index_url}/collinfo.json", limiter_key="commoncrawl", max_bytes=2_000_000)
    if not r.ok:
        return list(row[0])[:n] if row else []
    crawls = [{"id": c["id"], "cdx-api": c["cdx-api"], "from": c.get("from"), "to": c.get("to")} for c in r.json()]
    async with connection() as conn:
        await conn.execute(
            text(
                "INSERT INTO kv_cache (key, value, fetched_at) VALUES ('commoncrawl:collinfo', CAST(:v AS jsonb), now())"
                " ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, fetched_at = now()"
            ),
            {"v": json.dumps(crawls)},
        )
    return crawls[:n]


def summarize_cdx(body: bytes, *, truncated: bool = False) -> dict:
    """Summarise NDJSON CDX records (one JSON object per line) without keeping the URLs."""
    urls = 0
    paths: set[str] = set()
    hosts: Counter[str] = Counter()
    statuses: Counter[str] = Counter()
    mimes: Counter[str] = Counter()
    digests: set[str] = set()
    first = last = None
    lines = body.split(b"\n")
    if truncated and lines:
        lines = lines[:-1]
    for line in lines:
        line = line.strip()
        if not line or not line.startswith(b"{"):
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        url = rec.get("url") or ""
        if not url:
            continue
        urls += 1
        parts = urlsplit(url)
        host = parts.hostname or ""
        hosts[host] += 1
        if len(paths) < 200_000:
            paths.add(f"{host}{parts.path or '/'}")
        statuses[str(rec.get("status", "?"))] += 1
        mimes[(rec.get("mime-detected") or rec.get("mime") or "?").split(";")[0]] += 1
        d = rec.get("digest")
        if d and len(digests) < 200_000:
            digests.add(d)
        ts = rec.get("timestamp")
        if ts:
            first = ts if first is None or ts < first else first
            last = ts if last is None or ts > last else last
    return {
        "url_count": urls,
        "unique_paths": len(paths),
        "unique_digests": len(digests),
        "subdomains": len(hosts),
        "hosts_top": dict(hosts.most_common(10)),
        "status_counts": dict(statuses.most_common(10)),
        "mime_counts": dict(mimes.most_common(10)),
        "first_timestamp": first,
        "last_timestamp": last,
        "status": "ok" if urls else "no_captures",
    }


def aggregate(domain: str, per_crawl: dict[str, dict]) -> dict:
    url_count = sum(c.get("url_count", 0) for c in per_crawl.values())
    crawls_with_data = sum(1 for c in per_crawl.values() if c.get("url_count", 0) > 0)
    firsts = [c["first_timestamp"] for c in per_crawl.values() if c.get("first_timestamp")]
    lasts = [c["last_timestamp"] for c in per_crawl.values() if c.get("last_timestamp")]
    mimes: Counter[str] = Counter()
    statuses: Counter[str] = Counter()
    for c in per_crawl.values():
        mimes.update(c.get("mime_counts", {}))
        statuses.update(c.get("status_counts", {}))
    html = sum(v for k, v in mimes.items() if "html" in k)
    return {
        "domain": domain,
        "url_count": url_count,
        "url_count_max_crawl": max((c.get("url_count", 0) for c in per_crawl.values()), default=0),
        "unique_paths_max_crawl": max((c.get("unique_paths", 0) for c in per_crawl.values()), default=0),
        "unique_subdomains_max_crawl": max((c.get("subdomains", 0) for c in per_crawl.values()), default=0),
        "crawl_count": crawls_with_data,
        "crawls_queried": len(per_crawl),
        "first_seen": min(firsts) if firsts else None,
        "last_seen": max(lasts) if lasts else None,
        "html_share": round(html / url_count, 3) if url_count else None,
        "status_200_share": round(statuses.get("200", 0) / url_count, 3) if url_count else None,
        "content_types": dict(mimes.most_common(8)),
        "limit_hit": any(c.get("limit_hit") for c in per_crawl.values()),
        "per_crawl": {k: {kk: vv for kk, vv in v.items() if kk not in ("hosts_top",)} for k, v in per_crawl.items()},
    }
