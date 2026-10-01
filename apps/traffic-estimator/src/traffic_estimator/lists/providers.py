"""Bulk ranked-list providers: free, downloadable, refreshed on a schedule, looked up locally.

None of these is traffic. They are popularity / link-graph signals keyed by registrable domain:

  tranco        Tranco daily list (pay-level domains, full ~4.6M rows)   rank
  majestic      Majestic Million (CC BY 3.0)                             rank, ref_subnets, ref_ips
  openpagerank  Open PageRank top 10M (derived from Common Crawl)        rank, score 0..10, ref_domains
  crux_top      CrUX top origins (Chrome UX Report, CC BY 4.0)          rank bucket (1000 ... 1000000)
  cc_webgraph   Common Crawl domain-level web graph ranks                harmonic rank/value, PageRank, n_hosts

Access mechanisms were verified on 2026-10-01; see docs/traffic-estimator/data-sources.md.
"""

from __future__ import annotations

import csv
import io
import re
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime
from email.utils import parsedate_to_datetime
from typing import IO

from ..domains import registrable_domain, unreverse_domain
from ..http import fetch

_DOMAIN_RE = re.compile(r"^[a-z0-9.-]{3,253}$")


@dataclass(frozen=True)
class ListVersion:
    list_id: str
    list_date: date | None
    url: str


@dataclass
class Entry:
    domain: str
    rank: int | None
    score: float | None = None
    pr_rank: int | None = None
    pr_score: float | None = None
    n_hosts: int | None = None
    ref_domains: int | None = None
    ref_subnets: int | None = None
    ref_ips: int | None = None


class ListProvider:
    name: str
    refresh_hours: int = 24 * 7
    keep_file: bool = False  # keep the downloaded file for later full scans
    top_n: int | None = None  # only load the first N rows (file must be sorted by rank)
    complete: bool = True  # a missing row means "not in the list" (vs. "not loaded")

    async def resolve(self) -> ListVersion:
        raise NotImplementedError

    def parse(self, stream: IO[bytes]) -> Iterator[Entry]:
        raise NotImplementedError


def _text(stream: IO[bytes]) -> io.TextIOWrapper:
    return io.TextIOWrapper(stream, encoding="utf-8", errors="replace", newline="")


def _clean_domain(s: str) -> str | None:
    s = s.strip().lower().rstrip(".")
    if not s or not _DOMAIN_RE.fullmatch(s) or "." not in s:
        return None
    return s


def _int(s: str | None) -> int | None:
    try:
        return int(s) if s not in (None, "") else None
    except ValueError:
        return None


def _float(s: str | None) -> float | None:
    try:
        return float(s) if s not in (None, "") else None
    except ValueError:
        return None


# ------------------------------------------------------------------------------------ Tranco
class TrancoProvider(ListProvider):
    name = "tranco"
    refresh_hours = 24 * 7

    def __init__(self, base_url: str = "https://tranco-list.eu", scope: str = "full") -> None:
        self.base_url = base_url.rstrip("/")
        self.scope = scope  # "full" (~4.6M pay-level domains, plain CSV) or "1000000"

    async def resolve(self) -> ListVersion:
        r = await fetch(f"{self.base_url}/top-1m-id", limiter_key="tranco", max_bytes=1000)
        if not r.ok:
            raise RuntimeError(f"tranco: cannot resolve latest list id (status={r.status} err={r.error})")
        list_id = r.text().strip()
        if not re.fullmatch(r"[A-Za-z0-9]{3,12}", list_id):
            raise RuntimeError(f"tranco: unexpected list id {list_id!r}")
        list_date: date | None = None
        meta = await fetch(f"{self.base_url}/api/lists/id/{list_id}", limiter_key="tranco", max_bytes=20_000)
        if meta.ok:
            try:
                created = meta.json().get("created_on")
                if created:
                    list_date = datetime.fromisoformat(created).date()
            except (ValueError, AttributeError):
                pass
        return ListVersion(list_id=list_id, list_date=list_date, url=f"{self.base_url}/download/{list_id}/{self.scope}")

    def parse(self, stream: IO[bytes]) -> Iterator[Entry]:
        for line in _text(stream):
            rank_s, _, dom = line.strip().partition(",")
            d = _clean_domain(dom)
            rank = _int(rank_s)
            if d and rank:
                yield Entry(domain=d, rank=rank)


