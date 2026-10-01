# Feature definitions (feature_version `v2`)

`FeatureVector` (`features/schema.py`) is the raw-scale view derived from the latest raw observation
per source. `None` means *not observed* (the source is missing/failed or had nothing), which is
different from `0`. `fv.sources[<source>].status` records why: `present`, `absent` (a definite
negative, e.g. not in the Tranco list), `missing` (no data yet), `disabled` (the deployment does not
run that collector or list; left out of coverage), `failed`, `unreachable`, `blocked`.

v2 (from v1): added `tranco_list_size` and the `disabled` status; dropped the web graph's float
centrality values, which the on-disk index does not keep.

Normalised inputs (`features/normalize.py`, `NORMALIZED_VERSION = v1`) are what models and the
heuristic consume: ranks → `log10(rank)`, counts → `log10(1 + n)`, flags → 0/1, shares → 0..1,
missing → `None`. Transformations are deterministic and versioned.

## Ranked lists (popularity / link graph) — collector `lists`

| Feature | Source | Meaning | Normalised |
|---|---|---|---|
| `tranco_rank`, `tranco_list_date`, `tranco_list_size` | tranco | rank in the Tranco daily list (pay-level domains); absent = not in the loaded list, i.e. a rank beyond `tranco_list_size` (1M or ~4.6M for the full list) | `log_tranco_rank`, `tranco_present` |
| `majestic_rank`, `majestic_ref_subnets`, `majestic_ref_ips` | majestic | Majestic Million rank; referring class-C subnets / IPs (backlink breadth) | `log_majestic_rank`, `log_majestic_ref_subnets`, `log_majestic_ref_ips`, `majestic_present` |
| `opr_rank`, `opr_score`, `opr_ref_domains` | openpagerank | Open PageRank top-10M rank, score 0–10, referring domains (Common Crawl derived) | `log_opr_rank`, `opr_score`, `log_opr_ref_domains`, `opr_present` |
| `crux_rank_bucket` | crux_top | smallest CrUX popularity bucket (1000 … 1000000) among the domain's origins | `log_crux_bucket`, `crux_present` |
| `ccg_harmonic_rank`, `ccg_pagerank_rank`, `ccg_n_hosts` | cc_webgraph | Common Crawl domain web graph (133M domains): harmonic-centrality rank, PageRank rank, hosts under the domain | `log_ccg_harmonic_rank`, `log_ccg_pagerank_rank`, `log_ccg_n_hosts`, `ccg_present` |

## Common Crawl CDX index — collector `commoncrawl`

| Feature | Meaning | Normalised |
|---|---|---|
| `commoncrawl_url_count` | captures of the domain (all subdomains) over the queried recent crawls (capped by `TE_COMMONCRAWL_MAX_RECORDS` per crawl, see `commoncrawl_limit_hit`) | `log_cc_url_count` |
| `commoncrawl_unique_paths` | distinct host+path in the largest crawl | `log_cc_unique_paths` |
| `commoncrawl_unique_subdomains` | distinct hosts in the largest crawl | `log_cc_subdomains` |
| `commoncrawl_crawl_count` / `commoncrawl_crawls_queried` | crawls with ≥1 capture / crawls queried | `cc_crawl_share` |
| `commoncrawl_first_seen`, `commoncrawl_last_seen` | CDX timestamps (yyyymmddhhmmss) | – |
| `commoncrawl_html_share` | share of captures that are HTML | – |

## Own crawl — collector `crawl`

Reachability: `crawl_reachable` (any HTTP response), `crawl_blocked` (bot challenge / 403 / 429
patterns), `crawl_parked` (parking-page markers), `crawl_redirected_elsewhere` (homepage redirects
to another registrable domain), `crawl_homepage_status`, `crawl_requests`.

Sitemap / structure (only when reachable):

| Feature | Meaning | Normalised |
|---|---|---|
| `sitemap_found` | at least one sitemap file parsed (from robots.txt or well-known paths) | `sitemap_found` |
| `sitemap_url_count` | `<url>` entries actually parsed (budget: `TE_CRAWL_MAX_SITEMAPS` files, `TE_CRAWL_MAX_SITEMAP_URLS` URLs) | – |
| `sitemap_page_count` = `page_count_from_sitemap` | parsed count extrapolated over unparsed index children (`sitemap_truncated`) | `log_sitemap_pages` |
| `sitemap_product_count`, `sitemap_article_count`, `sitemap_category_count` | URL-path classification of parsed sitemap URLs (`collectors/crawler/urls.py`) | – |
| `product_count`, `article_count`, `category_count` | sitemap counts scaled by the extrapolation factor; from homepage/page links when there is no sitemap | `log_product_count`, `log_article_count`, `log_category_count` |
| `sitemap_lastmod_30d/90d/365d/older`, `sitemap_lastmod_max` | freshness distribution of `<lastmod>` | `sitemap_fresh_share`, `sitemap_year_share` |
| `language_count` | hreflang languages ∪ sitemap alternates ∪ ISO-639-1 path prefixes (falls back to `<html lang>`) | `log_language_count` |
| `subdomain_count` | distinct subdomains seen in sitemaps and internal links | `log_subdomain_count` |

Pages: `pages_fetched`, `pages_ok`, `avg_word_count`, `avg_internal_links`, `homepage_word_count`,
`homepage_internal_links`, `homepage_external_links`, `has_rss`, `has_search`, `og_present`,
`jsonld_present`, `schema_product` / `schema_article` / `schema_organization` (JSON-LD or microdata
types), `title`, `html_lang` → `log_avg_word_count`, `log_homepage_*`, `has_search`, `og_present`,
`jsonld_present`, `is_ecommerce` (platform or Product schema), `is_publisher` (Article schema or RSS).

Technologies (local pattern table, `collectors/crawler/tech.py`): `technologies`,
`technology_count`, `cms`, `ecommerce_platform`, `frameworks`, `cdn`, `hosting`,
`analytics_tags` / `analytics_detected`, `advertising_tags` / `advertising_tags_detected`,
`marketing_tag_count`, `payment_providers` → `log_technology_count`, `has_cms`, `analytics_detected`,
`advertising_detected`, `log_marketing_tags`, `uses_cdn`. Detected tags are operational signals;
they say nothing about volume.

## DNS / RDAP — collector `dns`

| Feature | Meaning | Normalised |
|---|---|---|
| `dns_resolves`, `dns_nxdomain` | apex has A/AAAA; NXDOMAIN | `dns_resolves`, `dns_nxdomain` |
| `dns_has_mx`, `dns_has_spf`, `dns_a_count`, `dns_ns_count` | mail setup and record counts | `dns_has_mx`, `dns_has_spf`, `log_dns_a_count` |
| `dns_cdn`, `dns_hosting`, `dns_provider`, `dns_email_provider` | infrastructure from IP ranges, NS/CNAME/MX patterns | `uses_cdn` |
| `dns_parked` | parking-provider nameservers | `dns_parked` |
| `dns_verification_tag_count` | `*-site-verification` TXT records (Google, Facebook, …) | `log_dns_verification_tags` |
| `domain_creation_date`, `domain_age_days`, `domain_expiration_date`, `registrar`, `rdap_status` | RDAP (`ok`, `not_found`, `unsupported_tld`, `error`, `disabled`) | `log_domain_age_days` |

## Provenance

`sources` (per source: `status`, `collected_at`, `source_version`, `note`) is stored next to the
features and drives the confidence calculation. `source_version` is the list id (Tranco `Q2K34`),
the crawl ids (`CC-MAIN-2026-39,CC-MAIN-2026-34`) or the collector version (`crawl_v1`, `dns_v1`).
