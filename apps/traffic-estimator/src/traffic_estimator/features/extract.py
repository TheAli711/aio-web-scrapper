"""Raw observations -> FeatureVector (feature_version v2). Pure function of the latest observation
per source; deterministic so features can be recomputed at any time."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

from .schema import FEATURE_VERSION, FeatureVector, SourceInfo

LIST_SOURCES = ("tranco", "majestic", "openpagerank", "crux_top", "cc_webgraph")


class RawObs:
    """One raw_observations row."""

    __slots__ = ("source", "payload", "collected_at", "source_version")

    def __init__(self, source: str, payload: dict[str, Any], collected_at: datetime, source_version: str | None) -> None:
        self.source = source
        self.payload = payload
        self.collected_at = collected_at
        self.source_version = source_version


def _mark(fv: FeatureVector, source: str, status: str, obs: RawObs | None = None, note: str | None = None) -> None:
    fv.sources[source] = SourceInfo(
        status=status,
        collected_at=obs.collected_at if obs else None,
        source_version=obs.source_version if obs else None,
        note=note,
    )


def extract_features(
    domain: str,
    observations: dict[str, RawObs],
    failed_sources: dict[str, str] | None = None,
    disabled: Iterable[str] = (),
) -> FeatureVector:
    """observations: latest observation per source. failed_sources: source -> error for collectors that
    failed in this run (so the confidence layer knows they were attempted). disabled: sources this
    deployment does not collect; without an observation they are "disabled", not missing evidence."""
    fv = FeatureVector(domain=domain, feature_version=FEATURE_VERSION, computed_at=datetime.now(UTC))

    # ------------------------------------------------------------------ ranked lists
    for src in LIST_SOURCES:
        obs = observations.get(src)
        if not obs:
            _mark(fv, src, "missing")
            continue
        p = obs.payload
        present = p.get("status") == "present" and p.get("rank") is not None
        _mark(fv, src, "present" if present else "absent", obs)
        if src == "tranco":
            fv.tranco_list_date = p.get("list_date")
            fv.tranco_list_size = _int(p.get("list_size"))
            if present:
                fv.tranco_rank = int(p["rank"])
        elif src == "majestic" and present:
            fv.majestic_rank = int(p["rank"])
            fv.majestic_ref_subnets = _int(p.get("ref_subnets"))
            fv.majestic_ref_ips = _int(p.get("ref_ips"))
        elif src == "openpagerank" and present:
            fv.opr_rank = int(p["rank"])
            fv.opr_score = _float(p.get("score"))
            fv.opr_ref_domains = _int(p.get("ref_domains"))
        elif src == "crux_top" and present:
            fv.crux_rank_bucket = int(p["rank"])
        elif src == "cc_webgraph" and present:
            fv.ccg_harmonic_rank = int(p["rank"])
            fv.ccg_pagerank_rank = _int(p.get("pr_rank"))
            fv.ccg_n_hosts = _int(p.get("n_hosts"))

    # ------------------------------------------------------------------ Common Crawl CDX
    obs = observations.get("commoncrawl")
    if obs:
        p = obs.payload
        fv.commoncrawl_url_count = _int(p.get("url_count"))
        fv.commoncrawl_unique_paths = _int(p.get("unique_paths_max_crawl"))
        fv.commoncrawl_unique_subdomains = _int(p.get("unique_subdomains_max_crawl"))
        fv.commoncrawl_crawl_count = _int(p.get("crawl_count"))
        fv.commoncrawl_crawls_queried = _int(p.get("crawls_queried"))
        fv.commoncrawl_first_seen = p.get("first_seen")
        fv.commoncrawl_last_seen = p.get("last_seen")
        fv.commoncrawl_html_share = _float(p.get("html_share"))
        fv.commoncrawl_limit_hit = bool(p.get("limit_hit"))
        _mark(fv, "commoncrawl", "present" if (fv.commoncrawl_url_count or 0) > 0 else "absent", obs)
    else:
        _mark(fv, "commoncrawl", "missing")

    # ------------------------------------------------------------------ own crawl
    obs = observations.get("crawl")
    if obs:
        p = obs.payload
        fv.crawl_reachable = bool(p.get("reachable"))
        fv.crawl_blocked = bool(p.get("blocked"))
        fv.crawl_requests = _int(p.get("requests"))
        home = p.get("homepage") or {}
        fv.crawl_homepage_status = _int(home.get("status"))
        fv.crawl_redirected_elsewhere = bool(home.get("redirected_to_other_domain"))
        signals = p.get("signals") or {}
        fv.crawl_parked = bool(signals.get("parked"))
        if fv.crawl_reachable:
            sm = p.get("sitemaps") or {}
            fv.sitemap_found = bool(sm.get("fetched"))
            fv.sitemap_url_count = _int(sm.get("url_count"))
            fv.sitemap_page_count = _int(sm.get("url_count_estimated"))
            kinds = sm.get("kinds") or {}
            fv.sitemap_product_count = _int(kinds.get("product", 0))
            fv.sitemap_article_count = _int(kinds.get("article", 0))
            fv.sitemap_category_count = _int(kinds.get("category", 0))
            lm = sm.get("lastmod_buckets") or {}
            fv.sitemap_lastmod_30d = _int(lm.get("30d", 0))
            fv.sitemap_lastmod_90d = _int(lm.get("90d", 0))
            fv.sitemap_lastmod_365d = _int(lm.get("365d", 0))
            fv.sitemap_lastmod_older = _int(lm.get("older", 0))
            fv.sitemap_lastmod_max = sm.get("lastmod_max")
            fv.sitemap_truncated = bool(sm.get("truncated"))
            st = p.get("structure") or {}
            fv.page_count_from_sitemap = _int(st.get("page_count_from_sitemap"))
            fv.product_count = _int(st.get("product_count"))
            fv.article_count = _int(st.get("article_count"))
            fv.category_count = _int(st.get("category_count"))
            fv.language_count = _int(st.get("language_count"))
            fv.subdomain_count = _int(st.get("subdomain_count"))
            pg = p.get("pages") or {}
            fv.pages_fetched = _int(pg.get("fetched"))
            fv.pages_ok = _int(pg.get("ok"))
            fv.avg_word_count = _int(pg.get("avg_word_count"))
            fv.avg_internal_links = _int(pg.get("avg_internal_links"))
            schema_types = set((pg.get("schema_types") or {}).keys()) | set((home.get("page") or {}).get("schema_types") or [])
            fv.schema_product = any(t in schema_types for t in ("Product", "ProductGroup", "Offer", "AggregateOffer"))
            fv.schema_article = any(t in schema_types for t in ("Article", "NewsArticle", "BlogPosting", "TechArticle"))
            fv.schema_organization = any(t in schema_types for t in ("Organization", "Corporation", "LocalBusiness", "Store"))
            fv.homepage_word_count = _int(signals.get("homepage_word_count"))
            fv.homepage_internal_links = _int(signals.get("homepage_internal_links"))
            fv.homepage_external_links = _int(signals.get("homepage_external_links"))
            fv.has_rss = bool(signals.get("has_rss"))
            fv.has_search = bool(signals.get("has_search"))
            fv.og_present = bool(signals.get("og_present"))
            fv.jsonld_present = bool(signals.get("jsonld_present"))
            fv.title = signals.get("title")
            fv.html_lang = signals.get("html_lang")
            tech = p.get("tech") or {}
            fv.technologies = [t["name"] for t in tech.get("technologies", []) if isinstance(t, dict)]
            fv.technology_count = len(fv.technologies)
            fv.cms = tech.get("cms")
            fv.ecommerce_platform = tech.get("ecommerce_platform")
            fv.frameworks = list(tech.get("frameworks") or [])
            fv.cdn = list(tech.get("cdn") or [])
            fv.hosting = list(tech.get("hosting") or [])
            fv.analytics_tags = list(tech.get("analytics") or [])
            fv.analytics_detected = bool(fv.analytics_tags)
            fv.advertising_tags = list(tech.get("advertising") or [])
            fv.advertising_tags_detected = bool(fv.advertising_tags)
            fv.marketing_tag_count = len(tech.get("marketing") or [])
            fv.payment_providers = list(tech.get("payments") or [])
        status = "present"
        if not fv.crawl_reachable:
            status = "unreachable"
        elif fv.crawl_blocked:
            status = "blocked"
        _mark(fv, "crawl", status, obs, note=p.get("blocked_reason"))
    else:
        _mark(fv, "crawl", "missing")

    # ------------------------------------------------------------------ DNS / RDAP
    obs = observations.get("dns")
    if obs:
        p = obs.payload
        rec = p.get("records") or {}
        fv.dns_resolves = bool(p.get("resolves"))
        fv.dns_nxdomain = bool(p.get("nxdomain"))
        fv.dns_has_mx = bool(p.get("has_mx"))
        fv.dns_has_spf = bool(p.get("has_spf"))
        fv.dns_a_count = len(rec.get("A") or [])
        fv.dns_ns_count = len(rec.get("NS") or [])
        infra = p.get("infra") or {}
        fv.dns_cdn = list(infra.get("cdn") or [])
        fv.dns_hosting = list(infra.get("hosting") or [])
        fv.dns_provider = list(infra.get("dns_provider") or [])
        fv.dns_email_provider = list(infra.get("email_provider") or [])
        fv.dns_parked = bool(infra.get("parked_provider"))
        fv.dns_verification_tag_count = len(p.get("verification_tags") or [])
        rdap = p.get("rdap") or {}
        fv.rdap_status = rdap.get("status")
        if rdap.get("status") == "ok":
            fv.domain_creation_date = rdap.get("registration_date")
            fv.domain_age_days = _int(rdap.get("domain_age_days"))
            fv.domain_expiration_date = rdap.get("expiration_date")
            fv.registrar = rdap.get("registrar")
        _mark(fv, "dns", "present" if fv.dns_resolves else "absent", obs)
    else:
        _mark(fv, "dns", "missing")

    for src, err in (failed_sources or {}).items():
        if src in fv.sources and fv.sources[src].status == "missing":
            fv.sources[src] = SourceInfo(status="failed", note=err[:200])
    for src in disabled:
        if src in fv.sources and fv.sources[src].status == "missing":
            fv.sources[src] = SourceInfo(status="disabled", note="not collected by this deployment")
    return fv


def _int(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _float(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
