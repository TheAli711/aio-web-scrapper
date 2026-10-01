"""API request/response models."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class DomainIn(BaseModel):
    domain: str = Field(..., min_length=3, max_length=300, examples=["example.com"])
    force: bool = Field(False, description="Re-collect even if a recent run exists")
    collectors: list[str] | None = Field(None, description="Subset of enabled collectors to run")


class BulkIn(BaseModel):
    domains: list[str] = Field(..., min_length=1)
    force: bool = False
    collectors: list[str] | None = None


class IngestOut(BaseModel):
    input: str
    domain: str | None
    domain_id: int | None
    job_id: int | None
    status: str  # queued | existing | recent | invalid | duplicate
    error: str | None = None


class BulkOut(BaseModel):
    accepted: int
    queued: int
    results: list[IngestOut]


class JobOut(BaseModel):
    job_id: int
    domain: str
    status: str
    collectors: list[str]
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    error: str | None
    tasks: list[dict[str, Any]]
    estimate: EstimateOut | None = None


class EstimateOut(BaseModel):
    domain: str
    estimated_monthly_visits: int | None
    lower_bound: int | None
    upper_bound: int | None
    traffic_bucket: str
    confidence: str
    confidence_score: float
    model_version: str
    feature_version: str
    generated_at: datetime
    job_id: int | None = None
    disclaimer: str = "Estimated from public signals (rankings, link graphs, crawl, DNS); not measured traffic."
    details: dict[str, Any] | None = None


class DomainOut(BaseModel):
    domain: str
    domain_id: int
    created_at: datetime
    last_completed_at: datetime | None
    latest_job: JobOut | None
    latest_estimate: EstimateOut | None
    collection_log: list[dict[str, Any]]


class FeaturesOut(BaseModel):
    domain: str
    feature_version: str
    computed_at: datetime
    job_id: int | None
    features: dict[str, Any]
    normalized: dict[str, float | None]
    sources: dict[str, Any]


class JobsIn(BaseModel):
    domains: list[str] = Field(..., min_length=1)
    force: bool = False
    collectors: list[str] | None = None


class StatsOut(BaseModel):
    domains: int
    runs: dict[str, int]
    tasks: dict[str, dict[str, int]]
    lists: list[dict[str, Any]]
    collectors_enabled: list[str]
    model_version: str
    feature_version: str
