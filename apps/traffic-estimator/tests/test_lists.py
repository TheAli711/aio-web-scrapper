import gzip
import io
from datetime import date
from pathlib import Path

import pytest
from conftest import needs_db
from sqlalchemy import text

from traffic_estimator.db import connection
from traffic_estimator.lists import webgraph_index
from traffic_estimator.lists.loader import load_file_sync, lookup
from traffic_estimator.lists.providers import (
    CommonCrawlWebGraphProvider,
    CruxTopProvider,
    ListVersion,
    MajesticProvider,
    OpenPageRankProvider,
    TrancoProvider,
)
from traffic_estimator.lists.webgraph_index import WebGraphIndex, WebGraphRanks, build_index, is_valid, open_index

WEBGRAPH_HEADER = "#harmonicc_pos\t#harmonicc_val\t#pr_pos\t#pr_val\t#host_rev\t#n_hosts\n"


def test_tranco_parse():
    data = b"1,google.com\n2,Cloudflare.COM\n3,not a domain\n4,\n5,example.co.uk\n"
    rows = list(TrancoProvider().parse(io.BytesIO(data)))
    assert [(r.domain, r.rank) for r in rows] == [("google.com", 1), ("cloudflare.com", 2), ("example.co.uk", 5)]


def test_majestic_parse():
    data = (
        b"GlobalRank,TldRank,Domain,TLD,RefSubNets,RefIPs,IDN_Domain,IDN_TLD,PrevGlobalRank,PrevTldRank,PrevRefSubNets,PrevRefIPs\n"
        b"1,1,google.com,com,510309,2254091,google.com,com,1,1,509912,2252074\n"
        b"2,2,facebook.com,com,470496,2222117,facebook.com,com,2,2,470451,2222386\n"
    )
    rows = list(MajesticProvider().parse(io.BytesIO(data)))
    assert rows[0].domain == "google.com" and rows[0].rank == 1 and rows[0].ref_subnets == 510309 and rows[0].ref_ips == 2254091
    assert rows[1].domain == "facebook.com"


def test_openpagerank_parse():
    data = b"Rank,Domain,Extension,Open Page Rank,Referring Domains\n1,google.com,com,9.99,2494534\n2,googleapis.com,com,9.98,2190212\n"
    rows = list(OpenPageRankProvider().parse(io.BytesIO(data)))
    assert rows[0].domain == "google.com" and rows[0].score == 9.99 and rows[0].ref_domains == 2494534


def test_crux_parse_keeps_best_bucket_per_domain():
    data = b"origin,rank\nhttps://www.chess.com,1000\nhttps://sellercentral.amazon.com,1000\nhttps://amazon.com,5000\nhttp://blog.chess.com,50000\n"
    rows = {r.domain: r.rank for r in CruxTopProvider().parse(io.BytesIO(data))}
    assert rows == {"chess.com": 1000, "amazon.com": 1000}


def _write_ranks(path: Path, rows: list[str]) -> Path:
    with gzip.open(path, "wt") as f:
        f.write(WEBGRAPH_HEADER + "".join(rows))
    return path


def test_webgraph_index_build_and_get(tmp_path: Path):
    src = _write_ranks(
        tmp_path / "ranks.txt.gz",
        [
            "1\t2.9E7\t3\t0.009\tcom.facebook\t3054\n",
            "2\t2.8E7\t1\t0.014\tCOM.GoogleAPIs\t7730\n",  # keys are case-insensitive
            "500\t1.0E6\t400\t0.0001\tuk.co.example\n",  # no n_hosts column
            "garbage line\n",
            "x\t1\t2\t3\tcom.bad\t1\n",
        ],
    )
    dest = tmp_path / "ranks.idx"
    stats = build_index(src, dest)
    assert stats["records"] == 3 and stats["skipped"] == 3  # header + 2 malformed
    index = WebGraphIndex(dest)
    assert index.count == 3
    assert index.get("facebook.com") == WebGraphRanks(rank=1, pr_rank=3, n_hosts=3054)
    assert index.get("googleapis.com") == WebGraphRanks(rank=2, pr_rank=1, n_hosts=7730)
    assert index.get("Example.co.uk") == WebGraphRanks(rank=500, pr_rank=400, n_hosts=0)
    assert index.get("missing.org") is None and index.get("bad.com") is None
    index.close()


