"""Benchmark our estimates against a reference dataset (a CSV of domain -> monthly visits).

A third-party reference (e.g. Similarweb numbers exported through a scraper) is itself a modelled
estimate built from panel/clickstream data, not measured traffic, and it is least reliable exactly
where most domains are: small sites. A reference value of 0 usually means "no data" (below the
provider's reporting threshold), not zero visits, so it is treated as missing. The benchmark
therefore measures agreement with the reference, not accuracy, and reference rows are never
written to `training_examples` (that table is for legitimate ground truth; training/dataset.py).

  submit  run the pipeline for every reference domain (recently processed ones are skipped)
  wait    block until those runs have finished
  report  recompute the estimates from the stored raw observations (optionally with another
          heuristic config; nothing is written to the database), compare them with the
          reference and write report.md + rows.csv
"""

from __future__ import annotations

import asyncio
import csv
import json
import math
import statistics
import time
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text

from ..db import connection
from ..domains import InvalidDomain, normalize_domain
from ..estimator.base import Estimator
from ..estimator.buckets import Bucket, bucket_for, bucket_index, load_buckets
from ..features.normalize import normalize

# Order of magnitude helpers: an error of 0.5 in log10 is a factor of ~3.2, 1.0 a factor of 10.
WITHIN = (0.3, 0.5, 1.0)


# ------------------------------------------------------------------------------------ reference
@dataclass
class RefRow:
    domain: str
    visits: float | None  # None: the reference has no usable value
    extra: dict[str, str] = field(default_factory=dict)


@dataclass
class ReferenceStats:
    rows: int = 0
    domains: int = 0
    duplicates: int = 0
    conflicting_duplicates: int = 0
    invalid: list[str] = field(default_factory=list)
    missing_value: int = 0


def load_reference(
    path: str | Path,
    *,
    domain_col: str = "Domain",
    visits_col: str = "Monthly Visits",
    fallback_col: str = "Website",
    zero_is_missing: bool = True,
    keep_cols: Iterable[str] = (),
) -> tuple[list[RefRow], ReferenceStats]:
    """Read a reference CSV. Domains are normalised like API input (scheme/www/path stripped,
    registrable domain); the first row wins for duplicates."""
    stats = ReferenceStats()
    out: dict[str, RefRow] = {}
    keep = tuple(keep_cols)
    with Path(path).open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None or visits_col not in reader.fieldnames:
            raise ValueError(f"{path}: column {visits_col!r} not found (columns: {reader.fieldnames})")
        for row in reader:
            stats.rows += 1
            raw = (row.get(domain_col) or "").strip() or (row.get(fallback_col) or "").strip()
            try:
                name = normalize_domain(raw).name
            except InvalidDomain:
                stats.invalid.append(raw)
                continue
            visits = _parse_number(row.get(visits_col))
            if visits is not None and (visits < 0 or (visits == 0 and zero_is_missing)):
                visits = None
            if name in out:
                stats.duplicates += 1
                if out[name].visits != visits:
                    stats.conflicting_duplicates += 1
                continue
            out[name] = RefRow(name, visits, {c: (row.get(c) or "") for c in keep})
    stats.domains = len(out)
    stats.missing_value = sum(1 for r in out.values() if r.visits is None)
    return list(out.values()), stats


def _parse_number(raw: str | None) -> float | None:
    if raw is None:
        return None
    s = raw.strip().replace(",", "").replace("_", "")
    if not s:
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


# ------------------------------------------------------------------------------------ pipeline side
async def submit(domains: list[str], *, force: bool = False, collectors: list[str] | None = None, chunk: int = 1000) -> Counter:
    from ..pipeline import ingest_domains

    counts: Counter = Counter()
    for i in range(0, len(domains), chunk):
        for r in await ingest_domains(domains[i : i + chunk], force=force, collectors=collectors):
            counts[r.status] += 1
    return counts


