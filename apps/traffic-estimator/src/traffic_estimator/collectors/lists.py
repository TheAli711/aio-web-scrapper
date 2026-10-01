"""Collector "lists": look the domain up in every loaded ranked list (Tranco, Majestic, Open PageRank,
CrUX top list, Common Crawl web graph index). One cheap task per domain, no external requests.

If a provider's list is still being downloaded/loaded, the task is deferred and re-queued.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import text

from ..db import connection
from ..lists.loader import build_providers, lookup
from ..queue import enqueue
from .base import CollectorContext, CollectorResult, Observation

log = logging.getLogger(__name__)

MAX_DEFERS = 40  # give up waiting for lists after this many deferrals and use what is loaded


class ListsCollector:
    name = "lists"
    sources = ("tranco", "majestic", "openpagerank", "crux_top", "cc_webgraph")
    cache_hours = 24 * 7

    async def collect(self, ctx: CollectorContext) -> CollectorResult:
        providers = build_providers()
        if not providers:
            return CollectorResult.skipped("no list providers enabled")
        defers = int(ctx.payload.get("defers", 0))
        async with connection() as conn:
            hits = await lookup(conn, ctx.domain, providers)
            missing = [h for h in hits.values() if h.status == "no_list"]
            if missing and defers < MAX_DEFERS:
                for h in missing:
                    await enqueue(
                        conn,
                        kind="list_refresh",
                        payload={"provider": h.provider},
                        # Hourly: a refresh that already ran today (or failed) must not block a rebuild
                        # of a list that went missing since (dedupe keys stay taken after completion).
                        dedupe_key=f"list_refresh:{h.provider}:{datetime.now(UTC):%Y-%m-%dT%H}",
                        max_attempts=3,
                        priority=10,
                    )
                return CollectorResult.defer(120, f"waiting for lists: {', '.join(h.provider for h in missing)}")
        observations: list[Observation] = []
        for name, hit in hits.items():
            if hit.status == "no_list":
                continue
            payload = {
                "status": hit.status,
                "list_id": hit.list_id,
                "list_date": hit.list_date.isoformat() if hit.list_date else None,
                "list_size": hit.list_size,
            }
            if hit.entry:
                payload.update(hit.entry)
            observations.append(Observation(source=name, payload=payload, source_version=hit.list_id, records=1 if hit.entry else 0))
        if not observations:
            return CollectorResult.failed("no ranked list loaded", retryable=False)
        return CollectorResult.ok(observations)


async def active_list_versions() -> dict[str, str]:
    async with connection() as conn:
        rows = await conn.execute(text("SELECT provider, list_id FROM ranked_lists WHERE active"))
        return {r[0]: r[1] for r in rows}
