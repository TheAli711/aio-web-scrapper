"""Download, load and look up ranked lists.

Loading streams the file from disk through the provider's parser into Postgres with COPY (a sync
psycopg connection in a worker thread). Lookups are a single indexed query per domain. The Common
Crawl web graph (133M domains) is too large for Postgres; it is turned into an on-disk index
(`webgraph_index.py`, built in a subprocess) and looked up there.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import os
import subprocess
import sys
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
)
from .webgraph_index import WebGraphIndex, is_valid, open_index

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
        "cc_webgraph": CommonCrawlWebGraphProvider(),
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
    return f"{_stem(provider, version)}{ext or '.csv'}"


def _stem(provider: ListProvider, version: ListVersion) -> str:
    safe_id = "".join(c if c.isalnum() or c in "-_." else "_" for c in version.list_id)
    return f"{provider.name}-{safe_id}"


def index_path(provider: ListProvider, version: ListVersion) -> Path:
    return get_settings().data_dir / "lists" / f"{_stem(provider, version)}.idx"


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
def _copy_rows(rows: Iterable[Entry], list_pk: int, cur: psycopg.Cursor) -> int:
    n = 0
    with cur.copy(f"COPY ranked_list_entries_stage ({', '.join(COPY_COLUMNS)}) FROM STDIN") as copy:
        for e in rows:
            copy.write_row((list_pk, e.domain, e.rank, e.score, e.pr_rank, e.pr_score, e.n_hosts, e.ref_domains, e.ref_subnets, e.ref_ips))
            n += 1
    return n


def build_index_sync(src: Path, dest: Path, *, reuse: bool = True) -> dict[str, Any]:
    """Build the web graph index in a child process (CPU-bound for minutes; keeps the caller's GIL free).
    A valid index already at `dest` is reused unless `reuse` is False (it is replaced atomically)."""
    if reuse and is_valid(dest):
        index = WebGraphIndex(dest)
        try:
            return {"records": index.count, "reused": True}
        finally:
            index.close()
    proc = subprocess.run(
        [sys.executable, "-m", "traffic_estimator.lists.webgraph_index", "build", str(src), str(dest)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"index build failed ({proc.returncode}): {proc.stderr.strip()[-2000:]}")
    return json.loads(proc.stdout.strip().splitlines()[-1])


def load_file_sync(provider: ListProvider, version: ListVersion, path: Path, keep_lists: int, *, rebuild: bool = False) -> dict[str, Any]:
    """Insert the list version, load its entries (COPY, or build the on-disk index), activate it,
    prune old versions. Blocking."""
    started = time.monotonic()
    index: Path | None = None
    if provider.indexed:
        index = path.with_name(index_path(provider, version).name)
        n = build_index_sync(path, index, reuse=not rebuild)["records"]
    with psycopg.connect(_psycopg_dsn(), autocommit=False) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ranked_lists (provider, list_id, list_date, source_url, file_path)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (provider, list_id) DO UPDATE SET source_url = EXCLUDED.source_url, file_path = EXCLUDED.file_path
                RETURNING id
                """,
                (provider.name, version.list_id, version.list_date, version.url, str(index) if index else None),
            )
            list_pk = cur.fetchone()[0]  # type: ignore[index]
            cur.execute("DELETE FROM ranked_list_entries WHERE list_id = %s", (list_pk,))
            if not provider.indexed:
                cur.execute("CREATE TEMP TABLE ranked_list_entries_stage (LIKE ranked_list_entries) ON COMMIT DROP")
                with open_list_file(path) as stream:
                    n = _copy_rows(provider.parse(stream), list_pk, cur)
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
            if provider.indexed:
                # Lookups only use the active index; an older one is 2.7 GB of dead weight.
                cur.execute(
                    "SELECT id, file_path FROM ranked_lists WHERE provider = %s AND NOT active AND file_path IS NOT NULL", (provider.name,)
                )
                for old_id, file_path in cur.fetchall():
                    if file_path != str(index):
                        Path(file_path).unlink(missing_ok=True)
                    cur.execute("UPDATE ranked_lists SET file_path = NULL WHERE id = %s", (old_id,))
        conn.commit()
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
                text("SELECT id, active, row_count, source_url, file_path FROM ranked_lists WHERE provider = :p AND list_id = :l"),
                {"p": provider.name, "l": version.list_id},
            )
        ).first()
    # A different URL for the same list id (e.g. Tranco scope 1000000 -> full) means different content;
    # an indexed list also needs its index file (missing after a volume reset or a format change).
    current = row and row[1] and row[2] and row[3] == version.url
    if current and provider.indexed:
        current = bool(row[4]) and is_valid(Path(row[4]))
    if current and not force:
        return {"provider": provider.name, "list_id": version.list_id, "status": "up_to_date", "rows": row[2]}
    dest = s.data_dir / "lists" / _file_name(provider, version)
    # A forced refresh keeps serving the current index until the new one replaces it atomically.
    if (not dest.exists() and not (provider.indexed and is_valid(index_path(provider, version)))) or force:
        log.info("downloading %s list %s from %s", provider.name, version.list_id, version.url)
        size = await download(version.url, dest)
        log.info("downloaded %s (%d bytes)", dest, size)
    try:
        summary = await asyncio.to_thread(load_file_sync, provider, version, dest, s.list_keep_versions, rebuild=force)
    except Exception:
        # A truncated or corrupt download would otherwise be reused by every retry.
        dest.unlink(missing_ok=True)
        raise
    log.info("loaded %s %s: %s", provider.name, version.list_id, summary)
    return {"provider": provider.name, "list_id": version.list_id, "status": "loaded", **summary}


# ------------------------------------------------------------------------------------ lookup
@dataclass
class ListHit:
    provider: str
    list_id: str
    list_date: date | None
    status: str  # present | absent | no_list
    entry: dict[str, Any] | None = None
    list_size: int | None = None  # rows in the loaded list: "absent" means a rank beyond this


async def lookup(conn: AsyncConnection, domain: str, providers: dict[str, ListProvider]) -> dict[str, ListHit]:
    rows = await conn.execute(
        text(
            """
            SELECT l.provider, l.list_id, l.list_date, l.file_path, l.row_count,
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
        provider, list_id, list_date, file_path, size = r[0], r[1], r[2], r[3], r[4]
        if providers[provider].indexed:
            index = open_index(Path(file_path)) if file_path else None
            if index is None:
                continue  # index file missing: treated as not loaded (the collector asks for a refresh)
            ranks = index.get(domain)
            entry = {"rank": ranks.rank, "pr_rank": ranks.pr_rank, "n_hosts": ranks.n_hosts} if ranks else None
            out[provider] = ListHit(provider, list_id, list_date, "present" if entry else "absent", entry, size)
        elif r[5] is not None:
            keys = ("rank", "score", "pr_rank", "pr_score", "n_hosts", "ref_domains", "ref_subnets", "ref_ips")
            entry = {k: v for k, v in zip(keys, r[5:], strict=True) if v is not None}
            out[provider] = ListHit(provider, list_id, list_date, "present", entry, size)
        else:
            out[provider] = ListHit(provider, list_id, list_date, "absent", None, size)
    for name in providers:
        out.setdefault(name, ListHit(name, "", None, "no_list"))
    return out