@pytest.mark.parametrize("fanout_bits", [8, 12, 20])
def test_webgraph_index_many_domains(tmp_path: Path, fanout_bits: int):
    # Enough rows that every fan-out slot holds many records and partitions are uneven.
    rows = [f"{i}\t1.0\t{i * 7 % 5003}\t0.1\tcom.site{i}\t{i % 9}\n" for i in range(1, 5001)]
    src = _write_ranks(tmp_path / "ranks.txt.gz", rows)
    dest = tmp_path / "ranks.idx"
    assert build_index(src, dest, fanout_bits=fanout_bits)["records"] == 5000
    index = WebGraphIndex(dest)
    for i in range(1, 5001):
        assert index.get(f"site{i}.com") == WebGraphRanks(i, i * 7 % 5003, i % 9)
    assert all(index.get(f"site{i}.com") is None for i in range(5001, 5500))
    assert index.get("site1.net") is None


def test_webgraph_index_validation_and_reopen(tmp_path: Path):
    dest = tmp_path / "ranks.idx"
    assert open_index(dest) is None and not is_valid(dest)
    build_index(_write_ranks(tmp_path / "a.txt.gz", ["7\t1.0\t8\t0.1\tcom.example\t2\n"]), dest)
    assert is_valid(dest)
    first = open_index(dest)
    assert first is not None and open_index(dest) is first and first.get("example.com").rank == 7
    # Rebuilt in place (atomic replace): the next lookup sees the new file.
    build_index(_write_ranks(tmp_path / "b.txt.gz", ["9\t1.0\t8\t0.1\tcom.example\t2\n"]), dest)
    second = open_index(dest)
    assert second is not first and second.get("example.com").rank == 9
    # Truncated or foreign files are rejected.
    (tmp_path / "bad.idx").write_bytes(dest.read_bytes()[:-1])
    assert not is_valid(tmp_path / "bad.idx")
    (tmp_path / "foreign.idx").write_bytes(b"x" * 100)
    assert not is_valid(tmp_path / "foreign.idx")


def test_webgraph_index_cache_drops_deleted_files(tmp_path: Path):
    a = build_index(_write_ranks(tmp_path / "a.txt.gz", ["1\t1.0\t1\t0.1\tcom.a\t1\n"]), tmp_path / "a.idx") and tmp_path / "a.idx"
    b = build_index(_write_ranks(tmp_path / "b.txt.gz", ["1\t1.0\t1\t0.1\tcom.b\t1\n"]), tmp_path / "b.idx") and tmp_path / "b.idx"
    assert open_index(a) is not None
    a.unlink()
    assert open_index(b) is not None and a not in webgraph_index._open  # a pruned file is unmapped
    b.unlink()
    assert open_index(b) is None and b not in webgraph_index._open


def test_webgraph_index_build_guards(tmp_path: Path):
    import os
    import resource
    import time

    src = _write_ranks(tmp_path / "r.txt.gz", ["1\t1.0\t1\t0.1\tcom.a\t1\n"])
    with pytest.raises(ValueError):
        build_index(src, tmp_path / "r.idx", fanout_bits=4)
    # Temp dirs of killed builds are removed; a fresh one (a concurrent build) is left alone.
    stale, fresh = tmp_path / ".r.idx.dead", tmp_path / ".r.idx.live"
    stale.mkdir(), fresh.mkdir()
    os.utime(stale, (time.time() - 7200, time.time() - 7200))
    # The 256 partition files are opened even under a low soft limit on open files.
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    resource.setrlimit(resource.RLIMIT_NOFILE, (min(128, soft), hard))
    try:
        assert build_index(src, tmp_path / "r.idx")["records"] == 1
    finally:
        resource.setrlimit(resource.RLIMIT_NOFILE, (soft, hard))
    assert not stale.exists() and fresh.exists()


def test_webgraph_index_cli(tmp_path: Path, capsys):
    src = _write_ranks(tmp_path / "ranks.txt.gz", ["1\t2.9E7\t3\t0.009\tcom.facebook\t3054\n"])
    assert webgraph_index.main(["build", str(src), str(tmp_path / "out.idx")]) == 0
    assert '"records": 1' in capsys.readouterr().out
    assert webgraph_index.main(["nope"]) == 2


