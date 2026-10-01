"""Deterministic, versioned feature transformations for models and the heuristic.

Counts and ranks are heavy-tailed, so they become log10 / log1p values; flags become 0/1; missing
stays None (tree models treat it as missing; the heuristic skips the signal). The output keys are
the model input names; NORMALIZED_VERSION changes whenever a transformation changes.
"""

from __future__ import annotations

import math

from .schema import FeatureVector

NORMALIZED_VERSION = "v1"


def _log10(v: int | float | None) -> float | None:
    if v is None or v <= 0:
        return None
    return round(math.log10(v), 4)


def _log1p(v: int | float | None) -> float | None:
    if v is None or v < 0:
        return None
    return round(math.log1p(v) / math.log(10), 4)  # log10(1 + v)


def _flag(v: bool | None) -> float | None:
    return None if v is None else (1.0 if v else 0.0)


def _share(num: int | None, den: int | None) -> float | None:
    if num is None or not den:
        return None
    return round(num / den, 4)


def normalize(fv: FeatureVector) -> dict[str, float | None]:
    lastmod_total = sum(x or 0 for x in (fv.sitemap_lastmod_30d, fv.sitemap_lastmod_90d, fv.sitemap_lastmod_365d, fv.sitemap_lastmod_older))
    reachable = fv.crawl_reachable
    out: dict[str, float | None] = {
        # ranked lists
        "tranco_present": _flag(fv.sources.get("tranco") is not None and fv.sources["tranco"].status == "present")
        if "tranco" in fv.sources
        else None,
        "log_tranco_rank": _log10(fv.tranco_rank),
        "majestic_present": _flag(fv.sources["majestic"].status == "present") if "majestic" in fv.sources else None,
        "log_majestic_rank": _log10(fv.majestic_rank),
        "log_majestic_ref_subnets": _log1p(fv.majestic_ref_subnets),
        "log_majestic_ref_ips": _log1p(fv.majestic_ref_ips),
        "opr_present": _flag(fv.sources["openpagerank"].status == "present") if "openpagerank" in fv.sources else None,
        "log_opr_rank": _log10(fv.opr_rank),
        "opr_score": fv.opr_score,
        "log_opr_ref_domains": _log1p(fv.opr_ref_domains),
        "crux_present": _flag(fv.sources["crux_top"].status == "present") if "crux_top" in fv.sources else None,
        "log_crux_bucket": _log10(fv.crux_rank_bucket),
        "ccg_present": _flag(fv.sources["cc_webgraph"].status == "present") if "cc_webgraph" in fv.sources else None,
        "log_ccg_harmonic_rank": _log10(fv.ccg_harmonic_rank),
        "log_ccg_pagerank_rank": _log10(fv.ccg_pagerank_rank),
        "log_ccg_n_hosts": _log1p(fv.ccg_n_hosts),
        # Common Crawl CDX
        "cc_present": _flag(fv.sources["commoncrawl"].status == "present")
        if "commoncrawl" in fv.sources and fv.sources["commoncrawl"].status in ("present", "absent")
        else None,
        "log_cc_url_count": _log1p(fv.commoncrawl_url_count),
        "log_cc_unique_paths": _log1p(fv.commoncrawl_unique_paths),
        "log_cc_subdomains": _log1p(fv.commoncrawl_unique_subdomains),
        "cc_crawl_share": _share(fv.commoncrawl_crawl_count, fv.commoncrawl_crawls_queried),
        # own crawl
        "crawl_reachable": _flag(reachable),
        "crawl_blocked": _flag(fv.crawl_blocked),
        "crawl_parked": _flag(fv.crawl_parked),
        "crawl_redirected": _flag(fv.crawl_redirected_elsewhere),
        "sitemap_found": _flag(fv.sitemap_found) if reachable else None,
        # Without a sitemap there is no size evidence at all (None), as opposed to an empty sitemap (0).
        "log_sitemap_pages": _log1p(fv.sitemap_page_count) if (reachable and fv.sitemap_found) else None,
        "log_product_count": _log1p(fv.product_count) if reachable else None,
        "log_article_count": _log1p(fv.article_count) if reachable else None,
        "log_category_count": _log1p(fv.category_count) if reachable else None,
        "sitemap_fresh_share": _share(fv.sitemap_lastmod_30d, lastmod_total) if reachable else None,
        "sitemap_year_share": _share(
            (fv.sitemap_lastmod_30d or 0) + (fv.sitemap_lastmod_90d or 0) + (fv.sitemap_lastmod_365d or 0), lastmod_total
        )
        if reachable
        else None,
        "log_language_count": _log1p(fv.language_count) if reachable else None,
        "log_subdomain_count": _log1p(fv.subdomain_count) if reachable else None,
        "log_avg_word_count": _log1p(fv.avg_word_count) if reachable else None,
        "log_homepage_word_count": _log1p(fv.homepage_word_count) if reachable else None,
        "log_homepage_internal_links": _log1p(fv.homepage_internal_links) if reachable else None,
        "log_homepage_external_links": _log1p(fv.homepage_external_links) if reachable else None,
        "log_technology_count": _log1p(fv.technology_count) if reachable else None,
        "analytics_detected": _flag(fv.analytics_detected) if reachable else None,
        "advertising_detected": _flag(fv.advertising_tags_detected) if reachable else None,
        "log_marketing_tags": _log1p(fv.marketing_tag_count) if reachable else None,
        "has_cms": _flag(bool(fv.cms)) if reachable else None,
        "is_ecommerce": _flag(bool(fv.ecommerce_platform) or bool(fv.schema_product)) if reachable else None,
        "is_publisher": _flag(bool(fv.schema_article) or bool(fv.has_rss)) if reachable else None,
        "has_search": _flag(fv.has_search) if reachable else None,
        "jsonld_present": _flag(fv.jsonld_present) if reachable else None,
        "og_present": _flag(fv.og_present) if reachable else None,
        "uses_cdn": _flag(bool(fv.cdn) or bool(fv.dns_cdn)) if (reachable or fv.dns_resolves is not None) else None,
        # DNS / RDAP
        "dns_resolves": _flag(fv.dns_resolves),
        "dns_nxdomain": _flag(fv.dns_nxdomain),
        "dns_has_mx": _flag(fv.dns_has_mx),
        "dns_has_spf": _flag(fv.dns_has_spf),
        "dns_parked": _flag(fv.dns_parked),
        "log_dns_a_count": _log1p(fv.dns_a_count),
        "log_dns_verification_tags": _log1p(fv.dns_verification_tag_count),
        "log_domain_age_days": _log1p(fv.domain_age_days),
    }
    return out


NORMALIZED_KEYS: tuple[str, ...] = tuple(
    normalize(FeatureVector(domain="example.com", computed_at=__import__("datetime").datetime(2026, 1, 1))).keys()
)
