"""Estimator contract and result model."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Protocol

from pydantic import BaseModel, Field

from ..features.schema import FeatureVector


class Estimate(BaseModel):
    domain: str
    estimated_monthly_visits: int | None
    lower_bound: int | None
    upper_bound: int | None
    traffic_bucket: str
    confidence: str  # low | medium | high
    confidence_score: float
    model_version: str
    feature_version: str
    generated_at: datetime
    # Not measured traffic: explain where the number comes from.
    details: dict[str, Any] = Field(default_factory=dict)


class Estimator(Protocol):
    model_version: str

    def estimate(self, fv: FeatureVector, normalized: dict[str, float | None]) -> Estimate: ...
