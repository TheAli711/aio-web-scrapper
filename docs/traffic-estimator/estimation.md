# Estimation, confidence and accuracy

## What an estimate is

```json
{
  "domain": "example.com",
  "estimated_monthly_visits": 73000,
  "lower_bound": 40000,
  "upper_bound": 130000,
  "traffic_bucket": "10K-100K",
  "confidence": "medium",
  "confidence_score": 0.67,
  "model_version": "heuristic_v2",
  "feature_version": "v2",
  "generated_at": "2026-10-01T09:00:00Z",
  "disclaimer": "Estimated from public signals (rankings, link graphs, crawl, DNS); not measured traffic."
}
```

`estimated_monthly_visits` is a point estimate inferred from public signals. It is **not** measured
traffic and must not be presented as such. `lower_bound`/`upper_bound` is the range the estimator
considers plausible; `traffic_bucket` is the coarse class (`<1K`, `1K-10K`, `10K-100K`, `100K-1M`,
`1M-10M`, `10M+`); `confidence` says how much evidence backs the estimate, independently of its size.
`?details=true` returns the per-signal breakdown, notes and source statuses.

## heuristic_v2 (`estimator/heuristic.py`, `config/heuristic_v2.yaml`)

The baseline used until a model is trained on legitimate ground truth. Every number in the config is
a hand-set prior, not a validated coefficient. `heuristic_v1` (`config/heuristic_v1.yaml`,
`TE_MODEL_VERSION=heuristic_v1`) stays available for comparison; v2 differs in three places, each
argued from what the sources are, not fitted to the benchmark below:

- **Absence from Tranco is a bound.** A domain missing from a complete rank list has a rank beyond
  the end of the list. The final estimate is capped at what the list's last rank maps to on that
  list's curve plus the curve's own uncertainty (0.5): Tranco full (~4.57M) ends at 10^3.8, cap
  10^4.3 ≈ 20K; a top-1M list caps at 10^5.0. Skipped when the domain is in the CrUX top list.
  v1 applied the same 10^4.3 bound only to domains absent from *every* list, which the web graph
  (133M domains) made rare.
- **Ranges start at ±0.5 decade** (v1: ±0.3): even a perfectly observed rank maps to visits only
  within about ×3 either way; the same 0.5 is the absence-cap tolerance.
- **Both web-graph centralities.** The graph's weight (2.0) is split between harmonic-centrality
  rank and PageRank rank (1.0 each, same curve); PageRank counts as a link signal, not as a second
  independent popularity vote for confidence.

Considered and left out: positive shifts for DNS verification records and recently modified sitemap
entries. 86% / 94% of the sites processed so far have them, so a positive-only shift raises the
typical estimate by ~0.15 instead of separating sites (it would need a centred form and a reference
population). Analytics and advertising tags, at 51% / 53%, do split sites and keep their v1 shifts.

1. **Per-signal estimates.** Each available normalised signal is mapped to `log10(monthly visits)`
   through a piecewise-linear curve (`points`): Tranco rank, CrUX bucket, Common Crawl harmonic rank,
   Majestic rank, Open PageRank rank (kind `popularity`), referring domains (kind `links`), Common
   Crawl capture count and sitemap page count (kind `size`), web-graph PageRank rank (kind `links`).
2. **Combination.** Weighted mean of the per-signal estimates (`weight` per signal; popularity lists
   dominate, size signals are weak).
3. **Caps and shifts.** No popularity-list presence at all → capped at `no_popularity_cap`
   (10^4.3 ≈ 20K: absence from Tranco's full list and the other lists is itself evidence of a small
   site); absent from the Tranco list alone → capped at its last rank's value + 0.5 (see above,
   applied last). Parked → ≤ 10^2.3. Unregistered (RDAP not found + NXDOMAIN) → ≤ 10^1.5.
   NXDOMAIN → ≤ 10^2. A parking hint from DNS (nameservers/IPs) is ignored when the crawl saw a live, non-parked
   homepage. Unreachable homepage → −0.4. Analytics/advertising tags → tiny positive shifts (operational
   signals only). Blocked crawl → no shift, lower confidence.
