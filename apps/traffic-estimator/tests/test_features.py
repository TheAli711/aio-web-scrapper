from datetime import UTC, datetime

from traffic_estimator.estimator.buckets import bucket_for, load_buckets
from traffic_estimator.estimator.confidence import compute_confidence
from traffic_estimator.estimator.heuristic import HeuristicEstimator, interpolate
from traffic_estimator.features.extract import RawObs, extract_features
from traffic_estimator.features.normalize import NORMALIZED_KEYS, normalize
from traffic_estimator.features.schema import FeatureVector, SourceInfo

NOW = datetime(2026, 10, 1, tzinfo=UTC)


def obs(source: str, payload: dict, version: str = "v") -> RawObs:
    return RawObs(source, payload, NOW, version)


def big_site_observations() -> dict[str, RawObs]:
    return {
        "tranco": obs("tranco", {"status": "present", "rank": 1200, "list_id": "Q2K34", "list_date": "2026-09-30"}),
        "majestic": obs("majestic", {"status": "present", "rank": 900, "ref_subnets": 40000, "ref_ips": 200000}),
        "openpagerank": obs("openpagerank", {"status": "present", "rank": 1500, "score": 7.9, "ref_domains": 120000}),
        "crux_top": obs("crux_top", {"status": "present", "rank": 5000}),
        "cc_webgraph": obs(
            "cc_webgraph", {"status": "present", "rank": 2000, "score": 1.1e7, "pr_rank": 1800, "pr_score": 0.0001, "n_hosts": 40}
        ),
        "commoncrawl": obs(
            "commoncrawl",
            {
                "url_count": 12000,
                "unique_paths_max_crawl": 9000,
                "unique_subdomains_max_crawl": 12,
                "crawl_count": 2,
                "crawls_queried": 2,
                "first_seen": "20260801000000",
                "last_seen": "20260917000000",
                "html_share": 0.9,
                "limit_hit": False,
            },
        ),
        "crawl": obs(
            "crawl",
            {
                "reachable": True,
                "blocked": False,
                "requests": 20,
                "homepage": {"status": 200, "redirected_to_other_domain": False, "page": {"schema_types": ["Organization"]}},
                "signals": {
                    "parked": False,
                    "has_rss": True,
                    "has_search": True,
                    "og_present": True,
                    "jsonld_present": True,
                    "homepage_word_count": 800,
                    "homepage_internal_links": 120,
                    "homepage_external_links": 10,
                    "title": "Big",
                    "html_lang": "en",
                },
                "sitemaps": {
                    "fetched": 5,
                    "url_count": 20000,
                    "url_count_estimated": 120000,
                    "kinds": {"product": 15000, "article": 3000, "category": 500},
                    "lastmod_buckets": {"30d": 5000, "90d": 4000, "365d": 6000, "older": 5000},
                    "lastmod_max": "2026-09-30",
                    "truncated": True,
                },
                "structure": {
                    "page_count_from_sitemap": 120000,
                    "product_count": 90000,
                    "article_count": 18000,
                    "category_count": 3000,
                    "language_count": 4,
                    "subdomain_count": 3,
                },
                "pages": {
                    "fetched": 15,
                    "ok": 14,
                    "avg_word_count": 600,
                    "avg_internal_links": 80,
                    "schema_types": {"Product": 6, "BreadcrumbList": 10},
                },
                "tech": {
                    "technologies": [
                        {"name": "Shopify", "category": "ecommerce"},
                        {"name": "Google Analytics", "category": "analytics"},
                        {"name": "Meta Pixel", "category": "advertising"},
                    ],
                    "cms": None,
                    "ecommerce_platform": "Shopify",
                    "frameworks": ["React"],
                    "cdn": ["Cloudflare"],
                    "hosting": [],
                    "analytics": ["Google Analytics"],
                    "advertising": ["Meta Pixel"],
                    "marketing": ["Klaviyo"],
                    "payments": ["Shop Pay"],
                },
            },
        ),
        "dns": obs(
            "dns",
            {
                "records": {
                    "A": ["1.2.3.4", "1.2.3.5"],
                    "AAAA": [],
                    "NS": ["a.ns.cloudflare.com", "b.ns.cloudflare.com"],
                    "MX": ["aspmx.l.google.com"],
                    "TXT": ["v=spf1 include:_spf.google.com ~all"],
                },
                "resolves": True,
                "nxdomain": False,
                "has_mx": True,
                "has_spf": True,
                "verification_tags": ["google-site-verification", "facebook-domain-verification"],
                "infra": {
                    "cdn": ["Cloudflare"],
                    "hosting": [],
                    "dns_provider": ["Cloudflare"],
                    "email_provider": ["Google Workspace"],
                    "parked_provider": [],
                },
                "rdap": {
                    "status": "ok",
                    "registration_date": "2005-03-01T00:00:00Z",
                    "expiration_date": "2027-03-01T00:00:00Z",
                    "registrar": "GoDaddy",
                    "domain_age_days": 7800,
                },
            },
        ),
    }