async def run_status(domains: list[str]) -> Counter:
    """Status of each domain's latest run: completed | queued | running | failed | not_submitted."""
    async with connection() as conn:
        rows = await conn.execute(
            text(
                """
                SELECT d.name, r.status FROM domains d
                LEFT JOIN pipeline_runs r ON r.id = d.last_run_id
                WHERE d.name = ANY(:names)
                """
            ),
            {"names": domains},
        )
        found = {r[0]: (r[1] or "not_submitted") for r in rows}
    return Counter(found.get(d, "not_submitted") for d in domains)


async def wait(domains: list[str], *, timeout_s: float = 6 * 3600, poll_s: float = 15.0, log: Any = print) -> Counter:
    started = time.monotonic()
    while True:
        st = await run_status(domains)
        log(json.dumps({"elapsed_s": round(time.monotonic() - started), **st}))
        if st["queued"] + st["running"] == 0 or time.monotonic() - started > timeout_s:
            return st
        await asyncio.sleep(poll_s)


@dataclass
class Scored:
    domain: str
    reference: float | None
    run_status: str
    estimate: int | None = None
    lower: int | None = None
    upper: int | None = None
    bucket: str | None = None
    confidence: str | None = None
    confidence_score: float | None = None
    signals: dict[str, float] = field(default_factory=dict)  # per-signal log10 estimates
    signal_kinds: dict[str, str] = field(default_factory=dict)
    sources: dict[str, str] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    features: dict[str, Any] = field(default_factory=dict)
    extra: dict[str, str] = field(default_factory=dict)


async def score(refs: list[RefRow], estimator: Estimator) -> list[Scored]:
    """Recompute each reference domain's estimate from its stored observations (no writes)."""
    from ..pipeline import build_features

    names = [r.domain for r in refs]
    async with connection() as conn:
        rows = await conn.execute(
            text(
                """
                SELECT d.id, d.name, r.status FROM domains d
                LEFT JOIN pipeline_runs r ON r.id = d.last_run_id
                WHERE d.name = ANY(:names)
                """
            ),
            {"names": names},
        )
        known = {r[1]: (int(r[0]), r[2] or "not_submitted") for r in rows}
        out: list[Scored] = []
        kinds = {name: str(spec.get("kind", "other")) for name, spec in getattr(estimator, "cfg", {}).get("signals", {}).items()}
        for ref in refs:
            domain_id, status = known.get(ref.domain, (None, "not_submitted"))
            sc = Scored(ref.domain, ref.visits, status, extra=ref.extra)
            if domain_id is not None and status == "completed":
                fv = await build_features(conn, domain_id, ref.domain)
                est = estimator.estimate(fv, normalize(fv))
                det = est.details or {}
                sc.estimate, sc.lower, sc.upper = est.estimated_monthly_visits, est.lower_bound, est.upper_bound
                sc.bucket, sc.confidence, sc.confidence_score = est.traffic_bucket, est.confidence, est.confidence_score
                sc.signals = dict(det.get("signal_estimates_log10") or {})
                sc.signal_kinds = {k: kinds.get(k, "other") for k in sc.signals}
                sc.sources = {k: v.status for k, v in fv.sources.items()}
                sc.notes = list(det.get("notes") or [])
                sc.features = {
                    "tranco_rank": fv.tranco_rank,
                    "crux_rank_bucket": fv.crux_rank_bucket,
                    "ccg_harmonic_rank": fv.ccg_harmonic_rank,
                    "majestic_rank": fv.majestic_rank,
                    "opr_rank": fv.opr_rank,
                    "opr_ref_domains": fv.opr_ref_domains,
                    "sitemap_page_count": fv.sitemap_page_count,
                    "product_count": fv.product_count,
                    "ecommerce_platform": fv.ecommerce_platform,
                    "crawl_reachable": fv.crawl_reachable,
                    "crawl_blocked": fv.crawl_blocked,
                    "domain_age_days": fv.domain_age_days,
                }
            out.append(sc)
    return out


