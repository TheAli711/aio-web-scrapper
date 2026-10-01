"""Postgres-backed task queue.

Why not Celery/RQ: the pipeline needs (a) idempotent enqueueing, (b) a GLOBAL cap on how many tasks
of one kind run at once (e.g. at most 1 Common Crawl index query in flight across all workers),
(c) retries with backoff, (d) lost-task recovery and (e) full observability from SQL. All of that is
a few queries on one table with `FOR UPDATE SKIP LOCKED`; Postgres is already here. Workers are
stateless and horizontally scalable; a Redis-based queue can replace this module later without
touching collectors.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

log = logging.getLogger(__name__)

CLAIM_LOCK = 7311002  # advisory lock serialising claims so per-kind caps are exact


@dataclass
class Task:
    id: int
    run_id: int | None
    domain_id: int | None
    kind: str
    attempts: int
    max_attempts: int
    payload: dict[str, Any]


async def enqueue(
    conn: AsyncConnection,
    *,
    kind: str,
    run_id: int | None = None,
    domain_id: int | None = None,
    payload: dict[str, Any] | None = None,
    dedupe_key: str | None = None,
    priority: int = 0,
    run_after: datetime | None = None,
    max_attempts: int = 3,
) -> int | None:
    """Insert a task. Returns its id, or None when `dedupe_key` already exists (idempotent)."""
    row = (
        await conn.execute(
            text(
                """
                INSERT INTO tasks (run_id, domain_id, kind, payload, dedupe_key, priority, run_after, max_attempts)
                VALUES (:run_id, :domain_id, :kind, CAST(:payload AS jsonb), :dedupe_key, :priority,
                        COALESCE(:run_after, now()), :max_attempts)
                ON CONFLICT (dedupe_key) DO NOTHING
                RETURNING id
                """
            ),
            {
                "run_id": run_id,
                "domain_id": domain_id,
                "kind": kind,
                "payload": json.dumps(payload or {}),
                "dedupe_key": dedupe_key,
                "priority": priority,
                "run_after": run_after,
                "max_attempts": max_attempts,
            },
        )
    ).first()
    return int(row[0]) if row else None


async def claim(
    conn: AsyncConnection,
    *,
    worker_id: str,
    lease_s: int,
    kind_caps: dict[str, int] | None = None,
    kinds: list[str] | None = None,
) -> Task | None:
    """Atomically claim the next runnable task, honouring per-kind global concurrency caps."""
    await conn.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": CLAIM_LOCK})
    row = (
        await conn.execute(
            text(
                """
                WITH running AS (
                  SELECT kind, count(*) AS n FROM tasks WHERE status = 'running' GROUP BY kind
                ),
                cand AS (
                  SELECT t.id
                  FROM tasks t
                  LEFT JOIN running r ON r.kind = t.kind
                  WHERE t.status = 'queued'
                    AND t.run_after <= now()
                    AND (CAST(:kinds AS text[]) IS NULL OR t.kind = ANY(CAST(:kinds AS text[])))
                    AND COALESCE(r.n, 0) < COALESCE((CAST(:caps AS jsonb) ->> t.kind)::int, 1000000)
                  ORDER BY t.priority DESC, t.id
                  LIMIT 1
                  FOR UPDATE OF t SKIP LOCKED
                )
                UPDATE tasks t
                SET status = 'running', locked_by = :w, locked_at = now(),
                    lease_until = now() + make_interval(secs => :lease), attempts = attempts + 1
                FROM cand
                WHERE t.id = cand.id
                RETURNING t.id, t.run_id, t.domain_id, t.kind, t.attempts, t.max_attempts, t.payload
                """
            ),
            {"w": worker_id, "lease": lease_s, "caps": json.dumps(kind_caps or {}), "kinds": kinds},
        )
    ).first()
    if not row:
        return None
    return Task(
        id=row[0],
        run_id=row[1],
        domain_id=row[2],
        kind=row[3],
        attempts=row[4],
        max_attempts=row[5],
        payload=row[6] or {},
    )


async def extend_lease(conn: AsyncConnection, task_id: int, lease_s: int) -> None:
    await conn.execute(
        text("UPDATE tasks SET lease_until = now() + make_interval(secs => :l) WHERE id = :id AND status = 'running'"),
        {"l": lease_s, "id": task_id},
    )


async def complete(conn: AsyncConnection, task_id: int, status: str = "succeeded", error: str | None = None) -> None:
    await conn.execute(
        text("UPDATE tasks SET status = :s, error = :e, finished_at = now(), locked_by = NULL, lease_until = NULL WHERE id = :id"),
        {"s": status, "e": error, "id": task_id},
    )


async def fail(conn: AsyncConnection, task: Task, error: str, *, retry: bool, base_delay_s: float) -> str:
    """Record a failure. Returns the new status: 'queued' (will retry) or 'failed' (final)."""
    if retry and task.attempts < task.max_attempts:
        delay = base_delay_s * (2 ** (task.attempts - 1))
        await conn.execute(
            text(
                "UPDATE tasks SET status = 'queued', error = :e, locked_by = NULL, lease_until = NULL,"
                " run_after = now() + make_interval(secs => :d) WHERE id = :id"
            ),
            {"e": error[:4000], "d": delay, "id": task.id},
        )
        return "queued"
    await complete(conn, task.id, status="failed", error=error[:4000])
    return "failed"


async def recover_lost(conn: AsyncConnection) -> int:
    """Re-queue (or fail) tasks whose lease expired: the worker died or hung."""
    res = await conn.execute(
        text(
            """
            UPDATE tasks
            SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
                error = 'lease expired', locked_by = NULL, lease_until = NULL,
                finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END
            WHERE status = 'running' AND lease_until < now()
            """
        )
    )
    return res.rowcount or 0


async def stats(conn: AsyncConnection) -> dict[str, dict[str, int]]:
    rows = await conn.execute(text("SELECT kind, status, count(*) FROM tasks GROUP BY kind, status"))
    out: dict[str, dict[str, int]] = {}
    for kind, status, n in rows:
        out.setdefault(kind, {})[status] = int(n)
    return out


def backoff_until(base_delay_s: float, attempt: int) -> timedelta:
    return timedelta(seconds=base_delay_s * (2 ** max(0, attempt - 1)))
