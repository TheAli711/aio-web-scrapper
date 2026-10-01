"""Pipeline orchestration: ingest domains -> runs -> collector tasks -> finalize (features + estimate).

Idempotency: a run's tasks are deduplicated on (run, kind); observations are append-only; features
and estimates are recomputed from the latest observation per source, so re-running a collector or
finalize is always safe.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from . import queue
from .collectors import Collector, CollectorContext, CollectorResult, enabled_collectors
from .db import connection
from .domains import InvalidDomain, normalize_domain
from .estimator.heuristic import get_estimator
from .features.extract import RawObs, extract_features
from .features.normalize import NORMALIZED_VERSION, normalize
from .features.schema import FEATURE_VERSION, FeatureVector
from .settings import get_settings

log = logging.getLogger(__name__)

FINALIZE_KIND = "finalize"


@dataclass
class IngestResult:
    input: str
    domain: str | None
    domain_id: int | None
    run_id: int | None
    status: str  # queued | existing | recent | invalid
    error: str | None = None


# ------------------------------------------------------------------------------------ ingestion
async def ingest_domains(inputs: list[str], *, force: bool = False, collectors: list[str] | None = None) -> list[IngestResult]:
    s = get_settings()
    names = list(enabled_collectors()) if collectors is None else [c for c in collectors if c in enabled_collectors()]
    results: list[IngestResult] = []
    seen: set[str] = set()
    async with connection() as conn:
        for raw in inputs:
            try:
                nd = normalize_domain(raw)
            except InvalidDomain as e:
                results.append(IngestResult(raw, None, None, None, "invalid", str(e)))
                continue
            if nd.name in seen:
                results.append(IngestResult(raw, nd.name, None, None, "duplicate"))
                continue
            seen.add(nd.name)
            row = (
                await conn.execute(
                    text(
                        "INSERT INTO domains (name) VALUES (:n) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name"
                        " RETURNING id, last_run_id, last_completed_at"
                    ),
                    {"n": nd.name},
                )
            ).first()
            domain_id, last_run_id, last_completed = int(row[0]), row[1], row[2]
            # Active run? Reuse it.
            active = (
                await conn.execute(
                    text("SELECT id FROM pipeline_runs WHERE domain_id = :d AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1"),
                    {"d": domain_id},
                )
            ).first()
            if active:
                results.append(IngestResult(raw, nd.name, domain_id, int(active[0]), "existing"))
                continue
            if (
                not force
                and last_completed
                and s.reprocess_after_hours > 0
                and last_completed > datetime.now(UTC) - timedelta(hours=s.reprocess_after_hours)
            ):
                results.append(IngestResult(raw, nd.name, domain_id, last_run_id, "recent"))
                continue
            run_id = await create_run(conn, domain_id, names, force=force)
            results.append(IngestResult(raw, nd.name, domain_id, run_id, "queued"))
    return results


async def create_run(conn: AsyncConnection, domain_id: int, collectors: list[str], *, force: bool = False) -> int:
    s = get_settings()
    row = (
        await conn.execute(
            text(
                "INSERT INTO pipeline_runs (domain_id, collectors, feature_version, model_version) VALUES (:d, :c, :fv, :mv) RETURNING id"
            ),
            {"d": domain_id, "c": collectors, "fv": FEATURE_VERSION, "mv": s.model_version},
        )
    ).first()
    run_id = int(row[0])
    await conn.execute(text("UPDATE domains SET last_run_id = :r WHERE id = :d"), {"r": run_id, "d": domain_id})
    for kind in collectors:
        await queue.enqueue(
            conn,
            kind=kind,
            run_id=run_id,
            domain_id=domain_id,
            payload={"force": force},
            dedupe_key=f"run:{run_id}:{kind}",
            max_attempts=s.task_max_attempts,
        )
    if not collectors:
        await queue.enqueue(conn, kind=FINALIZE_KIND, run_id=run_id, domain_id=domain_id, dedupe_key=f"run:{run_id}:finalize")
    return run_id


# ------------------------------------------------------------------------------------ collector tasks
async def latest_observation(conn: AsyncConnection, domain_id: int, source: str) -> RawObs | None:
    row = (
        await conn.execute(
            text(
                "SELECT source, payload, collected_at, source_version FROM raw_observations"
                " WHERE domain_id = :d AND source = :s ORDER BY collected_at DESC LIMIT 1"
            ),
            {"d": domain_id, "s": source},
        )
    ).first()
    if not row:
        return None
    return RawObs(row[0], row[1], row[2], row[3])


async def run_collector_task(task: queue.Task, collector: Collector, worker_id: str) -> CollectorResult:
    """Execute one collector for one domain, honouring the cache, and persist observations + log."""
    assert task.domain_id is not None
    async with connection() as conn:
        name = (await conn.execute(text("SELECT name FROM domains WHERE id = :d"), {"d": task.domain_id})).scalar_one()
        await conn.execute(
            text(
                "UPDATE pipeline_runs SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = :r AND status = 'queued'"
            ),
            {"r": task.run_id},
        )
        # Cache: reuse a recent observation for every source this collector produces.
        force = bool(task.payload.get("force"))
        if not force and collector.cache_hours > 0:
            fresh = True
            for src in collector.sources:
                obs = await latest_observation(conn, task.domain_id, src)
                if obs is None or obs.collected_at < datetime.now(UTC) - timedelta(hours=collector.cache_hours):
                    fresh = False
                    break
            if fresh:
                await _log_collection(conn, task, collector.name, "skipped", 0, None, 0, "cached", worker_id)
                return CollectorResult.skipped("cached")

    ctx = CollectorContext(
        domain_id=task.domain_id,
        domain=name,
        run_id=task.run_id,
        task_id=task.id,
        attempt=task.attempts,
        payload=task.payload,
    )
    started = time.monotonic()
    try:
        result = await collector.collect(ctx)
    except Exception as e:  # noqa: BLE001 - a bug in a collector must not kill the worker
        log.exception("collector %s crashed for %s", collector.name, name)
        result = CollectorResult.failed(f"{type(e).__name__}: {e}"[:500])
    duration_ms = int((time.monotonic() - started) * 1000)

    async with connection() as conn:
        if result.status == "success":
            for obs in result.observations:
                await conn.execute(
                    text(
                        "INSERT INTO raw_observations (domain_id, source, source_version, run_id, payload)"
                        " VALUES (:d, :s, :v, :r, CAST(:p AS jsonb))"
                    ),
                    {
                        "d": task.domain_id,
                        "s": obs.source,
                        "v": obs.source_version,
                        "r": task.run_id,
                        "p": json.dumps(obs.payload, default=str),
                    },
                )
        if result.status != "defer":
            status = {"success": "success", "failed": "failed", "skipped": "skipped"}[result.status]
            await _log_collection(
                conn, task, collector.name, status, duration_ms, result.http_status, result.records, result.error, worker_id
            )
    return result


async def _log_collection(
    conn: AsyncConnection,
    task: queue.Task,
    source: str,
    status: str,
    duration_ms: int,
    http_status: int | None,
    records: int,
    error: str | None,
    worker_id: str,
) -> None:
    await conn.execute(
        text(
            "INSERT INTO collection_runs (task_id, domain_id, source, status, started_at, finished_at, duration_ms,"
            " http_status, records_collected, error, worker)"
            " VALUES (:t, :d, :s, :st, now() - make_interval(secs => :dur / 1000.0), now(), :dur, :h, :n, :e, :w)"
        ),
        {
            "t": task.id,
            "d": task.domain_id,
            "s": source,
            "st": status,
            "dur": duration_ms,
            "h": http_status,
            "n": records,
            "e": (error or "")[:1000] or None,
            "w": worker_id,
        },
    )


async def maybe_finalize(conn: AsyncConnection, run_id: int) -> bool:
    """When every collector task of the run is terminal, enqueue finalize (idempotent)."""
    row = (
        await conn.execute(
            text(
                "SELECT count(*) FILTER (WHERE status IN ('queued', 'running')) AS open_tasks FROM tasks WHERE run_id = :r AND kind <> :f"
            ),
            {"r": run_id, "f": FINALIZE_KIND},
        )
    ).first()
    if row and int(row[0]) == 0:
        domain_id = (await conn.execute(text("SELECT domain_id FROM pipeline_runs WHERE id = :r"), {"r": run_id})).scalar_one()
        tid = await queue.enqueue(
            conn, kind=FINALIZE_KIND, run_id=run_id, domain_id=domain_id, dedupe_key=f"run:{run_id}:finalize", priority=20
        )
        return tid is not None
    return False


# ------------------------------------------------------------------------------------ finalize
async def build_features(conn: AsyncConnection, domain_id: int, domain: str, run_id: int | None = None) -> FeatureVector:
    """Features from the latest observation of each source. Sources whose task failed in `run_id`
    (default: the domain's latest run that collected anything) are marked failed, not missing."""
    rows = await conn.execute(
        text(
            """
            SELECT DISTINCT ON (source) source, payload, collected_at, source_version
            FROM raw_observations WHERE domain_id = :d ORDER BY source, collected_at DESC
            """
        ),
        {"d": domain_id},
    )
    observations = {r[0]: RawObs(r[0], r[1], r[2], r[3]) for r in rows}
    if run_id is None:
        run_id = (
            await conn.execute(
                text("SELECT max(id) FROM pipeline_runs WHERE domain_id = :d AND cardinality(collectors) > 0"), {"d": domain_id}
            )
        ).scalar()
    failed_sources: dict[str, str] = {}
    if run_id is not None:
        failed = await conn.execute(
            text("SELECT kind, error FROM tasks WHERE run_id = :r AND status = 'failed' AND kind <> :f"),
            {"r": run_id, "f": FINALIZE_KIND},
        )
        failed_sources = {r[0]: (r[1] or "failed") for r in failed}
    return extract_features(domain, observations, failed_sources)


async def finalize_run(run_id: int) -> dict[str, Any]:
    """Extract features from the latest observations, estimate, and close the run."""
    async with connection() as conn:
        run = (
            await conn.execute(
                text("SELECT r.domain_id, d.name, r.collectors FROM pipeline_runs r JOIN domains d ON d.id = r.domain_id WHERE r.id = :r"),
                {"r": run_id},
            )
        ).first()
        if not run:
            raise RuntimeError(f"run {run_id} not found")
        domain_id, domain, collectors = int(run[0]), run[1], list(run[2] or [])
        fv = await build_features(conn, domain_id, domain, run_id if collectors else None)
    norm = normalize(fv)
    estimator = get_estimator()
    est = estimator.estimate(fv, norm)
    async with connection() as conn:
        fid = (
            await conn.execute(
                text(
                    "INSERT INTO domain_features (domain_id, run_id, feature_version, features, normalized, sources)"
                    " VALUES (:d, :r, :v, CAST(:f AS jsonb), CAST(:n AS jsonb), CAST(:s AS jsonb)) RETURNING id"
                ),
                {
                    "d": domain_id,
                    "r": run_id,
                    "v": f"{FEATURE_VERSION}/norm-{NORMALIZED_VERSION}",
                    "f": fv.model_dump_json(exclude={"sources"}),
                    "n": json.dumps(norm),
                    "s": json.dumps({k: v.model_dump(mode="json") for k, v in fv.sources.items()}),
                },
            )
        ).scalar_one()
        await conn.execute(
            text(
                "INSERT INTO estimates (domain_id, run_id, feature_id, model_version, feature_version,"
                " estimated_monthly_visits, lower_bound, upper_bound, traffic_bucket, confidence, confidence_score, details)"
                " VALUES (:d, :r, :fid, :mv, :fv, :v, :lo, :hi, :b, :c, :cs, CAST(:det AS jsonb))"
            ),
            {
                "d": domain_id,
                "r": run_id,
                "fid": fid,
                "mv": est.model_version,
                "fv": est.feature_version,
                "v": est.estimated_monthly_visits,
                "lo": est.lower_bound,
                "hi": est.upper_bound,
                "b": est.traffic_bucket,
                "c": est.confidence,
                "cs": est.confidence_score,
                "det": json.dumps(est.details, default=str),
            },
        )
        await conn.execute(
            text(
                "UPDATE pipeline_runs SET status = 'completed', finished_at = now(), feature_version = :fv, model_version = :mv"
                " WHERE id = :r"
            ),
            {"r": run_id, "fv": est.feature_version, "mv": est.model_version},
        )
        await conn.execute(text("UPDATE domains SET last_completed_at = now() WHERE id = :d"), {"d": domain_id})
    log.info(
        "estimate %s: %s visits/mo (%s..%s) bucket=%s confidence=%s/%s sources=%s",
        domain,
        est.estimated_monthly_visits,
        est.lower_bound,
        est.upper_bound,
        est.traffic_bucket,
        est.confidence,
        est.confidence_score,
        [k for k, v in fv.sources.items() if v.status == "present"],
    )
    return {"run_id": run_id, "domain": domain, "estimate": est.model_dump(mode="json"), "collectors": collectors}


async def reestimate(domain_id: int) -> dict[str, Any] | None:
    """Recompute features + estimate from stored observations without collecting (new run row)."""
    async with connection() as conn:
        run_id = await create_run(conn, domain_id, [])
    return await finalize_run(run_id)
