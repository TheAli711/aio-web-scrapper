"""Ground-truth dataset: import legitimately obtained traffic measurements, pair them with the
feature snapshot we computed for the domain, and export the result for training/evaluation.

Row format (JSON Lines) for `import`:
  {"domain": "example.com", "actual_monthly_visits": 73000, "source": "ga4_export",
   "measurement_date": "2026-09-01", "period_start": "2026-08-01", "period_end": "2026-08-31",
   "notes": "optional"}

The feature snapshot is taken from the latest domain_features row (run the pipeline first).
We never fabricate labels and never treat third-party estimates as ground truth.
"""

from __future__ import annotations

import json
from pathlib import Path

from sqlalchemy import text

from ..db import connection

ALLOWED_SOURCES_HINT = ("ga4_export", "owned_property", "owner_provided", "server_logs", "other_legitimate")


async def import_examples(path: str) -> int:
    n = 0
    async with connection() as conn:
        with Path(path).open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                domain = str(row["domain"]).strip().lower()
                visits = int(row["actual_monthly_visits"])
                source = str(row.get("source") or "other_legitimate")
                feat = (
                    await conn.execute(
                        text(
                            "SELECT f.features, f.feature_version FROM domain_features f JOIN domains d ON d.id = f.domain_id"
                            " WHERE d.name = :n ORDER BY f.computed_at DESC LIMIT 1"
                        ),
                        {"n": domain},
                    )
                ).first()
                if not feat:
                    raise RuntimeError(f"{domain}: no feature snapshot yet; run the pipeline for it first")
                await conn.execute(
                    text(
                        """
                        INSERT INTO training_examples
                          (domain, feature_snapshot, feature_version, actual_monthly_visits, source, measurement_date,
                           period_start, period_end, notes)
                        VALUES (:d, CAST(:f AS jsonb), :fv, :v, :s, :md, :ps, :pe, :notes)
                        ON CONFLICT (domain, source, measurement_date) DO UPDATE SET
                          feature_snapshot = EXCLUDED.feature_snapshot, feature_version = EXCLUDED.feature_version,
                          actual_monthly_visits = EXCLUDED.actual_monthly_visits, notes = EXCLUDED.notes
                        """
                    ),
                    {
                        "d": domain,
                        "f": json.dumps(feat[0]),
                        "fv": feat[1],
                        "v": visits,
                        "s": source,
                        "md": row["measurement_date"],
                        "ps": row.get("period_start"),
                        "pe": row.get("period_end"),
                        "notes": row.get("notes"),
                    },
                )
                n += 1
    return n


async def export_examples(path: str) -> int:
    n = 0
    async with connection() as conn:
        rows = await conn.execute(
            text(
                "SELECT domain, feature_snapshot, feature_version, actual_monthly_visits, source, measurement_date,"
                " period_start, period_end FROM training_examples ORDER BY domain, measurement_date"
            )
        )
        with Path(path).open("w", encoding="utf-8") as f:
            for r in rows:
                f.write(
                    json.dumps(
                        {
                            "domain": r[0],
                            "feature_snapshot": r[1],
                            "feature_version": r[2],
                            "actual_monthly_visits": r[3],
                            "source": r[4],
                            "measurement_date": r[5].isoformat(),
                            "period_start": r[6].isoformat() if r[6] else None,
                            "period_end": r[7].isoformat() if r[7] else None,
                        },
                        default=str,
                    )
                    + "\n"
                )
                n += 1
    return n
