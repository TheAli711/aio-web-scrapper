import gzip
import io
from datetime import date
from pathlib import Path

import pytest
from conftest import needs_db
from sqlalchemy import text

from traffic_estimator.db import connection
from traffic_estimator.lists.loader import load_file_sync, lookup, scan_file
from traffic_estimator.lists.providers import (
    CommonCrawlWebGraphProvider,
    CruxTopProvider,
    ListVersion,
    MajesticProvider,
    OpenPageRankProvider,
    TrancoProvider,
    parse_webgraph_line,
)


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


def test_webgraph_parse_line_and_top_n():
    header = "#harmonicc_pos\t#harmonicc_val\t#pr_pos\t#pr_val\t#host_rev\t#n_hosts\n"
    assert parse_webgraph_line(header) is None
    e = parse_webgraph_line("1\t2.9133256E7\t3\t0.009049692172681117\tcom.facebook\t3054\n")
    assert e and e.domain == "facebook.com" and e.rank == 1 and e.pr_rank == 3 and e.n_hosts == 3054 and e.score == 2.9133256e7
    data = (
        header + "1\t2.9E7\t3\t0.009\tcom.facebook\t3054\n2\t2.8E7\t1\t0.014\tcom.googleapis\t7730\n3\t2.7E7\t2\t0.012\tcom.google\t18924\n"
    ).encode()
    rows = list(CommonCrawlWebGraphProvider(top_n=2).parse(io.BytesIO(data)))
    assert len(rows) == 3  # top_n is applied by the loader, parse yields everything


def test_scan_file(tmp_path: Path):
    content = "#h\n1\t2.9E7\t3\t0.009\tcom.facebook\t3054\n500\t1.0E6\t400\t0.0001\tcom.example\t2\n"
    p = tmp_path / "ranks.txt.gz"
    with gzip.open(p, "wt") as f:
        f.write(content)
    found = scan_file(p, {"example.com", "missing.org"})
    assert set(found) == {"example.com"} and found["example.com"].rank == 500


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
    assert hits["tranco"].status == "absent"
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
async def test_incomplete_provider_unknown_vs_scanned_absent(clean_db, tmp_path: Path):
    header = "#harmonicc_pos\t#harmonicc_val\t#pr_pos\t#pr_val\t#host_rev\t#n_hosts\n"
    p = tmp_path / "ccg-X.txt.gz"
    with gzip.open(p, "wt") as f:
        f.write(
            header + "1\t2.9E7\t3\t0.009\tcom.facebook\t3054\n2\t2.8E7\t1\t0.014\tcom.googleapis\t7730\n9\t1E5\t9\t0.0001\tcom.example\t1\n"
        )
    provider = CommonCrawlWebGraphProvider(top_n=2)
    load_file_sync(provider, ListVersion("X", None, "u"), p, keep_lists=2)
    async with connection() as conn:
        hits = await lookup(conn, "example.com", {"cc_webgraph": provider})
        assert hits["cc_webgraph"].status == "unknown"
        await conn.execute(text("INSERT INTO domains (name) VALUES ('example.com'), ('nope.org')"))
    from traffic_estimator.lists.loader import scan_pending

    out = await scan_pending("cc_webgraph")
    assert out["status"] == "scanned" and out["wanted"] == 2 and out["found"] == 1
    async with connection() as conn:
        hits = await lookup(conn, "example.com", {"cc_webgraph": provider})
        assert hits["cc_webgraph"].status == "present" and hits["cc_webgraph"].entry["rank"] == 9
        hits = await lookup(conn, "nope.org", {"cc_webgraph": provider})
        assert hits["cc_webgraph"].status == "absent"


if __name__ == "__main__":
    pytest.main([__file__])
