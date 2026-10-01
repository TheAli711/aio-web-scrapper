import json

import httpx
from conftest import needs_db
from sqlalchemy import text

from traffic_estimator import pipeline, queue
from traffic_estimator.api.app import app
from traffic_estimator.collectors.base import CollectorResult, Observation
from traffic_estimator.db import connection
from traffic_estimator.worker import Worker

pytestmark = needs_db


def client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


class FakeCollector:
    name = "fake"
    sources = ("tranco", "crawl")
    cache_hours = 24

    def __init__(self, result: CollectorResult | None = None) -> None:
        self.calls = 0
        self.result = result

    async def collect(self, ctx):
        self.calls += 1
        if self.result:
            return self.result
        return CollectorResult.ok(
            [
                Observation("tranco", {"status": "present", "rank": 50000, "list_id": "T"}, "T", records=1),
                Observation(
                    "crawl",
                    {
                        "reachable": True,
                        "blocked": False,
                        "homepage": {"status": 200},
                        "signals": {},
                        "sitemaps": {
                            "fetched": 1,
                            "url_count": 300,
                            "url_count_estimated": 300,
                            "kinds": {"article": 200},
                            "lastmod_buckets": {"30d": 10},
                        },
                        "structure": {"page_count_from_sitemap": 300, "article_count": 200},
                        "pages": {"fetched": 5, "ok": 5},
                        "tech": {
                            "technologies": [{"name": "WordPress", "category": "cms"}],
                            "cms": "WordPress",
                            "analytics": ["Google Analytics"],
                        },
                    },
                    "crawl_v1",
                    records=6,
                ),
            ]
        )


async def test_post_domain_validation_and_ingestion(clean_db):
    async with client() as c:
        r = await c.post("/domains", json={"domain": "not a domain"})
        assert r.status_code == 400
        r = await c.post("/domains", json={"domain": "https://WWW.Example.com/path"})
        assert r.status_code == 202
        body = r.json()
        assert body["domain"] == "example.com" and body["status"] == "queued" and body["job_id"]
        job_id = body["job_id"]
        r = await c.post("/domains", json={"domain": "example.com"})
        assert r.json()["status"] == "existing" and r.json()["job_id"] == job_id
        r = await c.get(f"/jobs/{job_id}")
        assert r.status_code == 200
        job = r.json()
        assert job["status"] == "queued" and job["domain"] == "example.com"
        kinds = sorted(t["kind"] for t in job["tasks"])
        assert kinds == sorted(job["collectors"]) and "lists" in kinds and "crawl" in kinds
        r = await c.get("/jobs/999999")
        assert r.status_code == 404
        r = await c.get("/domains/example.com")
        assert r.status_code == 200 and r.json()["latest_estimate"] is None
        r = await c.get("/domains/example.com/estimate")
        assert r.status_code == 404
        r = await c.get("/domains/unknown.org")
        assert r.status_code == 404


async def test_bulk_and_jobs_alias(clean_db):
    async with client() as c:
        r = await c.post("/domains/bulk", json={"domains": ["a.com", "A.com", "b.org", "bad"]})
        assert r.status_code == 202
        body = r.json()
        assert body["accepted"] == 3 and body["queued"] == 2
        statuses = {x["input"]: x["status"] for x in body["results"]}
        assert statuses == {"a.com": "queued", "A.com": "duplicate", "b.org": "queued", "bad": "invalid"}
        r = await c.post("/jobs", json={"domains": ["c.net"]})
        assert r.status_code == 202 and r.json()["queued"] == 1
        r = await c.get("/stats")
        assert r.status_code == 200 and r.json()["domains"] == 3
        r = await c.get("/healthz")
        assert r.status_code == 200


async def test_collector_task_persists_observations_and_log_and_caches(clean_db):
    res = await pipeline.ingest_domains(["example.com"], collectors=["crawl"])
    run_id, domain_id = res[0].run_id, res[0].domain_id
    fake = FakeCollector()
    async with connection() as conn:
        task = await queue.claim(conn, worker_id="t", lease_s=60)
    assert task and task.kind == "crawl"
    result = await pipeline.run_collector_task(task, fake, "t")
    assert result.status == "success" and fake.calls == 1
    async with connection() as conn:
        n_obs = (await conn.execute(text("SELECT count(*) FROM raw_observations WHERE domain_id = :d"), {"d": domain_id})).scalar_one()
        log_rows = [tuple(r) for r in await conn.execute(text("SELECT source, status, records_collected FROM collection_runs"))]
    assert n_obs == 2 and log_rows == [("fake", "success", 7)]
    # Second execution within cache_hours: skipped, no new observations.
    result2 = await pipeline.run_collector_task(task, fake, "t")
    assert result2.status == "skipped" and fake.calls == 1
    async with connection() as conn:
        n_obs2 = (await conn.execute(text("SELECT count(*) FROM raw_observations"))).scalar_one()
        assert n_obs2 == 2
        await queue.complete(conn, task.id)
        assert await pipeline.maybe_finalize(conn, run_id) is True
        assert await pipeline.maybe_finalize(conn, run_id) is False  # idempotent
        fin = (await conn.execute(text("SELECT count(*) FROM tasks WHERE run_id = :r AND kind = 'finalize'"), {"r": run_id})).scalar_one()
        assert fin == 1


