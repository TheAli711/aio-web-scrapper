"""Scheduler: a tiny loop that enqueues maintenance work (ranked-list refreshes, lost-task recovery,
stale-run cleanup). Exactly one instance should run; it does no heavy work itself."""

from __future__ import annotations

import asyncio
import logging
import signal
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from . import queue
from .db import connection, dispose_engine, migrate
from .lists.loader import build_providers
from .settings import get_settings

log = logging.getLogger(__name__)

TICK_S = 60
STALE_RUN_HOURS = 24


async def tick() -> None:
    providers = build_providers()
    async with connection() as conn:
        rows = await conn.execute(text("SELECT provider, downloaded_at FROM ranked_lists WHERE active"))
        active = {r[0]: r[1] for r in rows}
        today = datetime.now(UTC).strftime("%Y-%m-%d")
        for name, p in providers.items():
            last = active.get(name)
            if last is None or last < datetime.now(UTC) - timedelta(hours=p.refresh_hours):
                tid = await queue.enqueue(
                    conn,
                    kind="list_refresh",
                    payload={"provider": name},
                    dedupe_key=f"list_refresh:{name}:{today}",
                    max_attempts=3,
                    priority=10,
                )
                if tid:
                    log.info("scheduled refresh of %s list (last=%s)", name, last)
        n = await queue.recover_lost(conn)
        if n:
            log.warning("recovered %d lost task(s)", n)
        # Runs that never finalized (e.g. a crashed worker between the last task and finalize).
        stale = await conn.execute(
            text(
                """
                SELECT r.id FROM pipeline_runs r
                WHERE r.status IN ('queued', 'running')
                  AND r.created_at < now() - make_interval(hours => :h)
                  AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.run_id = r.id AND t.status IN ('queued', 'running'))
                LIMIT 100
                """
            ),
            {"h": STALE_RUN_HOURS},
        )
        for (run_id,) in stale:
            from .pipeline import maybe_finalize

            await maybe_finalize(conn, int(run_id))


async def run() -> None:
    s = get_settings()
    if s.migrate_on_start:
        await migrate()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:
            pass
    log.info("scheduler started (tick every %ds)", TICK_S)
    while not stop.is_set():
        try:
            await tick()
        except Exception:  # noqa: BLE001
            log.exception("scheduler tick failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=TICK_S)
        except TimeoutError:
            pass
    await dispose_engine()


def main() -> None:
    asyncio.run(run())
