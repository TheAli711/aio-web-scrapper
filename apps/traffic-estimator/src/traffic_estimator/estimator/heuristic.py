"""heuristic_v1: baseline estimator with hand-set priors (config/heuristic_v1.yaml).

Clearly labelled and deliberately simple. It exists so the pipeline produces something coherent
before a model can be trained on legitimate ground truth; its coefficients are not validated.
"""

from __future__ import annotations

import logging
import math
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from ..features.schema import FeatureVector
from ..settings import get_settings
from .base import Estimate, Estimator
from .buckets import bucket_for, load_buckets
from .confidence import compute_confidence

log = logging.getLogger(__name__)


def interpolate(points: list[list[float]], x: float) -> float:
    """Piecewise-linear over sorted [x, y] points, clamped outside the range."""
    pts = sorted((float(a), float(b)) for a, b in points)
    if x <= pts[0][0]:
        return pts[0][1]
    if x >= pts[-1][0]:
        return pts[-1][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:], strict=False):
        if x0 <= x <= x1:
            if x1 == x0:
                return y1
            return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return pts[-1][1]


@lru_cache
def load_config(path: str) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


class HeuristicEstimator(Estimator):
    def __init__(self, config_path: Path | None = None) -> None:
        self.config_path = str(config_path or get_settings().heuristic_config)
        self.cfg = load_config(self.config_path)
        self.model_version = str(self.cfg.get("model_version", "heuristic_v1"))
        self.buckets = load_buckets(self.cfg.get("buckets"))

    def estimate(self, fv: FeatureVector, normalized: dict[str, float | None]) -> Estimate:
        cfg = self.cfg
        signal_estimates: dict[str, float] = {}
        weights: dict[str, float] = {}
        kinds: dict[str, str] = {}
        for name, spec in cfg.get("signals", {}).items():
            x = normalized.get(spec["feature"])
            if x is None:
                continue
            signal_estimates[name] = round(interpolate(spec["points"], float(x)), 3)
            weights[name] = float(spec.get("weight", 1.0))
            kinds[name] = str(spec.get("kind", "other"))
        notes: list[str] = []
        popularity = [n for n, k in kinds.items() if k == "popularity"]
        if signal_estimates:
            total_w = sum(weights.values())
            est = sum(signal_estimates[n] * weights[n] for n in signal_estimates) / total_w
        else:
            est = None

        mods = cfg.get("modifiers", {})
        if est is not None and not popularity:
            cap = float(cfg.get("no_popularity_cap", 4.6))
            if est > cap:
                notes.append(f"no popularity-list signal: capped at 10^{cap}")
                est = cap
        if est is None:
            # Nothing but reachability-type evidence (or nothing at all).
            if fv.crawl_reachable:
                est = 3.0
                notes.append("no ranking or size signal; reachable site assumed small")
            elif fv.dns_resolves:
                est = 2.5
                notes.append("no ranking signal; resolves but no page fetched")
            else:
                est = 2.0
                notes.append("no evidence at all")

        # Hard modifiers.
        unregistered = fv.rdap_status == "not_found" and bool(fv.dns_nxdomain)
        if unregistered:
            est = min(est, float(mods.get("unregistered_cap", 1.5)))
            notes.append("domain appears unregistered (RDAP not found, NXDOMAIN)")
        elif fv.dns_nxdomain:
            est = min(est, float(mods.get("nxdomain_cap", 2.0)))
            notes.append("domain does not resolve (NXDOMAIN)")
        # The crawl saw the actual homepage: a live, non-parked site outranks a parking-style
        # nameserver/IP hint from DNS (registrars reuse "parking" nameservers for live sites).
        crawl_saw_site = bool(fv.crawl_reachable) and fv.crawl_parked is False
        if fv.crawl_parked or (fv.dns_parked and not crawl_saw_site):
            est = min(est, float(mods.get("parked_cap", 2.3)))
            notes.append("parked domain")
        if fv.crawl_reachable is False and fv.dns_resolves:
            est += float(mods.get("unreachable_shift", -0.4))
            notes.append("homepage unreachable")
        if fv.crawl_blocked:
            est += float(mods.get("blocked_shift", 0.0))
            notes.append("crawler blocked by bot protection; crawl signals unavailable")
        if fv.analytics_detected:
            est += float(mods.get("analytics_shift", 0.0))
        if fv.advertising_tags_detected:
            est += float(mods.get("advertising_shift", 0.0))
        if fv.ecommerce_platform:
            est += float(mods.get("ecommerce_shift", 0.0))
        est = max(0.0, est)

        # Agreement is judged between the independent popularity signals; size signals use
        # deliberately conservative curves and would otherwise always look like disagreement.
        agreement_inputs = {n: v for n, v in signal_estimates.items() if kinds.get(n) == "popularity"} or signal_estimates
        label, conf_score, conf_details = compute_confidence(cfg.get("confidence", {}), fv, agreement_inputs)
        rng = cfg.get("range", {})
        sd = conf_details.get("signal_stddev_log10") or 0.0
        spread = (
            float(rng.get("base", 0.3))
            + float(rng.get("missing_evidence", 0.5)) * (1 - conf_details["coverage"])
            + float(rng.get("disagreement", 0.8)) * sd
        )
        spread = min(spread, float(rng.get("max", 1.3)))
        visits = int(round(10**est))
        lower = int(round(10 ** max(0.0, est - spread)))
        upper = int(round(10 ** (est + spread)))
        details = {
            "method": "weighted mean of per-signal log10 estimates (hand-set priors, unvalidated)",
            "log10_estimate": round(est, 3),
            "signal_estimates_log10": signal_estimates,
            "signal_weights": weights,
            "range_spread_log10": round(spread, 3),
            "notes": notes,
            "confidence": conf_details,
            "sources": {k: v.status for k, v in fv.sources.items()},
            "disclaimer": "Estimated from public signals; not measured traffic.",
        }
        return Estimate(
            domain=fv.domain,
            estimated_monthly_visits=visits,
            lower_bound=lower,
            upper_bound=upper,
            traffic_bucket=bucket_for(visits, self.buckets),
            confidence=label,
            confidence_score=conf_score,
            model_version=self.model_version,
            feature_version=fv.feature_version,
            generated_at=datetime.now(UTC),
            details=details,
        )


_estimators: dict[str, Estimator] = {}


def get_estimator(model_version: str | None = None) -> Estimator:
    name = model_version or get_settings().model_version
    if name not in _estimators:
        if name.startswith("heuristic"):
            _estimators[name] = HeuristicEstimator()
        else:
            raise ValueError(f"unknown model_version {name!r}; trained models are loaded via training/ (not yet available)")
    return _estimators[name]


def log10_or_none(v: float | None) -> float | None:
    return None if v is None or v <= 0 else math.log10(v)