def test_extract_and_normalize_big_site():
    fv = extract_features("big.example", big_site_observations())
    assert fv.tranco_rank == 1200 and fv.crux_rank_bucket == 5000 and fv.opr_ref_domains == 120000
    assert fv.ecommerce_platform == "Shopify" and fv.analytics_detected and fv.advertising_tags_detected
    assert fv.schema_product and fv.schema_organization and not fv.schema_article
    assert fv.page_count_from_sitemap == 120000 and fv.product_count == 90000
    assert fv.domain_age_days == 7800 and fv.registrar == "GoDaddy" and fv.dns_cdn == ["Cloudflare"]
    assert fv.sources["tranco"].status == "present" and fv.sources["crawl"].status == "present"
    norm = normalize(fv)
    assert set(norm) == set(NORMALIZED_KEYS)
    assert abs(norm["log_tranco_rank"] - 3.0792) < 1e-3
    assert norm["is_ecommerce"] == 1.0 and norm["analytics_detected"] == 1.0
    assert norm["sitemap_fresh_share"] == 0.25
    assert norm["log_domain_age_days"] is not None


def test_extract_missing_everything():
    fv = extract_features("empty.example", {}, failed_sources={"crawl": "timeout"})
    assert all(v.status in ("missing", "failed") for v in fv.sources.values())
    assert fv.sources["crawl"].status == "failed"
    norm = normalize(fv)
    assert norm["log_tranco_rank"] is None and norm["crawl_reachable"] is None


def test_extract_absent_list_and_unreachable_crawl():
    observations = {
        "tranco": obs("tranco", {"status": "absent", "list_id": "Q2K34"}),
        "crawl": obs("crawl", {"reachable": False, "blocked": False, "homepage": {"status": None}}),
        "dns": obs("dns", {"records": {}, "resolves": True, "nxdomain": False, "infra": {}, "rdap": {"status": "unsupported_tld"}}),
    }
    fv = extract_features("small.example", observations)
    assert fv.sources["tranco"].status == "absent" and fv.tranco_rank is None
    assert fv.sources["crawl"].status == "unreachable" and fv.sitemap_found is None
    assert fv.rdap_status == "unsupported_tld"


# ------------------------------------------------------------------ buckets
def test_buckets():
    bs = load_buckets()
    assert bucket_for(0, bs) == "<1K"
    assert bucket_for(999, bs) == "<1K"
    assert bucket_for(1000, bs) == "1K-10K"
    assert bucket_for(73000, bs) == "10K-100K"
    assert bucket_for(999_999, bs) == "100K-1M"
    assert bucket_for(5_000_000, bs) == "1M-10M"
    assert bucket_for(10**9, bs) == "10M+"
    assert bucket_for(None, bs) == "<1K"


# ------------------------------------------------------------------ heuristic
def test_interpolate():
    pts = [[0, 10], [1, 8], [3, 2]]
    assert interpolate(pts, -1) == 10
    assert interpolate(pts, 0.5) == 9
    assert interpolate(pts, 2) == 5
    assert interpolate(pts, 10) == 2


def test_heuristic_big_site():
    fv = extract_features("big.example", big_site_observations())
    est = HeuristicEstimator().estimate(fv, normalize(fv))
    assert est.model_version == "heuristic_v1"
    assert est.traffic_bucket in ("1M-10M", "10M+")
    assert est.lower_bound < est.estimated_monthly_visits < est.upper_bound
    assert est.confidence == "high" and est.confidence_score >= 0.7
    assert "tranco" in est.details["signal_estimates_log10"]
    assert est.details["disclaimer"]


