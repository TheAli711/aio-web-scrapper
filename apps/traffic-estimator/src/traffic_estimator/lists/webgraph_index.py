"""On-disk index of the Common Crawl domain web-graph ranks.

The ranks file lists ~133M domains (2.5 GB gzip, 9 GB text) sorted by harmonic-centrality rank, so
finding one domain means reading the whole file. The index is built once per graph release
(quarterly) and answers a lookup with a few reads of a memory-mapped file, so any domain resolves
as soon as it is asked for.

Layout (big-endian):

    header   32 bytes: magic, record count (u64), fan-out bits (u32), zero padding
    fan-out  (2^bits + 1) x u32: index of the first record whose key starts with each bits-long prefix
    records  count x 20 bytes sorted by key: key (8 bytes), harmonic-centrality rank, PageRank rank,
             n_hosts (u32 each)

key = blake2b-64 of the reversed domain as written in the file (com.example). Over 133M domains a
64-bit key gives an expected 5e-4 colliding pairs and a ~1e-11 chance that an absent domain
matches. The float centrality values are not kept: ranks carry the same ordering.

Building streams the gzip once, appends each record to one of 256 partition files by the key's
first byte, then sorts the partitions one at a time into the output (memory: one partition,
~40 MB). It runs in its own process (`python -m traffic_estimator.lists.webgraph_index build
SRC DEST`) so the worker's event loop keeps its GIL.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import mmap
import os
import shutil
import struct
import sys
import tempfile
import time
from bisect import bisect_left
from dataclasses import dataclass
from pathlib import Path

from ..domains import reverse_domain

MAGIC = b"TEWGI001"
HEADER = struct.Struct(">8sQI12x")
RECORD = struct.Struct(">8sIII")
VALUES = struct.Struct(">III")
FANOUT_BITS = 20
PARTITION_BITS = 8
U32_MAX = 2**32 - 1
STALE_WORK_DIR_S = 3600  # a build's temp dir untouched this long belongs to a killed build


@dataclass(frozen=True)
class WebGraphRanks:
    rank: int  # harmonic-centrality position (1 = most central)
    pr_rank: int
    n_hosts: int


def key_for(domain: str) -> bytes:
    return _key(reverse_domain(domain.lower()).encode())


def _key(rev: bytes) -> bytes:
    return hashlib.blake2b(rev, digest_size=8).digest()


# ------------------------------------------------------------------------------------ build
def build_index(src: Path, dest: Path, *, fanout_bits: int = FANOUT_BITS) -> dict:
    """Build `dest` from the gzip ranks file `src`. The file appears atomically when complete."""
    if not PARTITION_BITS <= fanout_bits <= 24:
        raise ValueError(f"fanout_bits must be within {PARTITION_BITS}..24")
    started = time.monotonic()
    dest.parent.mkdir(parents=True, exist_ok=True)
    _remove_stale_work_dirs(dest)
    _allow_open_files((1 << PARTITION_BITS) + 64)
    work = Path(tempfile.mkdtemp(prefix=f".{dest.name}.", dir=dest.parent))
    try:
        records, skipped = _partition(src, work)
        tmp = work / "index"
        _write_sorted(work, tmp, records, fanout_bits)
        os.replace(tmp, dest)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return {
        "records": records,
        "skipped": skipped,
        "bytes": dest.stat().st_size,
        "seconds": round(time.monotonic() - started, 1),
    }


def _remove_stale_work_dirs(dest: Path) -> None:
    for d in dest.parent.glob(f".{dest.name}.*"):
        try:
            if d.is_dir() and time.time() - d.stat().st_mtime > STALE_WORK_DIR_S:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


def _allow_open_files(n: int) -> None:
    """The partition pass keeps 256 files open; raise a low soft limit (macOS shells default to 256)."""
    try:
        import resource

        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        if soft != resource.RLIM_INFINITY and soft < n:
            resource.setrlimit(resource.RLIMIT_NOFILE, (n if hard == resource.RLIM_INFINITY else min(n, hard), hard))
    except (ImportError, ValueError, OSError):
        pass


def _partition(src: Path, work: Path) -> tuple[int, int]:
    files = [(work / f"p{i:03d}").open("wb", buffering=1 << 18) for i in range(1 << PARTITION_BITS)]
    writes = [f.write for f in files]
    blake2b, pack = hashlib.blake2b, VALUES.pack
    records = skipped = 0
    try:
        with gzip.open(src, "rb") as f:
            for line in f:
                # harmonicc_pos  harmonicc_val  pr_pos  pr_val  host_rev  n_hosts
                cols = line.split(b"\t")
                if len(cols) < 5 or line[:1] == b"#":
                    skipped += 1
                    continue
                try:
                    values = pack(int(cols[0]), int(cols[2]), min(int(cols[5]), U32_MAX) if len(cols) > 5 else 0)
                except (ValueError, struct.error):
                    skipped += 1
                    continue
                key = blake2b(cols[4].strip().lower(), digest_size=8).digest()
                writes[key[0]](key + values)
                records += 1
    finally:
        for f in files:
            f.close()
    return records, skipped


def _write_sorted(work: Path, out_path: Path, records: int, fanout_bits: int) -> None:
    size = RECORD.size
    sub_bits = fanout_bits - PARTITION_BITS
    fanout = [0] * ((1 << fanout_bits) + 1)
    written = 0
    with out_path.open("wb") as out:
        out.write(HEADER.pack(MAGIC, records, fanout_bits))
        out.write(bytes(4 * len(fanout)))  # filled in below
        for part in range(1 << PARTITION_BITS):
            p = work / f"p{part:03d}"
            buf = p.read_bytes()
            p.unlink()
            recs = [buf[i : i + size] for i in range(0, len(buf), size)]
            recs.sort()
            for s in range(1 << sub_bits):
                prefix = (part << sub_bits) | s
                fanout[prefix] = written + bisect_left(recs, (prefix << (64 - fanout_bits)).to_bytes(8, "big"))
            out.write(b"".join(recs))
            written += len(recs)
        fanout[-1] = written
        out.seek(HEADER.size)
        out.write(struct.pack(f">{len(fanout)}I", *fanout))
    if written != records:
        raise RuntimeError(f"index build: wrote {written} records, expected {records}")


# ------------------------------------------------------------------------------------ lookup
class WebGraphIndex:
    def __init__(self, path: Path) -> None:
        self.path = path
        with path.open("rb") as f:
            self._mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        if len(self._mm) < HEADER.size:
            raise ValueError(f"{path}: not a web graph index")
        magic, self.count, self.fanout_bits = HEADER.unpack_from(self._mm, 0)
        self._records_at = HEADER.size + 4 * ((1 << self.fanout_bits) + 1)
        if magic != MAGIC or len(self._mm) != self._records_at + self.count * RECORD.size:
            raise ValueError(f"{path}: not a web graph index (or truncated)")

    def get(self, domain: str) -> WebGraphRanks | None:
        key = key_for(domain)
        mm, base, size = self._mm, self._records_at, RECORD.size
        prefix = int.from_bytes(key, "big") >> (64 - self.fanout_bits)
        lo, hi = struct.unpack_from(">II", mm, HEADER.size + 4 * prefix)
        while lo < hi:
            mid = (lo + hi) // 2
            off = base + mid * size
            if mm[off : off + 8] < key:
                lo = mid + 1
            else:
                hi = mid
        off = base + lo * size
        if lo < self.count and mm[off : off + 8] == key:
            _, rank, pr_rank, n_hosts = RECORD.unpack_from(mm, off)
            return WebGraphRanks(rank, pr_rank, n_hosts)
        return None

    def close(self) -> None:
        self._mm.close()


def is_valid(path: Path) -> bool:
    try:
        WebGraphIndex(path).close()
        return True
    except (OSError, ValueError):
        return False


_open: dict[Path, tuple[tuple[int, int], WebGraphIndex]] = {}


def open_index(path: Path) -> WebGraphIndex | None:
    """Process-wide cached index; reopened when the file at `path` is replaced. None if missing or invalid.
    Opening a new file unmaps indexes whose files were replaced or deleted (pruned versions), so
    their disk space is released without a restart."""
    try:
        st = path.stat()
    except OSError:
        _evict(path)
        return None
    ident = (st.st_ino, st.st_size)
    cached = _open.get(path)
    if cached and cached[0] == ident:
        return cached[1]
    try:
        index = WebGraphIndex(path)
    except (OSError, ValueError):
        _evict(path)
        return None
    _evict(path)
    for other in [p for p in _open if not p.exists()]:
        _evict(other)
    _open[path] = (ident, index)
    return index


def _evict(path: Path) -> None:
    cached = _open.pop(path, None)
    if cached:
        cached[1].close()


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[0] != "build":
        print("usage: python -m traffic_estimator.lists.webgraph_index build SRC.txt.gz DEST.idx", file=sys.stderr)
        return 2
    print(json.dumps(build_index(Path(argv[1]), Path(argv[2]))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
