"""CLI: python -m traffic_estimator <command>

api                         run the HTTP API (uvicorn)
worker                      run a queue worker
scheduler                   run the scheduler (one instance)
migrate                     apply migrations and exit
enqueue <domain> [...]      submit domains (same as POST /domains/bulk)
estimate <domain>           print the latest estimate as JSON
lists refresh [provider]    download + load ranked lists now (all or one)
lists scan                  resolve pending domains in the Common Crawl web graph file
training export <file.jsonl>   export training examples
training import <file.jsonl>   import ground-truth rows (see training/dataset.py)
benchmark submit|wait|report <reference.csv> [options]
                            compare estimates with a reference CSV (see evaluation/benchmark.py;
                            `benchmark report --help` for options)
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys

from .settings import get_settings


def setup_logging() -> None:
    level = getattr(logging, get_settings().log_level.upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format='{"ts":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":%(message)r}',
        stream=sys.stdout,
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    setup_logging()
    s = get_settings()
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return
    cmd, rest = args[0], args[1:]
    if cmd == "api":
        import uvicorn

        uvicorn.run("traffic_estimator.api.app:app", host=s.api_host, port=s.api_port, log_level=s.log_level.lower(), proxy_headers=True)
    elif cmd == "worker":
        from .worker import main as worker_main

        worker_main()
    elif cmd == "scheduler":
        from .scheduler import main as scheduler_main

        scheduler_main()
    elif cmd == "migrate":
        from .db import migrate

        applied = asyncio.run(migrate())
        print(json.dumps({"applied": applied}))
    elif cmd == "enqueue":
        from .db import migrate
        from .pipeline import ingest_domains

        async def _run() -> None:
            await migrate()
            force = "--force" in rest
            domains = [d for d in rest if not d.startswith("--")]
            res = await ingest_domains(domains, force=force)
            print(json.dumps([r.__dict__ for r in res], indent=2, default=str))

        asyncio.run(_run())
    elif cmd == "estimate":
        from .api.app import _domain_row, _estimate_for

        async def _run() -> None:
            domain_id, _, _, _ = await _domain_row(rest[0])
            est = await _estimate_for(domain_id, include_details=True)
            print(est.model_dump_json(indent=2) if est else "null")

        asyncio.run(_run())
    elif cmd == "lists":
        from .db import migrate
        from .lists.loader import build_providers, refresh_provider, scan_pending

        async def _run() -> None:
            await migrate()
            sub = rest[0] if rest else "refresh"
            if sub == "refresh":
                providers = build_providers()
                wanted = rest[1:] or list(providers)
                for name in wanted:
                    if name not in providers:
                        print(f"unknown/disabled provider {name}", file=sys.stderr)
                        continue
                    print(json.dumps(await refresh_provider(providers[name], force="--force" in rest), default=str))
            elif sub == "scan":
                print(json.dumps(await scan_pending(), default=str))
            else:
                print(__doc__)

        asyncio.run(_run())
    elif cmd == "training":
        from .training.dataset import export_examples, import_examples

        async def _run() -> None:
            sub = rest[0] if rest else ""
            if sub == "export" and len(rest) > 1:
                n = await export_examples(rest[1])
                print(json.dumps({"exported": n}))
            elif sub == "import" and len(rest) > 1:
                n = await import_examples(rest[1])
                print(json.dumps({"imported": n}))
            else:
                print(__doc__)

        asyncio.run(_run())
    elif cmd == "benchmark":
        asyncio.run(_benchmark(rest))
    else:
        print(f"unknown command {cmd!r}\n{__doc__}", file=sys.stderr)
        sys.exit(2)


async def _benchmark(argv: list[str]) -> None:
    import argparse
    from datetime import UTC, datetime
    from pathlib import Path

    from .db import migrate
    from .estimator.heuristic import HeuristicEstimator
    from .evaluation import benchmark as bm

    p = argparse.ArgumentParser(prog="traffic_estimator benchmark")
    p.add_argument("action", choices=["submit", "wait", "report"])
    p.add_argument("reference", help="CSV with a domain column and a monthly visits column")
    p.add_argument("--domain-col", default="Domain")
    p.add_argument("--visits-col", default="Monthly Visits")
    p.add_argument("--website-col", default="Website", help="fallback column when the domain column is empty")
    p.add_argument("--keep-zero", action="store_true", help="treat reference 0 as a real value instead of 'no data'")
    p.add_argument("--keep-col", action="append", default=[], help="reference column copied into rows.csv (repeatable)")
    p.add_argument("--name", default="reference", help="reference label used in the report")
    p.add_argument("--force", action="store_true", help="submit: re-run domains processed recently")
    p.add_argument("--collectors", default="", help="submit: comma-separated collectors (default: all enabled)")
    p.add_argument("--timeout", type=float, default=6 * 3600, help="wait: seconds")
    p.add_argument("--config", default="", help="report: heuristic config YAML (default: TE_HEURISTIC_CONFIG)")
    p.add_argument("--out", default="", help="report: output directory (default: <data_dir>/benchmarks/<name>-<timestamp>)")
    a = p.parse_args(argv)

    refs, stats = bm.load_reference(
        a.reference,
        domain_col=a.domain_col,
        visits_col=a.visits_col,
        fallback_col=a.website_col,
        zero_is_missing=not a.keep_zero,
        keep_cols=a.keep_col,
    )
    domains = [r.domain for r in refs]
    await migrate()
    if a.action == "submit":
        collectors = [c.strip() for c in a.collectors.split(",") if c.strip()] or None
        counts = await bm.submit(domains, force=a.force, collectors=collectors)
        print(json.dumps({"domains": len(domains), "invalid": stats.invalid, **counts}))
    elif a.action == "wait":
        print(json.dumps(dict(await bm.wait(domains, timeout_s=a.timeout))))
    else:
        estimator = HeuristicEstimator(Path(a.config) if a.config else None)
        rows = await bm.score(refs, estimator)
        metrics = bm.compute_metrics(rows, estimator.buckets)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        out = Path(a.out) if a.out else get_settings().data_dir / "benchmarks" / f"{a.name}-{stamp}"
        out.mkdir(parents=True, exist_ok=True)
        (out / "metrics.json").write_text(json.dumps(metrics, indent=2, default=str), encoding="utf-8")
        bm.write_rows_csv(rows, out / "rows.csv", estimator.buckets)
        report = bm.render_report(
            metrics,
            rows,
            name=a.name,
            reference_path=a.reference,
            model_version=estimator.model_version,
            config_path=estimator.config_path,
            ref_stats=stats,
            buckets=estimator.buckets,
        )
        (out / "report.md").write_text(report, encoding="utf-8")
        print(json.dumps({"out": str(out), "counts": metrics["counts"], "overall": metrics["overall"]}, default=str))


if __name__ == "__main__":
    main()
