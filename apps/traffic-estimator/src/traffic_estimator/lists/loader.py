"""Download, load and look up ranked lists.

Loading streams the file from disk through the provider's parser into Postgres with COPY (a sync
psycopg connection in a worker thread). Lookups are a single indexed query per domain. For the
Common Crawl web graph only the top N rows are loaded; `scan_file` finds other domains in the kept
file in one streaming pass for a whole batch of pending domains.
"""

from __future__ import annotations

import asyncio
import gzip
import logging
import os
import time
import zipfile
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import IO, Any

import httpx
import psycopg
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from ..http import get_client, get_limiter
from ..settings import get_settings
from .providers import (
    CommonCrawlWebGraphProvider,
    CruxTopProvider,
    Entry,
    ListProvider,
    ListVersion,
    MajesticProvider,
    OpenPageRankProvider,
    TrancoProvider,
    parse_webgraph_line,
)

log = logging.getLogger(__name__)

COPY_COLUMNS = (
    "list_id",
    "domain",
    "rank",
    "score",
    "pr_rank",
    "pr_score",
    "n_hosts",
    "ref_domains",
    "ref_subnets",
    "ref_ips",
)


def build_providers() -> dict[str, ListProvider]:
    s = get_settings()
    all_providers: dict[str, ListProvider] = {
        "tranco": TrancoProvider(base_url=s.tranco_base_url, scope=s.tranco_scope),
        "majestic": MajesticProvider(url=s.majestic_url),
        "openpagerank": OpenPageRankProvider(url=s.openpagerank_url),
        "crux_top": CruxTopProvider(url=s.crux_top_url),
        "cc_webgraph": CommonCrawlWebGraphProvider(top_n=s.cc_webgraph_top_n),
    }
    for name, hours in s.list_refresh_hours.items():
        if name in all_providers:
            all_providers[name].refresh_hours = hours
    return {name: p for name, p in all_providers.items() if name in s.list_providers}


def _psycopg_dsn() -> str:
    url = get_settings().database_url
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


@contextmanager
def open_list_file(path: Path) -> Iterator[IO[bytes]]:
    name = path.name.lower()
    if name.endswith(".zip"):
        with zipfile.ZipFile(path) as zf:
            members = [m for m in zf.infolist() if not m.is_dir()]
            if not members:
                raise RuntimeError(f"{path}: empty zip")
            with zf.open(members[0]) as f:
                yield f
    elif name.endswith(".gz"):
        with gzip.open(path, "rb") as f:
            yield f  # type: ignore[misc]
    else:
        with path.open("rb") as f:
            yield f


def _file_name(provider: ListProvider, version: ListVersion) -> str:
    tail = version.url.rsplit("/", 1)[-1].split("?")[0]
    ext = ""
    for cand in (".csv.gz", ".txt.gz", ".csv.zip", ".zip", ".gz", ".csv", ".txt"):
        if tail.endswith(cand):
            ext = cand
            break
    safe_id = "".join(c if c.isalnum() or c in "-_." else "_" for c in version.list_id)
    return f"{provider.name}-{safe_id}{ext or '.csv'}"


