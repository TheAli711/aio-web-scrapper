"""Feature model, version "v2" (v2: + tranco_list_size; the web graph float values are gone, the
on-disk index keeps ranks only).

`FeatureVector` is the structured, raw-scale view of everything we know about a domain, derived
from the latest raw observation of each source. None means "not observed" (source missing or the
source had nothing), which is different from 0. `SourceInfo` records what each source contributed.

Changing the meaning of a field or adding derived fields = bump FEATURE_VERSION; raw observations
are never rewritten, features are simply recomputed under the new version.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

FEATURE_VERSION = "v2"


class SourceInfo(BaseModel):
    status: str  # present | absent | missing | failed | blocked | unreachable | disabled
    collected_at: datetime | None = None
    source_version: str | None = None
    note: str | None = None


class FeatureVector(BaseModel):
    domain: str
    feature_version: str = FEATURE_VERSION
    computed_at: datetime

    # ---- ranked lists (popularity / link-graph signals; none of these is traffic)
    tranco_rank: int | None = None
    tranco_list_date: str | None = None
    tranco_list_size: int | None = None  # ranks in the loaded list; absent = rank beyond this
    majestic_rank: int | None = None
    majestic_ref_subnets: int | None = None
    majestic_ref_ips: int | None = None
    opr_rank: int | None = None
    opr_score: float | None = None
    opr_ref_domains: int | None = None
    crux_rank_bucket: int | None = None  # 1000, 5000, ..., 1000000 (origin is within the top N)
    ccg_harmonic_rank: int | None = None  # Common Crawl domain web graph
    ccg_pagerank_rank: int | None = None
    ccg_n_hosts: int | None = None

    # ---- Common Crawl CDX index (recent crawls)
    commoncrawl_url_count: int | None = None
    commoncrawl_unique_paths: int | None = None
    commoncrawl_unique_subdomains: int | None = None
    commoncrawl_crawl_count: int | None = None
    commoncrawl_crawls_queried: int | None = None
    commoncrawl_first_seen: str | None = None
    commoncrawl_last_seen: str | None = None
    commoncrawl_html_share: float | None = None
    commoncrawl_limit_hit: bool | None = None

    # ---- own crawl: reachability
    crawl_reachable: bool | None = None
    crawl_blocked: bool | None = None
    crawl_parked: bool | None = None
    crawl_redirected_elsewhere: bool | None = None
    crawl_homepage_status: int | None = None
    crawl_requests: int | None = None

    # ---- own crawl: sitemap / structure
    sitemap_found: bool | None = None
    sitemap_url_count: int | None = None  # observed
    sitemap_page_count: int | None = None  # extrapolated when truncated
    sitemap_product_count: int | None = None
    sitemap_article_count: int | None = None
    sitemap_category_count: int | None = None
    sitemap_lastmod_30d: int | None = None
    sitemap_lastmod_90d: int | None = None
    sitemap_lastmod_365d: int | None = None
    sitemap_lastmod_older: int | None = None
    sitemap_lastmod_max: str | None = None
    sitemap_truncated: bool | None = None
    page_count_from_sitemap: int | None = None
    product_count: int | None = None
    article_count: int | None = None
    category_count: int | None = None
    language_count: int | None = None
    subdomain_count: int | None = None

    # ---- own crawl: pages
    pages_fetched: int | None = None
    pages_ok: int | None = None
    avg_word_count: int | None = None
    avg_internal_links: int | None = None
    homepage_word_count: int | None = None
    homepage_internal_links: int | None = None
    homepage_external_links: int | None = None
    has_rss: bool | None = None
    has_search: bool | None = None
    og_present: bool | None = None
    jsonld_present: bool | None = None
    schema_product: bool | None = None
    schema_article: bool | None = None
    schema_organization: bool | None = None
    title: str | None = None
    html_lang: str | None = None

    # ---- own crawl: technologies
    technology_count: int | None = None
    technologies: list[str] = Field(default_factory=list)
    cms: str | None = None
    ecommerce_platform: str | None = None
    frameworks: list[str] = Field(default_factory=list)
    cdn: list[str] = Field(default_factory=list)
    hosting: list[str] = Field(default_factory=list)
    analytics_detected: bool | None = None
    analytics_tags: list[str] = Field(default_factory=list)
    advertising_tags_detected: bool | None = None
    advertising_tags: list[str] = Field(default_factory=list)
    marketing_tag_count: int | None = None
    payment_providers: list[str] = Field(default_factory=list)

    # ---- DNS / RDAP
    dns_resolves: bool | None = None
    dns_nxdomain: bool | None = None
    dns_has_mx: bool | None = None
    dns_has_spf: bool | None = None
    dns_a_count: int | None = None
    dns_ns_count: int | None = None
    dns_cdn: list[str] = Field(default_factory=list)
    dns_hosting: list[str] = Field(default_factory=list)
    dns_provider: list[str] = Field(default_factory=list)
    dns_email_provider: list[str] = Field(default_factory=list)
    dns_parked: bool | None = None
    dns_verification_tag_count: int | None = None
    domain_creation_date: str | None = None
    domain_age_days: int | None = None
    domain_expiration_date: str | None = None
    registrar: str | None = None
    rdap_status: str | None = None

    # ---- provenance
    sources: dict[str, SourceInfo] = Field(default_factory=dict)

    def present_sources(self) -> list[str]:
        return [k for k, v in self.sources.items() if v.status == "present"]
