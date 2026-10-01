"""Traffic buckets (classification target) from a visits number, using the configured edges."""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_BUCKETS = [
    {"label": "<1K", "min": 0, "max": 1000},
    {"label": "1K-10K", "min": 1000, "max": 10000},
    {"label": "10K-100K", "min": 10000, "max": 100000},
    {"label": "100K-1M", "min": 100000, "max": 1000000},
    {"label": "1M-10M", "min": 1000000, "max": 10000000},
    {"label": "10M+", "min": 10000000, "max": None},
]


@dataclass(frozen=True)
class Bucket:
    label: str
    min: int
    max: int | None  # exclusive; None = open-ended

    def contains(self, visits: float) -> bool:
        return visits >= self.min and (self.max is None or visits < self.max)


def load_buckets(config: list[dict] | None = None) -> list[Bucket]:
    raw = config or DEFAULT_BUCKETS
    buckets = [Bucket(label=str(b["label"]), min=int(b["min"]), max=(int(b["max"]) if b.get("max") is not None else None)) for b in raw]
    buckets.sort(key=lambda b: b.min)
    return buckets


def bucket_for(visits: float | None, buckets: list[Bucket] | None = None) -> str:
    bs = buckets or load_buckets()
    if visits is None or visits < 0:
        return bs[0].label
    for b in bs:
        if b.contains(visits):
            return b.label
    return bs[-1].label


def bucket_index(label: str, buckets: list[Bucket] | None = None) -> int:
    bs = buckets or load_buckets()
    for i, b in enumerate(bs):
        if b.label == label:
            return i
    raise KeyError(label)