async def download(url: str, dest: Path, *, limiter_key: str = "lists") -> int:
    """Stream a (possibly multi-GB) file to disk. Returns the byte count."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    client = get_client()
    await get_limiter().acquire(limiter_key)
    size = 0
    async with client.stream("GET", url, follow_redirects=True, timeout=httpx_timeout()) as resp:
        if resp.status_code != 200:
            raise RuntimeError(f"download {url}: HTTP {resp.status_code}")
        with tmp.open("wb") as f:
            async for chunk in resp.aiter_bytes(1 << 20):
                f.write(chunk)
                size += len(chunk)
    os.replace(tmp, dest)
    return size


def httpx_timeout() -> httpx.Timeout:
    return httpx.Timeout(60.0, connect=15.0, read=120.0)


# ------------------------------------------------------------------------------------ loading
def _copy_rows(rows: Iterable[Entry], list_pk: int, cur: psycopg.Cursor, top_n: int | None) -> int:
    n = 0
    with cur.copy(f"COPY ranked_list_entries_stage ({', '.join(COPY_COLUMNS)}) FROM STDIN") as copy:
        for e in rows:
            copy.write_row((list_pk, e.domain, e.rank, e.score, e.pr_rank, e.pr_score, e.n_hosts, e.ref_domains, e.ref_subnets, e.ref_ips))
            n += 1
            if top_n and n >= top_n:
                break
    return n


def load_file_sync(provider: ListProvider, version: ListVersion, path: Path, keep_lists: int) -> dict[str, Any]:
    """Insert the list version, COPY its entries, activate it, prune old versions. Blocking."""
    started = time.monotonic()
    with psycopg.connect(_psycopg_dsn(), autocommit=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ranked_lists (provider, list_id, list_date, source_url, file_path)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (provider, list_id) DO UPDATE SET source_url = EXCLUDED.source_url, file_path = EXCLUDED.file_path
                RETURNING id
                """,
                (provider.name, version.list_id, version.list_date, version.url, str(path) if provider.keep_file else None),
            )
            list_pk = cur.fetchone()[0]  # type: ignore[index]
            cur.execute("DELETE FROM ranked_list_entries WHERE list_id = %s", (list_pk,))
            cur.execute("CREATE TEMP TABLE ranked_list_entries_stage (LIKE ranked_list_entries) ON COMMIT DROP")
            with open_list_file(path) as stream:
                n = _copy_rows(provider.parse(stream), list_pk, cur, provider.top_n)
            cur.execute(
                """
                INSERT INTO ranked_list_entries
                SELECT DISTINCT ON (list_id, domain) * FROM ranked_list_entries_stage ORDER BY list_id, domain, rank
                """
            )
            cur.execute("UPDATE ranked_lists SET active = false WHERE provider = %s AND active", (provider.name,))
            cur.execute("UPDATE ranked_lists SET active = true, row_count = %s WHERE id = %s", (n, list_pk))
            # Prune older versions (and their files).
            cur.execute(
                """
                SELECT id, file_path FROM ranked_lists WHERE provider = %s AND NOT active
                ORDER BY downloaded_at DESC OFFSET %s
                """,
                (provider.name, max(keep_lists - 1, 0)),
            )
            old = cur.fetchall()
            for old_id, file_path in old:
                cur.execute("DELETE FROM ranked_lists WHERE id = %s", (old_id,))
                if file_path:
                    Path(file_path).unlink(missing_ok=True)
        conn.commit()
    if not provider.keep_file:
        path.unlink(missing_ok=True)
    return {"list_pk": list_pk, "rows": n, "pruned": len(old), "seconds": round(time.monotonic() - started, 1)}


async def refresh_provider(provider: ListProvider, *, force: bool = False) -> dict[str, Any]:
    """Resolve the latest version; download + load it unless already active. Returns a summary."""
    s = get_settings()
    version = await provider.resolve()
    from ..db import connection

    async with connection() as conn:
        row = (
            await conn.execute(
                text("SELECT id, active, row_count, source_url FROM ranked_lists WHERE provider = :p AND list_id = :l"),
                {"p": provider.name, "l": version.list_id},
            )
        ).first()
    # A different URL for the same list id (e.g. Tranco scope 1000000 -> full) means different content.
    if row and row[1] and row[2] and row[3] == version.url and not force:
        return {"provider": provider.name, "list_id": version.list_id, "status": "up_to_date", "rows": row[2]}
    dest = s.data_dir / "lists" / _file_name(provider, version)
    if not dest.exists() or force:
        log.info("downloading %s list %s from %s", provider.name, version.list_id, version.url)
        size = await download(version.url, dest)
        log.info("downloaded %s (%d bytes)", dest, size)
    summary = await asyncio.to_thread(load_file_sync, provider, version, dest, s.list_keep_versions)
    log.info("loaded %s %s: %s", provider.name, version.list_id, summary)
    return {"provider": provider.name, "list_id": version.list_id, "status": "loaded", **summary}


# ------------------------------------------------------------------------------------ lookup
@dataclass
class ListHit:
    provider: str
    list_id: str
    list_date: date | None
    status: str  # present | absent | unknown | no_list
    entry: dict[str, Any] | None = None