def test_heuristic_small_unlisted_site_is_capped_and_lower_confidence():
    observations = {
        "tranco": obs("tranco", {"status": "absent"}),
        "majestic": obs("majestic", {"status": "absent"}),
        "openpagerank": obs("openpagerank", {"status": "absent"}),
        "crux_top": obs("crux_top", {"status": "absent"}),
        "cc_webgraph": obs("cc_webgraph", {"status": "absent"}),
        "crawl": obs(
            "crawl",
            {
                "reachable": True,
                "blocked": False,
                "homepage": {"status": 200},
                "signals": {"parked": False},
                "sitemaps": {"fetched": 1, "url_count": 2_000_000, "url_count_estimated": 2_000_000, "kinds": {}, "lastmod_buckets": {}},
                "structure": {"page_count_from_sitemap": 2_000_000},
                "pages": {"fetched": 5, "ok": 5},
                "tech": {"technologies": []},
            },
        ),
        "dns": obs(
            "dns",
            {
                "records": {"A": ["1.1.1.1"]},
                "resolves": True,
                "nxdomain": False,
                "infra": {},
                "rdap": {"status": "ok", "domain_age_days": 30},
            },
        ),
    }
    fv = extract_features("tiny.example", observations)
    est = HeuristicEstimator().estimate(fv, normalize(fv))
    # A huge sitemap alone cannot push an unlisted domain above the cap (10^4.3 ≈ 20K).
    assert est.estimated_monthly_visits <= 40_000
    assert est.traffic_bucket in ("1K-10K", "10K-100K")
    assert any("capped" in n for n in est.details["notes"])


def test_heuristic_parked_and_unregistered():
    parked = {
        "crawl": obs(
            "crawl",
            {
                "reachable": True,
                "blocked": False,
                "homepage": {"status": 200},
                "signals": {"parked": True},
                "sitemaps": {},
                "structure": {},
                "pages": {},
                "tech": {"technologies": []},
            },
        ),
        "dns": obs(
            "dns",
            {"records": {}, "resolves": True, "nxdomain": False, "infra": {"parked_provider": ["Sedo parking"]}, "rdap": {"status": "ok"}},
        ),
    }
    fv = extract_features("parked.example", parked)
    est = HeuristicEstimator().estimate(fv, normalize(fv))
    assert est.traffic_bucket == "<1K" and "parked domain" in est.details["notes"]
    unregistered = {"dns": obs("dns", {"records": {}, "resolves": False, "nxdomain": True, "infra": {}, "rdap": {"status": "not_found"}})}
    fv = extract_features("free.example", unregistered)
    est = HeuristicEstimator().estimate(fv, normalize(fv))
    assert est.traffic_bucket == "<1K" and est.estimated_monthly_visits < 100


def test_heuristic_live_site_on_parking_nameservers_is_not_parked():
    observations = big_site_observations()
    observations["dns"].payload["infra"]["parked_provider"] = ["Some registrar parking"]
    fv = extract_features("live.example", observations)
    assert fv.dns_parked and fv.crawl_parked is False
    est = HeuristicEstimator().estimate(fv, normalize(fv))
    assert "parked domain" not in est.details["notes"]
    # Without a crawl, the DNS hint still applies.
    del observations["crawl"]
    fv = extract_features("live.example", observations)
    est = HeuristicEstimator().estimate(fv, normalize(fv))
    assert "parked domain" in est.details["notes"]


# ------------------------------------------------------------------ confidence
def _fv(statuses: dict[str, str]) -> FeatureVector:
    fv = FeatureVector(domain="x.example", computed_at=NOW)
    fv.sources = {k: SourceInfo(status=v) for k, v in statuses.items()}
    return fv


CFG = {
    "coverage_weight": 0.55,
    "agreement_weight": 0.35,
    "popularity_bonus": 0.1,
    "disagreement_scale": 1.0,
    "source_weights": {
        "tranco": 2,
        "crux_top": 2,
        "cc_webgraph": 1.5,
        "majestic": 1,
        "openpagerank": 1,
        "commoncrawl": 1,
        "crawl": 1.5,
        "dns": 0.5,
    },
    "labels": {"high": 0.7, "medium": 0.4},
}


def test_confidence_levels_and_disagreement():
    full = {k: "present" for k in CFG["source_weights"]}
    label, score, det = compute_confidence(CFG, _fv(full), {"tranco": 6.0, "crux": 6.1, "cc_webgraph": 5.9})
    assert label == "high" and score >= 0.85 and det["coverage"] == 1.0
    # Same evidence, strongly disagreeing signals -> lower confidence.
    label2, score2, det2 = compute_confidence(CFG, _fv(full), {"tranco": 7.5, "crux": 5.0, "cc_webgraph": 4.5})
    assert score2 < score and det2["agreement"] < det["agreement"]
    # Sparse evidence -> low.
    label3, score3, _ = compute_confidence(CFG, _fv({"dns": "present", "crawl": "missing", "tranco": "missing"}), {})
    assert label3 == "low" and score3 < 0.4
    # Blocked crawl caps confidence.
    full_blocked = dict(full, crawl="blocked")
    _, score4, _ = compute_confidence(CFG, _fv(full_blocked), {"tranco": 6.0, "crux": 6.0})
    assert score4 <= 0.65
