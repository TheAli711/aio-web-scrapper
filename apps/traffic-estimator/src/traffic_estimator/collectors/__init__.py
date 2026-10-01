"""Collector registry. To add a source: implement `Collector` (see base.py) and register it here."""

from __future__ import annotations

from ..settings import get_settings
from .base import Collector, CollectorContext, CollectorResult, Observation
from .commoncrawl import CommonCrawlCollector
from .crawler import CrawlCollector
from .dns import DnsCollector
from .lists import ListsCollector

ALL_COLLECTORS: dict[str, Collector] = {c.name: c for c in (ListsCollector(), CommonCrawlCollector(), CrawlCollector(), DnsCollector())}


def enabled_collectors() -> dict[str, Collector]:
    names = get_settings().enabled_collectors
    return {n: ALL_COLLECTORS[n] for n in names if n in ALL_COLLECTORS}


__all__ = [
    "ALL_COLLECTORS",
    "Collector",
    "CollectorContext",
    "CollectorResult",
    "Observation",
    "enabled_collectors",
]