4. **Range.** `spread = base + missing_evidence × (1 − coverage) + disagreement × stddev(popularity
   signal estimates)`, capped; bounds are `10^(est ∓ spread)`.
5. **Bucket** from the point estimate using the configured edges.

Changing a curve, a weight or a cap is a config change; if the output semantics change, bump
`model_version` (`heuristic_v3`, new config file) so stored estimates stay comparable.

## Confidence (`estimator/confidence.py`)

`confidence_score = 0.55 × coverage + 0.35 × agreement + popularity_bonus`, clipped to [0, 1];
labels `high ≥ 0.70`, `medium ≥ 0.40`, else `low`.

- **coverage**: weighted share of sources that produced evidence. A definite absence counts 0.8, a
  present value 1.0, an unreachable site 0.5, a blocked crawl 0.3, missing/failed 0. Sources the
  deployment does not collect (`disabled`, e.g. the opt-in CDX collector) are left out. Weights:
  Tranco 2, CrUX 2, web graph 1.5, crawl 1.5, Majestic 1, Open PageRank 1, Common Crawl CDX 1, DNS 0.5.
- **agreement**: `1 − min(1, stddev / disagreement_scale)` over the per-signal `log10` estimates of
  the independent *popularity* signals (one signal → 0.6, none → 0.3). SEO/link signals saying
  "huge" while Tranco says "tiny" lowers confidence.
- **popularity_bonus** (0.1) when at least two popularity signals are present.
- A blocked crawl caps the score at 0.65.

Confidence is not a function of the traffic number: a reachable small site absent from every list
can be `high` confidence `<1K`; a big site behind bot protection with disagreeing lists is `low`.

## Known accuracy limitations

- Nothing is validated against ground truth yet. The curves encode rough public knowledge of how
  rank relates to visits (Zipf-like, about one decade of visits per decade of rank: rank 1k ≈ 10^7.6,
  rank 100k ≈ 10^5.6, rank 1M ≈ 10^4.5 per month) and are deliberately conservative for size
  signals. Treat point estimates as order-of-magnitude; buckets and ranges are the honest outputs.
- Link-popular domains with few visitors (example.com is the canonical case: Tranco/Majestic say
  10^8.4, the CrUX bucket says 10^6.3) get a wide range and lower confidence from the disagreement;
  the CrUX bucket is the most visitor-like signal and carries the largest weight for that reason.
- First real run (2026-10-01, lists only, Common Crawl index throttled): wikipedia.org 10M+
  (medium), shophive.com 100K–1M (high), toscrape.com 10K–100K (high), an NXDOMAIN but registered
  domain <1K (low), an unregistered domain <1K (low).
- Rank lists are keyed by registrable domain; multi-brand or multi-country properties sharing a
  domain are summed, subdomain-based brands are merged.
- Popularity lists lag (Tranco 30-day window, CrUX monthly, web graph quarterly window).
- Bot-protected, JavaScript-only or geo-blocked sites yield few crawl signals.
- Media/CDN/API-heavy domains rank high in link graphs without having visitor traffic.

## Benchmark against Similarweb (2026-10-01)

Reference: 761 unique domains (mostly US Shopify stores) with Similarweb monthly visits collected
through Apify on 2026-09-23..29; 65 had no Similarweb value (0), leaving 696 comparable domains
(reference median ~4.9K visits; 76 <1K, 390 1K–10K, 203 10K–100K, 27 100K–1M). Similarweb is
itself a modelled estimate, so this measures agreement, not accuracy. The reference is used for
comparison only: nothing in the heuristics is fitted to it. Run with `benchmark submit|wait|report`
(README), collectors `lists,crawl,dns`, all five lists loaded; v1 and v2 are scored on the same
stored observations with the same feature code. (The first v1 run reported 64% in range: the
switched-off CDX collector then counted as missing evidence, which widened every range.)