async def lookup(conn: AsyncConnection, domain: str, providers: dict[str, ListProvider]) -> dict[str, ListHit]:
    rows = await conn.execute(
        text(
            """
            SELECT l.provider, l.list_id, l.list_date, (e.domain IS NOT NULL) AS has_row,
                   e.rank, e.score, e.pr_rank, e.pr_score, e.n_hosts, e.ref_domains, e.ref_subnets, e.ref_ips
            FROM ranked_lists l
            LEFT JOIN ranked_list_entries e ON e.list_id = l.id AND e.domain = :d
            WHERE l.active AND l.provider = ANY(:providers)
            """
        ),
        {"d": domain, "providers": list(providers)},
    )
    out: dict[str, ListHit] = {}
    for r in rows:
        provider, list_id, list_date, has_row = r[0], r[1], r[2], r[3]
        if has_row and r[4] is not None:
            keys = ("rank", "score", "pr_rank", "pr_score", "n_hosts", "ref_domains", "ref_subnets", "ref_ips")
            entry = {k: v for k, v in zip(keys, r[4:], strict=True) if v is not None}
            out[provider] = ListHit(provider, list_id, list_date, "present", entry)
        elif has_row:
            out[provider] = ListHit(provider, list_id, list_date, "absent")
        else:
            status = "absent" if providers[provider].complete else "unknown"
            out[provider] = ListHit(provider, list_id, list_date, status)
    for name in providers:
        out.setdefault(name, ListHit(name, "", None, "no_list"))
    return out


# ------------------------------------------------------------------------------------ web graph scan
def scan_file(path: Path, wanted: set[str]) -> dict[str, Entry]:
    """One streaming pass over the kept web-graph ranks file, picking out `wanted` domains."""
    found: dict[str, Entry] = {}
    remaining = set(wanted)
    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as f:
        for line in f:
            if not remaining:
                break
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 5:
                continue
            rev = parts[4]
            dom = ".".join(reversed(rev.split(".")))
            if dom in remaining:
                e = parse_webgraph_line(line)
                if e:
                    found[dom] = e
                    remaining.discard(dom)
    return found


async def scan_pending(provider_name: str = "cc_webgraph", batch_limit: int = 2_000_000) -> dict[str, Any]:
    """Resolve every known domain without an entry in the active list by scanning the file once.
    Domains that are not in the file get a NULL-rank row (negative cache)."""
    from ..db import connection

    async with connection() as conn:
        lst = (
            await conn.execute(text("SELECT id, file_path FROM ranked_lists WHERE provider = :p AND active"), {"p": provider_name})
        ).first()
        if not lst or not lst[1]:
            return {"status": "no_list"}
        list_pk, file_path = int(lst[0]), Path(lst[1])
        rows = await conn.execute(
            text(
                """
                SELECT d.name FROM domains d
                WHERE NOT EXISTS (SELECT 1 FROM ranked_list_entries e WHERE e.list_id = :l AND e.domain = d.name)
                LIMIT :lim
                """
            ),
            {"l": list_pk, "lim": batch_limit},
        )
        wanted = {r[0] for r in rows}
    if not wanted:
        return {"status": "nothing_pending"}
    if not file_path.exists():
        return {"status": "file_missing", "file": str(file_path)}
    started = time.monotonic()
    found = await asyncio.to_thread(scan_file, file_path, wanted)
    async with connection() as conn:
        for dom in wanted:
            e = found.get(dom)
            await conn.execute(
                text(
                    """
                    INSERT INTO ranked_list_entries (list_id, domain, rank, score, pr_rank, pr_score, n_hosts)
                    VALUES (:l, :d, :rank, :score, :pr_rank, :pr_score, :n_hosts)
                    ON CONFLICT (list_id, domain) DO NOTHING
                    """
                ),
                {
                    "l": list_pk,
                    "d": dom,
                    "rank": e.rank if e else None,
                    "score": e.score if e else None,
                    "pr_rank": e.pr_rank if e else None,
                    "pr_score": e.pr_score if e else None,
                    "n_hosts": e.n_hosts if e else None,
                },
            )
    return {
        "status": "scanned",
        "wanted": len(wanted),
        "found": len(found),
        "seconds": round(time.monotonic() - started, 1),
    }