# ------------------------------------------------------------------------------------ Majestic
class MajesticProvider(ListProvider):
    name = "majestic"
    refresh_hours = 24 * 7

    def __init__(self, url: str = "https://downloads.majestic.com/majestic_million.csv") -> None:
        self.url = url

    async def resolve(self) -> ListVersion:
        r = await fetch(self.url, method="HEAD", limiter_key="lists", max_bytes=0)
        return ListVersion(list_id=_date_id(r.headers.get("last-modified")), list_date=_date_from_id_header(r.headers), url=self.url)

    def parse(self, stream: IO[bytes]) -> Iterator[Entry]:
        for row in csv.DictReader(_text(stream)):
            d = _clean_domain(row.get("Domain", ""))
            rank = _int(row.get("GlobalRank"))
            if d and rank:
                yield Entry(domain=d, rank=rank, ref_subnets=_int(row.get("RefSubNets")), ref_ips=_int(row.get("RefIPs")))


# ------------------------------------------------------------------------------------ Open PageRank
class OpenPageRankProvider(ListProvider):
    name = "openpagerank"
    refresh_hours = 24 * 30

    def __init__(self, url: str = "https://openpagerank.keywordseverywhere.com/downloads/top10milliondomains.csv.zip") -> None:
        self.url = url

    async def resolve(self) -> ListVersion:
        r = await fetch(self.url, method="HEAD", limiter_key="lists", max_bytes=0)
        return ListVersion(list_id=_date_id(r.headers.get("last-modified")), list_date=_date_from_id_header(r.headers), url=self.url)

    def parse(self, stream: IO[bytes]) -> Iterator[Entry]:
        reader = csv.reader(_text(stream))
        header = [h.strip().lower() for h in next(reader, [])]

        def col(*names: str) -> int | None:
            for n in names:
                if n in header:
                    return header.index(n)
            return None

        i_rank, i_dom = col("rank"), col("domain")
        i_score, i_ref = col("open page rank", "open_page_rank"), col("referring domains", "referring_domains")
        if i_rank is None or i_dom is None:
            raise RuntimeError(f"openpagerank: unexpected header {header!r}")
        for row in reader:
            if len(row) <= max(i_rank, i_dom):
                continue
            d = _clean_domain(row[i_dom])
            rank = _int(row[i_rank])
            if d and rank:
                yield Entry(
                    domain=d,
                    rank=rank,
                    score=_float(row[i_score]) if i_score is not None and i_score < len(row) else None,
                    ref_domains=_int(row[i_ref]) if i_ref is not None and i_ref < len(row) else None,
                )


# ------------------------------------------------------------------------------------ CrUX top list
class CruxTopProvider(ListProvider):
    """origin,rank with rank buckets (1000, 5000, ..., 1000000); several origins may map to one domain,
    we keep the best (smallest) bucket."""

    name = "crux_top"
    refresh_hours = 24 * 30

    def __init__(self, url: str = "https://raw.githubusercontent.com/zakird/crux-top-lists/main/data/global/current.csv.gz") -> None:
        self.url = url

    async def resolve(self) -> ListVersion:
        r = await fetch(self.url, method="HEAD", limiter_key="lists", max_bytes=0)
        # GitHub raw gives no useful Last-Modified for the "current" alias; use the ETag.
        etag = (r.headers.get("etag") or "").strip('"W/') or _date_id(None)
        return ListVersion(list_id=etag[:40], list_date=date.today(), url=self.url)

    def parse(self, stream: IO[bytes]) -> Iterator[Entry]:
        best: dict[str, int] = {}
        reader = csv.reader(_text(stream))
        next(reader, None)
        for row in reader:
            if len(row) < 2:
                continue
            origin, rank = row[0].strip().lower(), _int(row[1])
            host = origin.split("://", 1)[-1].split("/", 1)[0]
            d = registrable_domain(host) if host else None
            if d and rank:
                if rank < best.get(d, 10**12):
                    best[d] = rank
        for d, rank in best.items():
            yield Entry(domain=d, rank=rank)


