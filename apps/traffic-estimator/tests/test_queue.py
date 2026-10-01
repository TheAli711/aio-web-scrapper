from conftest import needs_db
from sqlalchemy import text

from traffic_estimator import queue
from traffic_estimator.db import connection

pytestmark = needs_db


async def test_enqueue_is_idempotent(clean_db):
    async with connection() as conn:
        a = await queue.enqueue(conn, kind="crawl", dedupe_key="k1")
        b = await queue.enqueue(conn, kind="crawl", dedupe_key="k1")
        c = await queue.enqueue(conn, kind="crawl", dedupe_key="k2")
    assert a is not None and b is None and c is not None and c != a


async def test_claim_respects_priority_order_and_kind_caps(clean_db):
    async with connection() as conn:
        await queue.enqueue(conn, kind="commoncrawl", dedupe_key="cc1")
        await queue.enqueue(conn, kind="commoncrawl", dedupe_key="cc2")
        await queue.enqueue(conn, kind="dns", dedupe_key="d1", priority=5)
    async with connection() as conn:
        t1 = await queue.claim(conn, worker_id="w1", lease_s=60, kind_caps={"commoncrawl": 1})
    assert t1 and t1.kind == "dns"  # highest priority first
    async with connection() as conn:
        t2 = await queue.claim(conn, worker_id="w1", lease_s=60, kind_caps={"commoncrawl": 1})
    assert t2 and t2.kind == "commoncrawl" and t2.attempts == 1
    async with connection() as conn:
        t3 = await queue.claim(conn, worker_id="w2", lease_s=60, kind_caps={"commoncrawl": 1})
    assert t3 is None  # cap of 1 running commoncrawl task reached
    async with connection() as conn:
        await queue.complete(conn, t2.id)
        t4 = await queue.claim(conn, worker_id="w2", lease_s=60, kind_caps={"commoncrawl": 1})
    assert t4 and t4.kind == "commoncrawl" and t4.id != t2.id


async def test_claim_filters_kinds(clean_db):
    async with connection() as conn:
        await queue.enqueue(conn, kind="crawl", dedupe_key="c1")
        assert await queue.claim(conn, worker_id="w", lease_s=60, kinds=["dns"]) is None
        t = await queue.claim(conn, worker_id="w", lease_s=60, kinds=["crawl", "dns"])
        assert t and t.kind == "crawl"


async def test_fail_retries_with_backoff_then_fails(clean_db):
    async with connection() as conn:
        await queue.enqueue(conn, kind="crawl", dedupe_key="c1", max_attempts=2)
        t = await queue.claim(conn, worker_id="w", lease_s=60)
        status = await queue.fail(conn, t, "boom", retry=True, base_delay_s=30)
        assert status == "queued"
        row = (await conn.execute(text("SELECT status, attempts, run_after > now() FROM tasks WHERE id = :id"), {"id": t.id})).first()
        assert row[0] == "queued" and row[1] == 1 and row[2] is True
        # Not claimable until run_after.
        assert await queue.claim(conn, worker_id="w", lease_s=60) is None
        await conn.execute(text("UPDATE tasks SET run_after = now() WHERE id = :id"), {"id": t.id})
        t2 = await queue.claim(conn, worker_id="w", lease_s=60)
        assert t2 and t2.attempts == 2
        status = await queue.fail(conn, t2, "boom again", retry=True, base_delay_s=30)
        assert status == "failed"
        status_row = (await conn.execute(text("SELECT status, error FROM tasks WHERE id = :id"), {"id": t.id})).first()
        assert status_row[0] == "failed" and status_row[1] == "boom again"


async def test_non_retryable_failure(clean_db):
    async with connection() as conn:
        await queue.enqueue(conn, kind="crawl", dedupe_key="c1", max_attempts=3)
        t = await queue.claim(conn, worker_id="w", lease_s=60)
        assert await queue.fail(conn, t, "permanent", retry=False, base_delay_s=1) == "failed"


async def test_recover_lost_tasks(clean_db):
    async with connection() as conn:
        await queue.enqueue(conn, kind="crawl", dedupe_key="c1", max_attempts=3)
        await queue.enqueue(conn, kind="crawl", dedupe_key="c2", max_attempts=1)
        t1 = await queue.claim(conn, worker_id="w", lease_s=60)
        t2 = await queue.claim(conn, worker_id="w", lease_s=60)
        assert await queue.recover_lost(conn) == 0
        await conn.execute(
            text("UPDATE tasks SET lease_until = now() - interval '1 minute' WHERE id IN (:a, :b)"), {"a": t1.id, "b": t2.id}
        )
        assert await queue.recover_lost(conn) == 2
        rows = {r[0]: r[1] for r in await conn.execute(text("SELECT id, status FROM tasks"))}
        assert rows[t1.id] == "queued" and rows[t2.id] == "failed"
        await queue.extend_lease(conn, t1.id, 60)  # no-op on a queued task, must not raise


async def test_stats(clean_db):
    async with connection() as conn:
        await queue.enqueue(conn, kind="crawl", dedupe_key="c1")
        await queue.enqueue(conn, kind="dns", dedupe_key="d1")
        t = await queue.claim(conn, worker_id="w", lease_s=60, kinds=["dns"])
        await queue.complete(conn, t.id)
        s = await queue.stats(conn)
    assert s == {"crawl": {"queued": 1}, "dns": {"succeeded": 1}}