@needs_db
async def test_load_and_lookup(clean_db, tmp_path: Path):
    p = tmp_path / "tranco-TEST.csv"
    p.write_text("1,google.com\n2,example.com\n2,example.com\n3,other.net\n")
    provider = TrancoProvider()
    version = ListVersion(list_id="TEST", list_date=date(2026, 9, 30), url="https://tranco-list.eu/download/TEST/full")
    summary = load_file_sync(provider, version, p, keep_lists=2)
    assert summary["rows"] == 4  # staged rows (duplicate collapsed on insert)
    async with connection() as conn:
        n = (await conn.execute(text("SELECT count(*) FROM ranked_list_entries"))).scalar_one()
        assert n == 3
        hits = await lookup(conn, "example.com", {"tranco": provider, "majestic": MajesticProvider()})
    assert hits["tranco"].status == "present" and hits["tranco"].entry == {"rank": 2}
    assert hits["majestic"].status == "no_list"
    async with connection() as conn:
        hits = await lookup(conn, "nothere.com", {"tranco": provider})
    assert hits["tranco"].status == "absent" and hits["tranco"].list_size == 4  # absent = rank beyond 4
    # Loading a second version activates it and prunes beyond keep_lists.
    p2 = tmp_path / "tranco-TEST2.csv"
    p2.write_text("1,example.com\n")
    load_file_sync(provider, ListVersion("TEST2", date(2026, 10, 1), "u"), p2, keep_lists=1)
    async with connection() as conn:
        rows = [tuple(r) for r in await conn.execute(text("SELECT list_id, active FROM ranked_lists ORDER BY id"))]
        assert rows == [("TEST2", True)]
        hits = await lookup(conn, "example.com", {"tranco": provider})
    assert hits["tranco"].entry == {"rank": 1}


@needs_db
async def test_indexed_provider_load_and_lookup(clean_db, tmp_path: Path):
    src = _write_ranks(
        tmp_path / "cc_webgraph-X.txt.gz",
        ["1\t2.9E7\t3\t0.009\tcom.facebook\t3054\n", "9\t1E5\t9\t0.0001\tcom.example\t1\n"],
    )
    provider = CommonCrawlWebGraphProvider()
    summary = load_file_sync(provider, ListVersion("X", None, "u"), src, keep_lists=2)
    index = tmp_path / "cc_webgraph-X.idx"
    assert summary["rows"] == 2 and is_valid(index) and not src.exists()  # the source is replaced by the index
    async with connection() as conn:
        row = (await conn.execute(text("SELECT file_path, row_count FROM ranked_lists WHERE provider = 'cc_webgraph'"))).one()
        assert tuple(row) == (str(index), 2)
        assert (await conn.execute(text("SELECT count(*) FROM ranked_list_entries"))).scalar_one() == 0
        hits = await lookup(conn, "example.com", {"cc_webgraph": provider})
        assert hits["cc_webgraph"].status == "present" and hits["cc_webgraph"].entry == {"rank": 9, "pr_rank": 9, "n_hosts": 1}
        hits = await lookup(conn, "nope.org", {"cc_webgraph": provider})
        assert hits["cc_webgraph"].status == "absent"
    # Reloading reuses a valid index; a forced rebuild replaces it with the new file's content.
    src2 = _write_ranks(tmp_path / "cc_webgraph-X.txt.gz", ["4\t1E5\t5\t0.0001\tcom.example\t1\n"])
    load_file_sync(provider, ListVersion("X", None, "u"), src2, keep_lists=2)
    async with connection() as conn:
        assert (await lookup(conn, "example.com", {"cc_webgraph": provider}))["cc_webgraph"].entry["rank"] == 9
    src2 = _write_ranks(tmp_path / "cc_webgraph-X.txt.gz", ["4\t1E5\t5\t0.0001\tcom.example\t1\n"])
    load_file_sync(provider, ListVersion("X", None, "u"), src2, keep_lists=2, rebuild=True)
    async with connection() as conn:
        assert (await lookup(conn, "example.com", {"cc_webgraph": provider}))["cc_webgraph"].entry["rank"] == 4
    # A new release becomes active; the previous index file is deleted (lookups never use it).
    src3 = _write_ranks(tmp_path / "cc_webgraph-Y.txt.gz", ["2\t1E5\t2\t0.0001\tcom.example\t1\n"])
    load_file_sync(provider, ListVersion("Y", None, "u"), src3, keep_lists=2)
    async with connection() as conn:
        rows = [tuple(r) for r in await conn.execute(text("SELECT list_id, active, file_path FROM ranked_lists ORDER BY id"))]
        assert rows == [("X", False, None), ("Y", True, str(tmp_path / "cc_webgraph-Y.idx"))]
        assert (await lookup(conn, "example.com", {"cc_webgraph": provider}))["cc_webgraph"].entry["rank"] == 2
    assert not index.exists()
    index = tmp_path / "cc_webgraph-Y.idx"
    # A missing index file reads as "not loaded", so the collector asks for a refresh.
    index.unlink()
    async with connection() as conn:
        hits = await lookup(conn, "example.com", {"cc_webgraph": provider})
    assert hits["cc_webgraph"].status == "no_list"


if __name__ == "__main__":
    pytest.main([__file__])
