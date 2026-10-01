"""Worker: claims tasks from the Postgres queue and runs them with bounded concurrency.

Run many of these (docker compose --scale traffic-worker=N); they share nothing but the database.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import socket
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from . import pipeline, queue
from .collectors import enabled_collectors
from .db import connection, dispose_engine, migrate
from .http import close_client
from .lists.loader import build_providers, refresh_provider
from .settings import get_settings

log = logging.getLogger(__name__)


class Worker:
    def __init__(self) -> None:
        self.s = get_settings()
        self.worker_id = f"{socket.gethostname()}:{os.getpid()}"
        self.collectors = enabled_collectors()
        self.stop = asyncio.Event()
        self.inflight: set[asyncio.Task] = set()

    # ------------------------------------------------------------------ main loop
    async def run(self) -> None:
        if self.s.migrate_on_start:
            await migrate()
        log.info("worker %s started; collectors=%s concurrency=%d", self.worker_id, list(self.collectors), self.s.worker_concurrency)
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, self.stop.set)
            except NotImplementedError:
                pass
        recover_at = datetime.now(UTC)
        idle_sleep = self.s.worker_poll_interval_s
        while not self.stop.is_set():
            self.inflight = {t for t in self.inflight if not t.done()}
            if datetime.now(UTC) >= recover_at:
                async with connection() as conn:
                    n = await queue.recover_lost(conn)
                if n:
                    log.warning("recovered %d lost task(s)", n)
                recover_at = datetime.now(UTC) + timedelta(seconds=60)
            if len(self.inflight) >= self.s.worker_concurrency:
                await self._wait_any()
                continue
            task = await self._claim()
            if task is None:
                try:
                    await asyncio.wait_for(self.stop.wait(), timeout=idle_sleep)
                except TimeoutError:
                    pass
                continue
            t = asyncio.create_task(self._execute(task), name=f"task-{task.id}-{task.kind}")
            self.inflight.add(t)
        log.info("worker stopping; waiting for %d task(s)", len(self.inflight))
        if self.inflight:
            await asyncio.wait(self.inflight, timeout=self.s.task_lease_s)
        await close_client()
        await dispose_engine()

    async def _wait_any(self) -> None:
        if self.inflight:
            await asyncio.wait(self.inflight, return_when=asyncio.FIRST_COMPLETED, timeout=self.s.worker_poll_interval_s)

    async def _claim(self) -> queue.Task | None:
        kinds = list(self.collectors) + [pipeline.FINALIZE_KIND, "list_refresh"]
        async with connection() as conn:
            return await queue.claim(
                conn, worker_id=self.worker_id, lease_s=self.s.task_lease_s, kind_caps=self.s.source_concurrency, kinds=kinds
            )

    # ------------------------------------------------------------------ execution
    async def _execute(self, task: queue.Task) -> None:
        heartbeat = asyncio.create_task(self._heartbeat(task.id))
        try:
            if task.kind in self.collectors:
                await self._run_collector(task)
            elif task.kind == pipeline.FINALIZE_KIND:
                await self._run_simple(task, pipeline.finalize_run(task.run_id))  # type: ignore[arg-type]
            elif task.kind == "list_refresh":
                provider = build_providers().get(task.payload.get("provider", ""))
                if provider is None:
                    await self._finish(task, "skipped", f"provider {task.payload.get('provider')!r} not enabled")
                else:
                    await self._run_simple(task, refresh_provider(provider, force=bool(task.payload.get("force"))))
            else:
                await self._finish(task, "failed", f"unknown task kind {task.kind}")
        except Exception as e:  # noqa: BLE001
            log.exception("task %d (%s) crashed", task.id, task.kind)
            await self._fail(task, f"{type(e).__name__}: {e}", retry=True)
        finally:
            heartbeat.cancel()

    async def _run_collector(self, task: queue.Task) -> None:
        collector = self.collectors[task.kind]
        result = await pipeline.run_collector_task(task, collector, self.worker_id)
        if result.status == "success":
            await self._finish(task, "succeeded")
        elif result.status == "skipped":
            await self._finish(task, "skipped", result.error)
        elif result.status == "defer":
            await self._defer(task, result.defer_seconds, result.error)
            return
        else:
            await self._fail(task, result.error or "failed", retry=result.retryable)
        await self._after_collector(task)

    async def _run_simple(self, task: queue.Task, coro) -> None:
        out = await coro
        log.info("task %d %s done: %s", task.id, task.kind, _short(out))
        await self._finish(task, "succeeded")
        if task.kind == pipeline.FINALIZE_KIND:
            return

    async def _after_collector(self, task: queue.Task) -> None:
        if task.run_id is None:
            return
        async with connection() as conn:
            # Only when the task is terminal (not re-queued for retry).
            status = (await conn.execute(text("SELECT status FROM tasks WHERE id = :id"), {"id": task.id})).scalar_one()
            if status in ("succeeded", "failed", "skipped"):
                await pipeline.maybe_finalize(conn, task.run_id)

    async def _finish(self, task: queue.Task, status: str, error: str | None = None) -> None:
        async with connection() as conn:
            await queue.complete(conn, task.id, status=status, error=error)
            if status == "failed" and task.run_id is not None and task.kind == pipeline.FINALIZE_KIND:
                await conn.execute(
                    text("UPDATE pipeline_runs SET status = 'failed', finished_at = now(), error = :e WHERE id = :r"),
                    {"e": (error or "")[:1000], "r": task.run_id},
                )

    async def _fail(self, task: queue.Task, error: str, *, retry: bool) -> None:
        async with connection() as conn:
            new_status = await queue.fail(conn, task, error, retry=retry, base_delay_s=self.s.task_retry_base_s)
            log.warning(
                "task %d %s failed (attempt %d/%d) -> %s: %s", task.id, task.kind, task.attempts, task.max_attempts, new_status, error[:200]
            )
            if new_status == "failed" and task.kind == pipeline.FINALIZE_KIND and task.run_id is not None:
                await conn.execute(
                    text("UPDATE pipeline_runs SET status = 'failed', finished_at = now(), error = :e WHERE id = :r"),
                    {"e": error[:1000], "r": task.run_id},
                )

    async def _defer(self, task: queue.Task, seconds: int, reason: str | None) -> None:
        async with connection() as conn:
            await conn.execute(
                text(
                    "UPDATE tasks SET status = 'queued', attempts = GREATEST(attempts - 1, 0), locked_by = NULL, lease_until = NULL,"
                    " run_after = now() + make_interval(secs => :s), error = :e,"
                    " payload = payload || jsonb_build_object('defers', COALESCE((payload->>'defers')::int, 0) + 1)"
                    " WHERE id = :id"
                ),
                {"s": max(seconds, 5), "e": (reason or "deferred")[:500], "id": task.id},
            )
        log.info("task %d %s deferred %ds: %s", task.id, task.kind, seconds, reason)

    async def _heartbeat(self, task_id: int) -> None:
        interval = max(10, self.s.task_lease_s // 3)
        try:
            while True:
                await asyncio.sleep(interval)
                async with connection() as conn:
                    await queue.extend_lease(conn, task_id, self.s.task_lease_s)
        except asyncio.CancelledError:
            return


def _short(v: object) -> str:
    s = repr(v)
    return s if len(s) < 300 else s[:300] + "..."


def main() -> None:
    asyncio.run(Worker().run())
