"""Configuration. Every knob is an environment variable prefixed TE_ (see .env.example)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

PACKAGE_DIR = Path(__file__).resolve().parent
APP_DIR = PACKAGE_DIR.parent.parent  # apps/traffic-estimator


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TE_", env_file=None, extra="ignore")

    # ---------------------------------------------------------------- service
    database_url: str = "postgresql+psycopg://traffic:traffic@localhost:5434/traffic"
    api_host: str = "0.0.0.0"
    api_port: int = 4200
    log_level: str = "info"
    migrate_on_start: bool = True
    data_dir: Path = Path("./data/traffic")  # downloaded lists, caches

    # ---------------------------------------------------------------- outbound HTTP
    # Forward proxy for ALL outbound traffic (compose: egress-proxy, which enforces the SSRF policy).
    # Empty = direct connections (host-side development).
    http_proxy: str = ""
    http_proxy_username: str = ""
    http_proxy_password: str = ""
    # Identify ourselves honestly to the sites and the public services we query.
    user_agent: str = "traffic-estimator/0.1 (+https://github.com/TheAli711/aio-web-scrapper; research crawler)"
    http_timeout_s: float = 20.0
    http_max_connections: int = 64

    # ---------------------------------------------------------------- queue / workers
    worker_concurrency: int = 8  # tasks in flight per worker process
    worker_poll_interval_s: float = 1.0
    task_lease_s: int = 600  # a task not finished within this is considered lost and re-claimed
    task_max_attempts: int = 3
    task_retry_base_s: float = 30.0  # exponential backoff base
    # Global cap on tasks of one collector running at the same time across all workers
    # (enforced in the claim query). 0 = unlimited.
    source_concurrency: dict[str, int] = Field(
        default_factory=lambda: {"commoncrawl": 1, "crawl": 16, "dns": 16, "lists": 16, "list_refresh": 1, "cc_webgraph_scan": 1}
    )
    # Per-worker-process request rate (requests/second) towards each external service.
    source_rate_per_s: dict[str, float] = Field(
        default_factory=lambda: {"commoncrawl": 0.5, "rdap": 1.0, "doh": 20.0, "tranco": 1.0, "lists": 1.0}
    )

    # ---------------------------------------------------------------- pipeline
    enabled_collectors: list[str] = ["lists", "commoncrawl", "crawl", "dns"]
    # Do not re-run a pipeline for a domain that completed less than this many hours ago
    # unless force=true. 0 = always re-run.
    reprocess_after_hours: int = 24 * 7
    bulk_max_domains: int = 10_000

    # ---------------------------------------------------------------- ranked lists (bulk, free)
    # Disable a provider by removing it here. Each is refreshed by the scheduler on its own cadence.
    list_providers: list[str] = ["tranco", "majestic", "openpagerank", "crux_top", "cc_webgraph"]
    list_refresh_hours: dict[str, int] = Field(default_factory=dict)  # override a provider's default
    list_keep_versions: int = 2  # older list versions are deleted from the DB
    tranco_base_url: str = "https://tranco-list.eu"
    tranco_scope: str = "full"  # "full" (~4.6M pay-level domains, ~100 MB) or "1000000"
    majestic_url: str = "https://downloads.majestic.com/majestic_million.csv"
    openpagerank_url: str = "https://openpagerank.keywordseverywhere.com/downloads/top10milliondomains.csv.zip"
    crux_top_url: str = "https://raw.githubusercontent.com/zakird/crux-top-lists/main/data/global/current.csv.gz"
    # Rows of the Common Crawl domain ranks file loaded into Postgres (sorted by harmonic rank).
    # Domains outside the top N are resolved by scanning the kept 2.3 GB file for pending domains.
    cc_webgraph_top_n: int = 5_000_000
    cc_webgraph_scan_delay_s: int = 600  # batch window before a scan for pending domains runs

    # ---------------------------------------------------------------- Common Crawl CDX index (per-domain API)
    # The index server is heavily rate limited and often returns 503/504: usable for small batches,
    # not for 100k+ domains. Kept behind its own collector ("commoncrawl") so it can be switched off.
    commoncrawl_index_url: str = "https://index.commoncrawl.org"
    commoncrawl_crawl_count: int = 2  # how many of the most recent crawls to query
    commoncrawl_max_records: int = 15_000  # records fetched per crawl per domain (one CDX page)
    commoncrawl_cache_hours: int = 24 * 30  # a crawl index is immutable; re-query only after this

    # ---------------------------------------------------------------- own crawler
    crawl_pages: int = 15  # representative pages fetched beyond homepage/robots/sitemaps
    crawl_max_sitemaps: int = 20  # sitemap files parsed (indexes count)
    crawl_max_sitemap_urls: int = 200_000  # stop counting after this many URLs
    crawl_max_body_bytes: int = 2_000_000
    crawl_per_domain_delay_s: float = 1.0  # politeness delay between requests to one host
    crawl_respect_robots: bool = True

    # ---------------------------------------------------------------- DNS / RDAP
    # "doh": DNS-over-HTTPS JSON (works through the egress proxy); "system": the resolver library.
    dns_mode: str = "doh"
    doh_url: str = "https://dns.google/resolve"
    rdap_enabled: bool = True
    rdap_bootstrap_url: str = "https://data.iana.org/rdap/dns.json"
    rdap_fallback_url: str = "https://rdap.org/domain/{domain}"

    # ---------------------------------------------------------------- estimation
    feature_version: str = "v1"
    model_version: str = "heuristic_v1"
    heuristic_config: Path = APP_DIR / "config" / "heuristic_v1.yaml"

    @property
    def sync_database_url(self) -> str:
        return self.database_url


@lru_cache
def get_settings() -> Settings:
    return Settings()
