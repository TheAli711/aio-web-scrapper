"""Confidence: how much evidence we have and how well independent signals agree.

Confidence is NOT a function of the traffic number. A tiny site with Tranco/CrUX absence, a
reachable crawl, DNS and a small sitemap can have high confidence in "<1K"; a huge site whose
crawl is blocked and whose lists disagree gets low confidence.
"""

from __future__ import annotations

import statistics
from typing import Any

from ..features.schema import FeatureVector

POPULARITY_SOURCES = ("tranco", "crux_top", "cc_webgraph", "majestic", "openpagerank")


def coverage(cfg: dict[str, Any], fv: FeatureVector) -> tuple[float, dict[str, float]]:
    """Weighted share of sources that produced evidence (present OR a definite absence)."""
    weights: dict[str, float] = cfg.get("source_weights", {})
    got: dict[str, float] = {}
    total = sum(weights.values()) or 1.0
    for src in weights:
        info = fv.sources.get(src)
        if info is None:
            got[src] = 0.0
            continue
        if info.status == "present":
            got[src] = 1.0
        elif info.status == "absent":
            # A definite "not in this list" / "no captures" is evidence too, slightly weaker.
            got[src] = 0.8
        elif info.status in ("unreachable",):
            got[src] = 0.5  # we learned something (the site is down) but not what we wanted
        elif info.status == "blocked":
            got[src] = 0.3
        else:  # missing / failed
            got[src] = 0.0
    score = sum(got[s] * weights[s] for s in weights) / total
    return round(score, 4), got


def agreement(cfg: dict[str, Any], signal_estimates: dict[str, float]) -> tuple[float, float | None]:
    """1 when all signal-level estimates (log10 visits) agree, 0 when their stddev reaches
    `disagreement_scale`. Returns (agreement, stddev)."""
    vals = list(signal_estimates.values())
    if len(vals) < 2:
        return (0.6 if len(vals) == 1 else 0.3), None
    sd = statistics.pstdev(vals)
    scale = float(cfg.get("disagreement_scale", 1.0)) or 1.0
    return round(max(0.0, 1.0 - min(1.0, sd / scale)), 4), round(sd, 4)


def compute_confidence(cfg: dict[str, Any], fv: FeatureVector, signal_estimates: dict[str, float]) -> tuple[str, float, dict[str, Any]]:
    cov, per_source = coverage(cfg, fv)
    agr, sd = agreement(cfg, signal_estimates)
    popularity_present = [s for s in POPULARITY_SOURCES if fv.sources.get(s) and fv.sources[s].status == "present"]
    bonus = float(cfg.get("popularity_bonus", 0.1)) if len(popularity_present) >= 2 else 0.0
    score = float(cfg.get("coverage_weight", 0.55)) * cov + float(cfg.get("agreement_weight", 0.35)) * agr + bonus
    # Evidence we could not get at all (crawl blocked/unreachable) caps the confidence.
    crawl = fv.sources.get("crawl")
    if crawl and crawl.status == "blocked":
        score = min(score, 0.65)
    score = round(max(0.0, min(1.0, score)), 2)
    labels = cfg.get("labels", {"high": 0.7, "medium": 0.4})
    if score >= float(labels.get("high", 0.7)):
        label = "high"
    elif score >= float(labels.get("medium", 0.4)):
        label = "medium"
    else:
        label = "low"
    details = {
        "coverage": cov,
        "coverage_by_source": per_source,
        "agreement": agr,
        "signal_stddev_log10": sd,
        "popularity_signals": popularity_present,
        "popularity_bonus": bonus,
    }
    return label, score, details