| | MAE (log10) | bias | within ×3.2 | bucket exact | ±1 bucket | reference in our range | Spearman |
|---|---|---|---|---|---|---|---|
| answer the reference median for everyone | 0.53 | – | 59% | – | – | – | – |
| `heuristic_v1` | 0.42 | +0.15 | 68% | 59% | 99% | 61% | 0.66 |
| `heuristic_v2` | 0.42 | +0.17 | 69% | 61% | 99% | 79% | 0.67 |

Each v2 change on its own, applied to v1 (to explain the result, not to choose by it):

| | MAE | bias | bucket exact | Spearman | reference in range |
|---|---|---|---|---|---|
| v1 | 0.416 | +0.150 | 58.9% | 0.658 | 60.8% |
| + ranges ±0.5 | 0.416 | +0.150 | 58.9% | 0.658 | 79.9% |
| + Tranco absence cap (fired for 12 domains) | 0.415 | +0.149 | 58.9% | 0.658 | 60.8% |
| + both web-graph centralities | 0.417 | +0.173 | 60.8% | 0.671 | 60.3% |
| + verification/fresh-sitemap shifts (not shipped) | 0.457 | +0.297 | 56.0% | 0.689 | – |

The Tranco cap rarely binds here because the other signals already put most Tranco-absent stores
below 10^4.3; it matters for domains that link lists rate highly. The activity shifts were left out
for the prevalence reason above (they move almost every site); they do order sites better, which
is worth revisiting in a centred form.

What it showed:

- **Coverage**: the Common Crawl web graph covered 98% of these small sites (632 of 650 long-tail
  domains were outside its top 5M and found in the full file; the on-disk index now answers those
  directly and gives identical v1 results), Open PageRank 56%, Tranco's full list 23%, CrUX and
  Majestic 7–8%. Without the web graph and the full Tranco list almost every site would have hit
  the no-popularity cap.
- **Compression**: we overestimate the reference's smallest sites (reference <1K: bias +1.0) and
  underestimate its largest (100K–1M: −0.68); `log10(reference) ≈ −1.37 + 1.31 × log10(ours)`.
  Part of this is the reference's own noise at the low end, part is our curves being too flat.
- **Signals**: CrUX bucket agrees best where present (MAE 0.21, n=52), then Tranco (0.40, n=162);
  the web graph (0.49) and sitemap size (0.47) carry similar information for the long tail.
  Referring-domain curve reads low (bias −0.46). Unused features that track the reference about as
  well as the lists: presence in Tranco at all (Spearman 0.58), DNS verification-tag count (0.44),
  sitemap entries modified in the last 30 days (0.37), advertising tags (0.33), web-graph PageRank
  (0.46, vs 0.43 for the harmonic rank the heuristic uses).
- **Confidence** separates somewhat (v2 high: MAE 0.39, n=399; medium: 0.46, n=297); v1 ranges
  contained the reference 61% of the time, v2 ranges 79%.
- **Bugs found**: Hostinger's default nameservers (`dns-parking.com`) were treated as parking and
  capped two live stores at ~200 visits; fixed (DNS provider now, and a live crawl overrides
  DNS parking hints). A domain on registry `client hold` (NXDOMAIN) still had a Similarweb value:
  the reference lags.
- **What fitting would buy**: 5-fold cross-validation on these 696 domains: a linear
  recalibration of `heuristic_v1` → MAE 0.39; ridge regression or gradient boosting on all
  normalised features → MAE 0.35, Spearman 0.74, 76% within ×3.2. That is agreement with
  Similarweb on one population (small US e-commerce), not validated accuracy. Not applied, by
  decision: the reference is for comparison only.

## Training data (when it exists)

Schema `training_examples(domain, feature_snapshot, feature_version, actual_monthly_visits, source,
measurement_date, period_start, period_end)`. Legitimate sources: properties we own, owners who share
GA4 exports, server logs, other lawfully obtained datasets. Never scraped analytics, never third-party
estimates as labels. Plan: bucket classifier (gradient boosting; random forest / log-linear baselines),
then log-visits regression with calibrated intervals, evaluated with grouped CV by domain against
the heuristic baseline; only after that does `TE_MODEL_VERSION` move off the heuristic.
