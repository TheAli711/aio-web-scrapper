"""FastAPI application: domain ingestion, job status, features and estimates.

Internal service (no auth of its own): publish it only on loopback / an internal network, like
the scraping engine, and put the authenticated product API in front of it.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .. import __version__, pipeline
from ..collectors import enabled_collectors
from ..db import connection, dispose_engine, migrate, ping
from ..domains import InvalidDomain, normalize_domain
from ..features.schema import FEATURE_VERSION
from ..settings import get_settings
from .schemas import (
    BulkIn,
    BulkOut,
    DomainIn,
    DomainOut,
    EstimateOut,
    FeaturesOut,
    IngestOut,
    JobOut,
    JobsIn,
    StatsOut,
)

log = logging.getLogger(__name__)

DESCRIPTION = """
Website traffic **estimates** inferred from free public signals (Tranco, Majestic Million,
Open PageRank, CrUX top list, Common Crawl web graph & index, our own crawl, DNS/RDAP).

Numbers are not measured traffic. Every estimate carries a range, a traffic bucket, a confidence
score and the model version (`heuristic_v1` until a model is trained on legitimate ground truth).
"""


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    if get_settings().migrate_on_start:
        await migrate()
    yield
    await dispose_engine()


app = FastAPI(title="traffic-estimator", version=__version__, description=DESCRIPTION, lifespan=lifespan)


# ------------------------------------------------------------------------------------ helpers
def _ingest_out(r: pipeline.IngestResult) -> IngestOut:
    return IngestOut(input=r.input, domain=r.domain, domain_id=r.domain_id, job_id=r.run_id, status=r.status, error=r.error)


async def _domain_row(name: str) -> tuple[int, str, Any, Any]:
    try:
        nd = normalize_domain(name)
    except InvalidDomain as e:
        raise HTTPException(status_code=400, detail=f"invalid domain: {e}") from e
    async with connection() as conn:
        row = (
            await conn.execute(text("SELECT id, name, created_at, last_completed_at FROM domains WHERE name = :n"), {"n": nd.name})
        ).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"domain {nd.name} is not known; POST /domains first")
    return int(row[0]), row[1], row[2], row[3]


async def _estimate_for(domain_id: int, *, include_details: bool, job_id: int | None = None) -> EstimateOut | None:
    async with connection() as conn:
        sql = (
            "SELECT e.estimated_monthly_visits, e.lower_bound, e.upper_bound, e.traffic_bucket, e.confidence,"
            " e.confidence_score, e.model_version, e.feature_version, e.generated_at, e.details, e.run_id, d.name"
            " FROM estimates e JOIN domains d ON d.id = e.domain_id WHERE e.domain_id = :d"
        )
        params: dict[str, Any] = {"d": domain_id}
        if job_id is not None:
            sql += " AND e.run_id = :r"
            params["r"] = job_id
        row = (await conn.execute(text(sql + " ORDER BY e.generated_at DESC LIMIT 1"), params)).first()
    if not row:
        return None
    return EstimateOut(
        domain=row[11],
        estimated_monthly_visits=row[0],
        lower_bound=row[1],
        upper_bound=row[2],
        traffic_bucket=row[3],
        confidence=row[4],
        confidence_score=float(row[5]),
        model_version=row[6],
        feature_version=row[7],
        generated_at=row[8],
        job_id=row[10],
        details=row[9] if include_details else None,
    )


async def _job(job_id: int, *, include_estimate: bool = True) -> JobOut:
    async with connection() as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT r.id, d.name, r.status, r.collectors, r.created_at, r.started_at, r.finished_at, r.error, r.domain_id"
                    " FROM pipeline_runs r JOIN domains d ON d.id = r.domain_id WHERE r.id = :r"
                ),
                {"r": job_id},
            )
        ).first()
        if not row:
            raise HTTPException(status_code=404, detail="job not found")
        tasks = await conn.execute(
            text("SELECT kind, status, attempts, max_attempts, run_after, finished_at, error FROM tasks WHERE run_id = :r ORDER BY id"),
            {"r": job_id},
        )
        task_list = [
            {
                "kind": t[0],
                "status": t[1],
                "attempts": t[2],
                "max_attempts": t[3],
                "run_after": t[4],
                "finished_at": t[5],
                "error": t[6],
            }
            for t in tasks
        ]
    est = await _estimate_for(int(row[8]), include_details=False, job_id=job_id) if include_estimate and row[2] == "completed" else None
    return JobOut(
        job_id=int(row[0]),
        domain=row[1],
        status=row[2],
        collectors=list(row[3] or []),
        created_at=row[4],
        started_at=row[5],
        finished_at=row[6],
        error=row[7],
        tasks=task_list,
        estimate=est,
    )


# ------------------------------------------------------------------------------------ routes
@app.get("/healthz", tags=["ops"])
async def healthz() -> JSONResponse:
    ok = await ping()
    return JSONResponse({"ok": ok, "version": __version__}, status_code=200 if ok else 503)


@app.get("/stats", response_model=StatsOut, tags=["ops"])
async def stats() -> StatsOut:
    from ..queue import stats as queue_stats

    s = get_settings()
    async with connection() as conn:
        domains = (await conn.execute(text("SELECT count(*) FROM domains"))).scalar_one()
        runs = {r[0]: int(r[1]) for r in await conn.execute(text("SELECT status, count(*) FROM pipeline_runs GROUP BY status"))}
        lists = [
            {"provider": r[0], "list_id": r[1], "list_date": r[2], "rows": r[3], "downloaded_at": r[4]}
            for r in await conn.execute(
                text("SELECT provider, list_id, list_date, row_count, downloaded_at FROM ranked_lists WHERE active ORDER BY provider")
            )
        ]
        tasks = await queue_stats(conn)
    return StatsOut(
        domains=int(domains),
        runs=runs,
        tasks=tasks,
        lists=lists,
        collectors_enabled=list(enabled_collectors()),
        model_version=s.model_version,
        feature_version=FEATURE_VERSION,
    )


@app.post("/domains", response_model=IngestOut, status_code=202, tags=["domains"])
async def post_domain(body: DomainIn) -> IngestOut:
    results = await pipeline.ingest_domains([body.domain], force=body.force, collectors=body.collectors)
    out = _ingest_out(results[0])
    if out.status == "invalid":
        raise HTTPException(status_code=400, detail=out.error)
    return out


@app.post("/domains/bulk", response_model=BulkOut, status_code=202, tags=["domains"])
async def post_domains_bulk(body: BulkIn) -> BulkOut:
    s = get_settings()
    if len(body.domains) > s.bulk_max_domains:
        raise HTTPException(status_code=413, detail=f"at most {s.bulk_max_domains} domains per request")
    results = await pipeline.ingest_domains(body.domains, force=body.force, collectors=body.collectors)
    outs = [_ingest_out(r) for r in results]
    return BulkOut(
        accepted=sum(1 for o in outs if o.status != "invalid"), queued=sum(1 for o in outs if o.status == "queued"), results=outs
    )


@app.post("/jobs", response_model=BulkOut, status_code=202, tags=["jobs"])
async def post_jobs(body: JobsIn) -> BulkOut:
    """Alias of /domains/bulk: submit domains, get job ids."""
    return await post_domains_bulk(BulkIn(domains=body.domains, force=body.force, collectors=body.collectors))


@app.get("/jobs/{job_id}", response_model=JobOut, tags=["jobs"])
async def get_job(job_id: int) -> JobOut:
    return await _job(job_id)


@app.get("/domains/{domain}", response_model=DomainOut, tags=["domains"])
async def get_domain(domain: str) -> DomainOut:
    domain_id, name, created_at, last_completed = await _domain_row(domain)
    async with connection() as conn:
        last_run = (
            await conn.execute(text("SELECT id FROM pipeline_runs WHERE domain_id = :d ORDER BY id DESC LIMIT 1"), {"d": domain_id})
        ).scalar()
        log_rows = await conn.execute(
            text(
                "SELECT source, status, started_at, finished_at, duration_ms, http_status, records_collected, error"
                " FROM collection_runs WHERE domain_id = :d ORDER BY started_at DESC LIMIT 30"
            ),
            {"d": domain_id},
        )
        collection_log = [
            {
                "source": r[0],
                "status": r[1],
                "started_at": r[2],
                "finished_at": r[3],
                "duration_ms": r[4],
                "http_status": r[5],
                "records_collected": r[6],
                "error": r[7],
            }
            for r in log_rows
        ]
    return DomainOut(
        domain=name,
        domain_id=domain_id,
        created_at=created_at,
        last_completed_at=last_completed,
        latest_job=await _job(int(last_run)) if last_run else None,
        latest_estimate=await _estimate_for(domain_id, include_details=False),
        collection_log=collection_log,
    )


@app.get("/domains/{domain}/features", response_model=FeaturesOut, tags=["domains"])
async def get_features(domain: str) -> FeaturesOut:
    domain_id, name, _, _ = await _domain_row(domain)
    async with connection() as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT feature_version, computed_at, run_id, features, normalized, sources FROM domain_features"
                    " WHERE domain_id = :d ORDER BY computed_at DESC LIMIT 1"
                ),
                {"d": domain_id},
            )
        ).first()
    if not row:
        raise HTTPException(status_code=404, detail="no features yet; the job may still be running")
    return FeaturesOut(
        domain=name, feature_version=row[0], computed_at=row[1], job_id=row[2], features=row[3], normalized=row[4], sources=row[5]
    )


@app.get("/domains/{domain}/estimate", response_model=EstimateOut, tags=["domains"])
async def get_estimate(domain: str, details: bool = Query(False, description="Include the per-signal breakdown")) -> EstimateOut:
    domain_id, _, _, _ = await _domain_row(domain)
    est = await _estimate_for(domain_id, include_details=details)
    if not est:
        raise HTTPException(status_code=404, detail="no estimate yet; the job may still be running")
    return est


@app.post("/domains/{domain}/reestimate", response_model=EstimateOut, tags=["domains"])
async def post_reestimate(domain: str) -> EstimateOut:
    """Recompute features + estimate from stored observations (no new collection)."""
    domain_id, _, _, _ = await _domain_row(domain)
    out = await pipeline.reestimate(domain_id)
    if not out:
        raise HTTPException(status_code=500, detail="re-estimation failed")
    est = out["estimate"]
    return EstimateOut(**{k: v for k, v in est.items() if k != "details"}, job_id=out["run_id"], details=est.get("details"))