# ------------------------------------------------------------------------------------ Common Crawl web graph
class CommonCrawlWebGraphProvider(ListProvider):
    """Domain-level ranks of the Common Crawl host/domain web graph (~133M domains, ~2.3 GB gz).
    Only the top N rows are loaded into Postgres; other domains are found by scanning the kept file
    (see loader.scan_file), so `complete` is False."""

    name = "cc_webgraph"
    refresh_hours = 24 * 30
    keep_file = True
    complete = False

    def __init__(
        self,
        top_n: int = 5_000_000,
        graphinfo_url: str = "https://index.commoncrawl.org/graphinfo.json",
        data_base_url: str = "https://data.commoncrawl.org/projects/hyperlinkgraph",
    ) -> None:
        self.top_n = top_n
        self.graphinfo_url = graphinfo_url
        self.data_base_url = data_base_url.rstrip("/")

    async def resolve(self) -> ListVersion:
        r = await fetch(self.graphinfo_url, limiter_key="lists", max_bytes=2_000_000)
        if not r.ok:
            raise RuntimeError(f"cc_webgraph: cannot fetch graphinfo (status={r.status} err={r.error})")
        releases = r.json()
        if not isinstance(releases, list) or not releases:
            raise RuntimeError("cc_webgraph: empty graphinfo")
        latest = releases[0]
        rid = str(latest["id"])  # e.g. cc-main-2026-jul-aug-sep
        m = re.search(r"(\d{4})-([a-z]{3})-([a-z]{3})-([a-z]{3})$", rid)
        list_date = None
        if m:
            months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
            try:
                list_date = date(int(m.group(1)), months.index(m.group(4)) + 1, 1)
            except ValueError:
                list_date = None
        return ListVersion(list_id=rid, list_date=list_date, url=f"{self.data_base_url}/{rid}/domain/{rid}-domain-ranks.txt.gz")

    def parse(self, stream: IO[bytes]) -> Iterator[Entry]:
        for line in _text(stream):
            e = parse_webgraph_line(line)
            if e:
                yield e


def parse_webgraph_line(line: str) -> Entry | None:
    # #harmonicc_pos  #harmonicc_val  #pr_pos  #pr_val  #host_rev  #n_hosts
    if not line or line[0] == "#":
        return None
    parts = line.rstrip("\n").split("\t")
    if len(parts) < 5:
        return None
    d = _clean_domain(unreverse_domain(parts[4]))
    rank = _int(parts[0])
    if not d or not rank:
        return None
    return Entry(
        domain=d,
        rank=rank,
        score=_float(parts[1]),
        pr_rank=_int(parts[2]),
        pr_score=_float(parts[3]),
        n_hosts=_int(parts[5]) if len(parts) > 5 else None,
    )


def _date_id(last_modified: str | None) -> str:
    if last_modified:
        try:
            return parsedate_to_datetime(last_modified).astimezone(UTC).strftime("%Y-%m-%d")
        except (TypeError, ValueError):
            pass
    return datetime.now(UTC).strftime("%Y-%m-%d")


def _date_from_id_header(headers: dict[str, str]) -> date:
    return date.fromisoformat(_date_id(headers.get("last-modified")))


def entry_to_json(e: Entry) -> dict:
    return {k: v for k, v in e.__dict__.items() if v is not None}


__all__ = [
    "CommonCrawlWebGraphProvider",
    "CruxTopProvider",
    "Entry",
    "ListProvider",
    "ListVersion",
    "MajesticProvider",
    "OpenPageRankProvider",
    "TrancoProvider",
    "entry_to_json",
    "parse_webgraph_line",
]