# ------------------------------------------------------------------------------------ statistics
def _ranks(values: list[float]) -> list[float]:
    """Average ranks (1-based), ties share the mean rank."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def pearson(x: list[float], y: list[float]) -> float | None:
    if len(x) < 3 or len(x) != len(y):
        return None
    mx, my = statistics.fmean(x), statistics.fmean(y)
    sxx = sum((a - mx) ** 2 for a in x)
    syy = sum((b - my) ** 2 for b in y)
    if sxx == 0 or syy == 0:
        return None
    return sum((a - mx) * (b - my) for a, b in zip(x, y, strict=True)) / math.sqrt(sxx * syy)


def spearman(x: list[float], y: list[float]) -> float | None:
    if len(x) < 3 or len(x) != len(y):
        return None
    return pearson(_ranks(x), _ranks(y))


def ols(x: list[float], y: list[float]) -> tuple[float, float] | None:
    """Least squares y = a + b*x. Returns (a, b)."""
    if len(x) < 3:
        return None
    mx, my = statistics.fmean(x), statistics.fmean(y)
    sxx = sum((a - mx) ** 2 for a in x)
    if sxx == 0:
        return None
    b = sum((a - mx) * (c - my) for a, c in zip(x, y, strict=True)) / sxx
    return my - b * mx, b


def error_summary(errors: list[float]) -> dict[str, Any]:
    """Summary of log10(estimate) - log10(reference)."""
    if not errors:
        return {"n": 0}
    abs_e = sorted(abs(e) for e in errors)
    out: dict[str, Any] = {
        "n": len(errors),
        "bias_log10": round(statistics.fmean(errors), 3),
        "median_error_log10": round(statistics.median(errors), 3),
        "mae_log10": round(statistics.fmean(abs_e), 3),
        "rmse_log10": round(math.sqrt(statistics.fmean(e * e for e in errors)), 3),
        "p90_abs_error_log10": round(abs_e[min(len(abs_e) - 1, int(0.9 * len(abs_e)))], 3),
    }
    for w in WITHIN:
        out[f"within_{w}"] = round(sum(1 for e in abs_e if e <= w) / len(abs_e), 3)
    return out


def compute_metrics(rows: list[Scored], buckets: list[Bucket] | None = None) -> dict[str, Any]:
    bs = buckets or load_buckets()
    labels = [b.label for b in bs]
    estimated = [r for r in rows if r.estimate is not None]
    scored = [r for r in estimated if r.reference and r.reference > 0 and r.estimate and r.estimate > 0]

    def ref_bucket(r: Scored) -> str:
        return bucket_for(r.reference, bs)

    def err(r: Scored) -> float:
        return math.log10(r.estimate) - math.log10(r.reference)  # type: ignore[arg-type]

    def group(sel: list[Scored]) -> dict[str, Any]:
        out = error_summary([err(r) for r in sel])
        if sel:
            diffs = [bucket_index(r.bucket, bs) - bucket_index(ref_bucket(r), bs) for r in sel]  # type: ignore[arg-type]
            out["bucket_exact"] = round(sum(1 for d in diffs if d == 0) / len(diffs), 3)
            out["bucket_within_1"] = round(sum(1 for d in diffs if abs(d) <= 1) / len(diffs), 3)
            in_range = [r for r in sel if r.lower is not None and r.upper is not None]
            if in_range:
                out["reference_in_range"] = round(sum(1 for r in in_range if r.lower <= r.reference <= r.upper) / len(in_range), 3)  # type: ignore[operator]
        return out

    overall = group(scored)
    lx = [math.log10(r.estimate) for r in scored]  # type: ignore[arg-type]
    ly = [math.log10(r.reference) for r in scored]  # type: ignore[arg-type]
    overall["spearman"] = _round(spearman(lx, ly))
    overall["pearson_log10"] = _round(pearson(lx, ly))
    fit = ols(lx, ly)
    if fit:
        overall["fit_reference_on_estimate"] = {"intercept": round(fit[0], 3), "slope": round(fit[1], 3)}
    if ly:
        # Context for the MAE: a "model" that answers the reference median for every domain.
        med = statistics.median(ly)
        overall["baseline_median_mae_log10"] = round(statistics.fmean(abs(v - med) for v in ly), 3)
        overall["baseline_median_visits"] = round(10**med)

    confusion = {rl: dict.fromkeys(labels, 0) for rl in labels}
    for r in scored:
        confusion[ref_bucket(r)][r.bucket] += 1  # type: ignore[index]

    by_conf = {c: group([r for r in scored if r.confidence == c]) for c in ("high", "medium", "low")}
    by_ref_bucket = {lbl: group([r for r in scored if ref_bucket(r) == lbl]) for lbl in labels}
    by_evidence = {
        "with_popularity_signal": group([r for r in scored if any(k == "popularity" for k in r.signal_kinds.values())]),
        "without_popularity_signal": group([r for r in scored if not any(k == "popularity" for k in r.signal_kinds.values())]),
    }

    per_signal: dict[str, Any] = {}
    names = sorted({s for r in scored for s in r.signals})
    for s in names:
        sel = [r for r in scored if s in r.signals]
        sx = [r.signals[s] for r in sel]
        sy = [math.log10(r.reference) for r in sel]  # type: ignore[arg-type]
        e = [a - b for a, b in zip(sx, sy, strict=True)]
        info = error_summary(e)
        info["coverage"] = round(len(sel) / len(scored), 3) if scored else 0.0
        info["spearman"] = _round(spearman(sx, sy))
        f = ols(sx, sy)
        if f:
            info["fit_reference_on_signal"] = {"intercept": round(f[0], 3), "slope": round(f[1], 3)}
        per_signal[s] = info

    no_ref = [r for r in estimated if not r.reference]
    return {
        "counts": {
            "reference_domains": len(rows),
            "estimated": len(estimated),
            "compared": len(scored),
            "reference_without_value": sum(1 for r in rows if not r.reference),
            "run_status": dict(Counter(r.run_status for r in rows)),
        },
        "overall": overall,
        "confusion": confusion,
        "by_confidence": by_conf,
        "by_reference_bucket": by_ref_bucket,
        "by_evidence": by_evidence,
        "per_signal": per_signal,
        "reference_without_value": {
            "n": len(no_ref),
            "estimated_buckets": dict(Counter(r.bucket for r in no_ref)),
            "estimated_below_5k": round(sum(1 for r in no_ref if (r.estimate or 0) < 5000) / len(no_ref), 3) if no_ref else None,
        },
        "source_status": {
            src: dict(Counter(r.sources.get(src, "none") for r in estimated)) for src in sorted({s for r in estimated for s in r.sources})
        },
    }


def _round(v: float | None, n: int = 3) -> float | None:
    return None if v is None else round(v, n)


# ------------------------------------------------------------------------------------ output
def write_rows_csv(rows: list[Scored], path: Path, buckets: list[Bucket] | None = None) -> None:
    bs = buckets or load_buckets()
    extra_cols = sorted({k for r in rows for k in r.extra})
    feat_cols = sorted({k for r in rows for k in r.features})
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(
            [
                "domain",
                "reference_visits",
                "estimated_visits",
                "lower_bound",
                "upper_bound",
                "reference_bucket",
                "estimated_bucket",
                "bucket_diff",
                "log10_error",
                "reference_in_range",
                "confidence",
                "confidence_score",
                "run_status",
                "signals_log10",
                "sources",
                "notes",
                *feat_cols,
                *[f"ref_{c}" for c in extra_cols],
            ]
        )
        for r in rows:
            ok = r.estimate is not None and r.reference
            rb = bucket_for(r.reference, bs) if r.reference else ""
            w.writerow(
                [
                    r.domain,
                    "" if r.reference is None else int(r.reference),
                    r.estimate if r.estimate is not None else "",
                    r.lower if r.lower is not None else "",
                    r.upper if r.upper is not None else "",
                    rb,
                    r.bucket or "",
                    bucket_index(r.bucket, bs) - bucket_index(rb, bs) if ok and r.bucket else "",
                    round(math.log10(max(r.estimate, 1)) - math.log10(r.reference), 3) if ok else "",  # type: ignore[arg-type]
                    (r.lower <= r.reference <= r.upper) if ok and r.lower is not None and r.upper is not None else "",  # type: ignore[operator]
                    r.confidence or "",
                    r.confidence_score if r.confidence_score is not None else "",
                    r.run_status,
                    json.dumps(r.signals, sort_keys=True) if r.signals else "",
                    ";".join(f"{k}={v}" for k, v in sorted(r.sources.items())),
                    " | ".join(r.notes),
                    *[r.features.get(c, "") if r.features.get(c) is not None else "" for c in feat_cols],
                    *[r.extra.get(c, "") for c in extra_cols],
                ]
            )


def _table(headers: list[str], rows: list[list[Any]]) -> str:
    def fmt(v: Any) -> str:
        if v is None:
            return "–"
        if isinstance(v, float):
            return f"{v:.3f}".rstrip("0").rstrip(".") if abs(v) < 1000 else f"{v:,.0f}"
        return str(v)

    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    lines += ["| " + " | ".join(fmt(v) for v in row) + " |" for row in rows]
    return "\n".join(lines)


def _pct(v: Any) -> str:
    return "–" if v is None else f"{100 * float(v):.0f}%"


def render_report(
    metrics: dict[str, Any],
    rows: list[Scored],
    *,
    name: str,
    reference_path: str,
    model_version: str,
    config_path: str,
    ref_stats: ReferenceStats,
    buckets: list[Bucket] | None = None,
) -> str:
    bs = buckets or load_buckets()
    labels = [b.label for b in bs]
    o = metrics["overall"]
    c = metrics["counts"]
    out: list[str] = []
    out.append(f"# Benchmark: {model_version} vs {name}\n")
    out.append(
        f"Generated {datetime.now(UTC).strftime('%Y-%m-%d %H:%M UTC')} from `{reference_path}` with `{config_path}`.\n\n"
        f"The reference is a third-party estimate, not measured traffic: agreement with it is not accuracy. "
        f"Errors are `log10(ours) − log10(reference)` (0.3 ≈ ×2, 0.5 ≈ ×3.2, 1.0 = ×10). "
        f'Reference values of 0 are treated as "no data".\n'
    )
    out.append("## Coverage\n")
    out.append(
        _table(
            ["reference rows", "unique domains", "duplicates", "invalid", "no reference value", "estimated", "compared"],
            [
                [
                    ref_stats.rows,
                    ref_stats.domains,
                    ref_stats.duplicates,
                    len(ref_stats.invalid),
                    c["reference_without_value"],
                    c["estimated"],
                    c["compared"],
                ]
            ],
        )
    )
    out.append(f"\nRun status of reference domains: {', '.join(f'{k} {v}' for k, v in sorted(c['run_status'].items()))}.\n")
    out.append("## Overall agreement\n")
    out.append(
        _table(
            [
                "n",
                "bias",
                "median err",
                "MAE",
                "RMSE",
                "within ×2",
                "within ×3.2",
                "within ×10",
                "bucket exact",
                "±1 bucket",
                "ref in our range",
                "Spearman",
            ],
            [
                [
                    o.get("n"),
                    o.get("bias_log10"),
                    o.get("median_error_log10"),
                    o.get("mae_log10"),
                    o.get("rmse_log10"),
                    _pct(o.get("within_0.3")),
                    _pct(o.get("within_0.5")),
                    _pct(o.get("within_1.0")),
                    _pct(o.get("bucket_exact")),
                    _pct(o.get("bucket_within_1")),
                    _pct(o.get("reference_in_range")),
                    o.get("spearman"),
                ]
            ],
        )
    )
    if o.get("fit_reference_on_estimate"):
        f = o["fit_reference_on_estimate"]
        out.append(
            f"\nLeast-squares fit `log10(reference) = {f['intercept']} + {f['slope']} × log10(ours)` "
            "(slope < 1: our estimates are more spread out than the reference; > 1: compressed).\n"
        )
    if o.get("baseline_median_mae_log10") is not None:
        out.append(
            f"\nBaseline: answering the reference median ({o['baseline_median_visits']:,} visits) for every domain gives "
            f"MAE {o['baseline_median_mae_log10']}; an estimator that adds information must beat that.\n"
        )
    out.append("## Bucket confusion (rows: reference, columns: ours)\n")
    out.append(_table(["reference \\ ours", *labels], [[rl, *[metrics["confusion"][rl][cl] for cl in labels]] for rl in labels]))
    out.append("\n## By reference bucket\n")
    out.append(_group_table(metrics["by_reference_bucket"], "reference bucket"))
    out.append("\n## By our confidence\n")
    out.append(_group_table(metrics["by_confidence"], "confidence"))
    out.append("\n## By evidence\n")
    out.append(_group_table(metrics["by_evidence"], "evidence"))
    out.append("\n## Per signal (signal-level estimate vs reference)\n")
    sig_rows = []
    for s, i in sorted(metrics["per_signal"].items(), key=lambda kv: -kv[1].get("coverage", 0)):
        fit = i.get("fit_reference_on_signal") or {}
        sig_rows.append(
            [
                s,
                i.get("n"),
                _pct(i.get("coverage")),
                i.get("bias_log10"),
                i.get("mae_log10"),
                i.get("spearman"),
                fit.get("intercept"),
                fit.get("slope"),
            ]
        )
    out.append(_table(["signal", "n", "coverage", "bias", "MAE", "Spearman", "fit intercept", "fit slope"], sig_rows))
    nr = metrics["reference_without_value"]
    if nr["n"]:
        out.append(f"\n## Reference has no value ({nr['n']} domains)\n")
        out.append(
            "Usually below the reference provider's reporting threshold. Our buckets for them: "
            + ", ".join(f"{k} {v}" for k, v in sorted(nr["estimated_buckets"].items(), key=lambda kv: bucket_index(kv[0], bs)))
            + f"; {_pct(nr['estimated_below_5k'])} estimated below 5K.\n"
        )
    out.append("\n## Source status (estimated domains)\n")
    src_states = sorted({st for v in metrics["source_status"].values() for st in v})
    out.append(_table(["source", *src_states], [[s, *[v.get(st, 0) for st in src_states]] for s, v in metrics["source_status"].items()]))
    scored = [r for r in rows if r.estimate and r.reference]
    scored.sort(key=lambda r: math.log10(r.estimate) - math.log10(r.reference))  # type: ignore[arg-type]
    for title, sel in (("We are far below the reference", scored[:15]), ("We are far above the reference", scored[::-1][:15])):
        out.append(f"\n## {title}\n")
        out.append(
            _table(
                ["domain", "reference", "ours", "range", "confidence", "signals (log10)", "notes"],
                [
                    [
                        r.domain,
                        f"{int(r.reference):,}",  # type: ignore[arg-type]
                        f"{r.estimate:,}",
                        f"{r.lower:,}–{r.upper:,}",
                        r.confidence,
                        ", ".join(f"{k} {v:.1f}" for k, v in r.signals.items()) or "–",
                        "; ".join(r.notes) or "–",
                    ]
                    for r in sel
                ],
            )
        )
    return "\n".join(out) + "\n"


def _group_table(groups: dict[str, dict[str, Any]], key: str) -> str:
    rows = []
    for g, i in groups.items():
        if not i.get("n"):
            continue
        rows.append(
            [
                g,
                i["n"],
                i.get("bias_log10"),
                i.get("mae_log10"),
                _pct(i.get("within_0.5")),
                _pct(i.get("bucket_exact")),
                _pct(i.get("bucket_within_1")),
                _pct(i.get("reference_in_range")),
            ]
        )
    return _table([key, "n", "bias", "MAE", "within ×3.2", "bucket exact", "±1 bucket", "ref in range"], rows)
