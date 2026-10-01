import json

from traffic_estimator.collectors.commoncrawl import aggregate, summarize_cdx

RECORDS = [
    {"url": "https://example.com/", "timestamp": "20260905120000", "status": "200", "mime-detected": "text/html", "digest": "A"},
    {"url": "https://example.com/about", "timestamp": "20260906120000", "status": "200", "mime-detected": "text/html", "digest": "B"},
    {"url": "https://example.com/about?x=1", "timestamp": "20260907120000", "status": "200", "mime-detected": "text/html", "digest": "B"},
    {"url": "https://blog.example.com/post", "timestamp": "20260901000000", "status": "200", "mime-detected": "text/html", "digest": "C"},
    {"url": "https://example.com/img.png", "timestamp": "20260910000000", "status": "404", "mime-detected": "image/png", "digest": "D"},
]


def test_summarize_cdx_counts():
    body = "\n".join(json.dumps(r) for r in RECORDS).encode() + b"\n"
    s = summarize_cdx(body)
    assert s["url_count"] == 5
    assert s["unique_paths"] == 4  # /about and /about?x=1 share a path
    assert s["unique_digests"] == 4
    assert s["subdomains"] == 2
    assert s["first_timestamp"] == "20260901000000" and s["last_timestamp"] == "20260910000000"
    assert s["status_counts"] == {"200": 4, "404": 1}
    assert s["mime_counts"]["text/html"] == 4


def test_summarize_cdx_truncated_drops_partial_last_line():
    body = "\n".join(json.dumps(r) for r in RECORDS[:2]).encode() + b'\n{"url": "https://example.com/par'
    s = summarize_cdx(body, truncated=True)
    assert s["url_count"] == 2


def test_aggregate_across_crawls():
    body = "\n".join(json.dumps(r) for r in RECORDS).encode()
    a = summarize_cdx(body)
    b = {"url_count": 0, "status": "no_captures"}
    out = aggregate("example.com", {"CC-MAIN-2026-39": a, "CC-MAIN-2026-34": b})
    assert out["url_count"] == 5 and out["crawl_count"] == 1 and out["crawls_queried"] == 2
    assert out["first_seen"] == "20260901000000" and out["last_seen"] == "20260910000000"
    assert out["html_share"] == 0.8 and out["status_200_share"] == 0.8
    assert out["unique_subdomains_max_crawl"] == 2