async def test_failed_collector_does_not_block_estimate(clean_db):
    res = await pipeline.ingest_domains(["example.com"], collectors=["crawl", "dns"])
    run_id, domain_id = res[0].run_id, res[0].domain_id
    good = FakeCollector()
    bad = FakeCollector(CollectorResult.failed("boom", retryable=False))
    bad.sources = ("dns",)
    async with connection() as conn:
        t1 = await queue.claim(conn, worker_id="t", lease_s=60, kinds=["crawl"])
        t2 = await queue.claim(conn, worker_id="t", lease_s=60, kinds=["dns"])
    assert await pipeline.run_collector_task(t1, good, "t")
    r2 = await pipeline.run_collector_task(t2, bad, "t")
    assert r2.status == "failed"
    async with connection() as conn:
        await queue.complete(conn, t1.id)
        await queue.fail(conn, t2, "boom", retry=False, base_delay_s=1)
        assert await pipeline.maybe_finalize(conn, run_id)
    out = await pipeline.finalize_run(run_id)
    est = out["estimate"]
    assert est["model_version"] == "heuristic_v2" and est["traffic_bucket"]
    assert est["details"]["sources"]["dns"] == "failed"
    assert est["details"]["sources"]["tranco"] == "present"
    async with client() as c:
        r = await c.get("/domains/example.com/estimate?details=true")
        assert r.status_code == 200
        body = r.json()
        assert body["estimated_monthly_visits"] > 0 and body["lower_bound"] <= body["estimated_monthly_visits"] <= body["upper_bound"]
        assert body["confidence"] in ("low", "medium", "high") and 0 <= body["confidence_score"] <= 1
        assert body["details"]["signal_estimates_log10"]["tranco"]
        r = await c.get("/domains/example.com/features")
        f = r.json()
        assert f["features"]["tranco_rank"] == 50000 and f["normalized"]["log_tranco_rank"] == 4.699
        assert f["sources"]["dns"]["status"] == "failed"
        r = await c.get(f"/jobs/{run_id}")
        assert r.json()["status"] == "completed" and r.json()["estimate"]["traffic_bucket"] == body["traffic_bucket"]
        r = await c.get("/domains/example.com")
        assert r.json()["latest_estimate"]["job_id"] == run_id
        assert any(x["source"] == "fake" and x["status"] == "failed" for x in r.json()["collection_log"])
    # Re-estimation without collection creates a new run and a new estimate from stored data.
    async with client() as c:
        r = await c.post("/domains/example.com/reestimate")
        assert r.status_code == 200 and r.json()["job_id"] != run_id
    async with connection() as conn:
        assert domain_id == (await conn.execute(text("SELECT domain_id FROM estimates ORDER BY id DESC LIMIT 1"))).scalar_one()


async def test_worker_executes_finalize_and_defer(clean_db, monkeypatch):
    res = await pipeline.ingest_domains(["example.com"], collectors=["lists"])
    run_id = res[0].run_id
    w = Worker()
    deferring = FakeCollector(CollectorResult.defer(5, "waiting for lists"))
    w.collectors = {"lists": deferring}
    async with connection() as conn:
        task = await queue.claim(conn, worker_id=w.worker_id, lease_s=60)
    await w._execute(task)
    async with connection() as conn:
        row = (
            await conn.execute(text("SELECT status, attempts, payload, run_after > now() FROM tasks WHERE id = :id"), {"id": task.id})
        ).first()
    assert row[0] == "queued" and row[1] == 0 and row[2]["defers"] == 1 and row[3] is True
    # Now let it succeed and watch the run complete end-to-end through the worker.
    w.collectors = {"lists": FakeCollector()}
    async with connection() as conn:
        await conn.execute(text("UPDATE tasks SET run_after = now() WHERE id = :id"), {"id": task.id})
        task = await queue.claim(conn, worker_id=w.worker_id, lease_s=60)
    await w._execute(task)
    async with connection() as conn:
        fin = await queue.claim(conn, worker_id=w.worker_id, lease_s=60)
    assert fin and fin.kind == "finalize"
    await w._execute(fin)
    async with connection() as conn:
        status = (await conn.execute(text("SELECT status FROM pipeline_runs WHERE id = :r"), {"r": run_id})).scalar_one()
        est = (await conn.execute(text("SELECT traffic_bucket, details FROM estimates WHERE run_id = :r"), {"r": run_id})).first()
    assert status == "completed" and est and est[0]
    assert json.loads(json.dumps(est[1]))["sources"]["tranco"] == "present"
