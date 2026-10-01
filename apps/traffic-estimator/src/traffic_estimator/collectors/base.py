"""Collector contract.

A collector turns (domain) into zero or more raw observations for one or more sources. It never
raises for expected failures (site down, blocked, source unavailable): it returns a failed/skipped
result so the pipeline can continue with the other sources and lower the confidence.

Adding a source = one module implementing `Collector`, registered in `collectors/__init__.py`, plus
the feature mappings in features/extract.py. Nothing else changes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

Status = Literal["success", "failed", "skipped", "defer"]


@dataclass
class Observation:
    source: str  # raw_observations.source (e.g. "tranco", "crawl", "dns")
    payload: dict[str, Any]
    source_version: str | None = None
    records: int = 0
    http_status: int | None = None


@dataclass
class CollectorResult:
    status: Status
    observations: list[Observation] = field(default_factory=list)
    error: str | None = None
    http_status: int | None = None
    records: int = 0
    defer_seconds: int = 0  # for status == "defer": re-queue the task after this many seconds
    retryable: bool = True  # for status == "failed": whether the task should be retried

    @classmethod
    def ok(cls, observations: list[Observation], **kw: Any) -> CollectorResult:
        return cls(status="success", observations=observations, records=sum(o.records for o in observations), **kw)

    @classmethod
    def failed(cls, error: str, *, retryable: bool = True, http_status: int | None = None) -> CollectorResult:
        return cls(status="failed", error=error, retryable=retryable, http_status=http_status)

    @classmethod
    def skipped(cls, reason: str) -> CollectorResult:
        return cls(status="skipped", error=reason)

    @classmethod
    def defer(cls, seconds: int, reason: str) -> CollectorResult:
        return cls(status="defer", defer_seconds=seconds, error=reason)


@dataclass
class CollectorContext:
    domain_id: int
    domain: str
    run_id: int | None
    task_id: int | None
    attempt: int
    payload: dict[str, Any]  # task payload (collector-specific options, defer counters)


class Collector(Protocol):
    name: str
    sources: tuple[str, ...]  # raw_observations.source values this collector produces
    cache_hours: int  # reuse an observation younger than this instead of collecting again

    async def collect(self, ctx: CollectorContext) -> CollectorResult: ...
