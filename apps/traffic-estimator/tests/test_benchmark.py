import math

from traffic_estimator.evaluation.benchmark import (
    ReferenceStats,
    Scored,
    compute_metrics,
    error_summary,
    load_reference,
    ols,
    pearson,
    render_report,
    spearman,
    write_rows_csv,
)


def test_load_reference_normalizes_dedupes_and_treats_zero_as_missing(tmp_path):
    p = tmp_path / "ref.csv"
    p.write_text(
        "﻿Business,Website,Domain,Monthly Visits\n"
        'A,https://www.alpha.com,www.alpha.com,"12,345"\n'
        "A again,https://alpha.com,alpha.com,999\n"
        "B,https://beta.co.uk/shop,,500\n"
        "C,https://gamma.com,gamma.com,0\n"
        "D,,not a domain,10\n"
        "E,https://delta.com,delta.com,\n",
        encoding="utf-8",
    )
    rows, stats = load_reference(p, keep_cols=["Business"])
    by = {r.domain: r for r in rows}
    assert set(by) == {"alpha.com", "beta.co.uk", "gamma.com", "delta.com"}
    assert by["alpha.com"].visits == 12345  # first row wins
    assert by["alpha.com"].extra == {"Business": "A"}
    assert by["beta.co.uk"].visits == 500  # falls back to the Website column
    assert by["gamma.com"].visits is None  # 0 = no data
    assert by["delta.com"].visits is None
    assert stats.duplicates == 1 and stats.conflicting_duplicates == 1
    assert stats.invalid == ["not a domain"]
    assert stats.missing_value == 2

    rows, _ = load_reference(p, zero_is_missing=False)
    assert {r.domain: r.visits for r in rows}["gamma.com"] == 0


def test_rank_statistics():
    x = [1.0, 2.0, 3.0, 4.0, 5.0]
    assert math.isclose(pearson(x, [2 * v + 1 for v in x]), 1.0)
    assert math.isclose(spearman(x, [v**3 for v in x]), 1.0)
    assert math.isclose(spearman(x, [-v for v in x]), -1.0)
    assert spearman([1, 1, 2, 2], [1, 1, 2, 2]) == 1.0  # ties
    assert pearson([1, 2], [1, 2]) is None
    a, b = ols(x, [2 * v + 1 for v in x])
    assert math.isclose(a, 1.0) and math.isclose(b, 2.0)


def test_error_summary():
    s = error_summary([0.1, -0.2, 0.6, -1.5])
    assert s["n"] == 4
    assert s["bias_log10"] == round((0.1 - 0.2 + 0.6 - 1.5) / 4, 3)
    assert s["within_0.3"] == 0.5 and s["within_0.5"] == 0.5 and s["within_1.0"] == 0.75
    assert error_summary([]) == {"n": 0}


def _row(domain, ref, est, bucket, conf="high", lo=None, hi=None, signals=None):
    return Scored(
        domain=domain,
        reference=ref,
        run_status="completed",
        estimate=est,
        lower=lo if lo is not None else int(est / 3),
        upper=hi if hi is not None else int(est * 3),
        bucket=bucket,
        confidence=conf,
        confidence_score=0.8,
        signals=signals or {},
        signal_kinds={k: "popularity" for k in (signals or {})},
        sources={"tranco": "present" if signals else "absent", "crawl": "present"},
    )


def test_compute_metrics_and_report(tmp_path):
    rows = [
        _row("a.com", 5000, 6000, "1K-10K", signals={"tranco": 3.8}),  # same bucket, in range
        _row("b.com", 50000, 8000, "1K-10K", conf="low"),  # one bucket low, outside range
        _row("c.com", 200, 150_000, "100K-1M", conf="medium", signals={"tranco": 5.2}),  # 3 buckets high
        _row("d.com", None, 900, "<1K"),  # reference has no value
        Scored(domain="e.com", reference=1000, run_status="queued"),  # not estimated yet
    ]
    m = compute_metrics(rows)
    c = m["counts"]
    assert (c["reference_domains"], c["estimated"], c["compared"], c["reference_without_value"]) == (5, 4, 3, 1)
    assert c["run_status"] == {"completed": 4, "queued": 1}
    o = m["overall"]
    assert o["n"] == 3
    assert o["bucket_exact"] == round(1 / 3, 3)
    assert o["bucket_within_1"] == round(2 / 3, 3)
    assert o["baseline_median_visits"] == 5000
    assert o["reference_in_range"] == round(1 / 3, 3)
    assert m["confusion"]["1K-10K"]["1K-10K"] == 1
    assert m["confusion"]["10K-100K"]["1K-10K"] == 1
    assert m["confusion"]["<1K"]["100K-1M"] == 1
    assert m["by_confidence"]["low"]["n"] == 1
    assert m["by_evidence"]["with_popularity_signal"]["n"] == 2
    assert m["per_signal"]["tranco"]["n"] == 2
    assert m["reference_without_value"] == {"n": 1, "estimated_buckets": {"<1K": 1}, "estimated_below_5k": 1.0}

    md = render_report(
        m,
        rows,
        name="test-ref",
        reference_path="ref.csv",
        model_version="heuristic_v1",
        config_path="cfg.yaml",
        ref_stats=ReferenceStats(rows=5, domains=5),
    )
    assert "# Benchmark: heuristic_v1 vs test-ref" in md
    assert "not measured traffic" in md
    assert "c.com" in md

    out = tmp_path / "rows.csv"
    write_rows_csv(rows, out)
    lines = out.read_text(encoding="utf-8").splitlines()
    assert lines[0].startswith("domain,reference_visits,estimated_visits")
    assert len(lines) == 6
