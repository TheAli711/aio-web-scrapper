/**
 * Request/response schemas. Used for validation (Fastify + TypeBox) and to generate the OpenAPI
 * document served at /api/v1/openapi.json.
 */
import { Type, type Static } from "typebox";

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(t: T) => Type.Union([t, Type.Null()]);

export const Uuid = Type.String({ format: "uuid" });
export const IdParams = Type.Object({ id: Uuid });

export const ErrorBody = Type.Object(
  {
    error: Type.Object({
      code: Type.String({ description: "Stable machine-readable error code", examples: ["INVALID_URL"] }),
      message: Type.String(),
      details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      requestId: Type.String(),
    }),
  },
  { title: "Error" },
);

export const OutputFormat = Type.Union([Type.Literal("markdown"), Type.Literal("html"), Type.Literal("text"), Type.Literal("branding")], {
  description: "`branding` (scrape only) adds logo, favicon, brand colors and fonts; it loads the page in a browser and adds ~15-30 s.",
});

const ScrapeFields = {
  url: Type.String({ minLength: 1, maxLength: 2048, description: "http(s) URL to fetch", examples: ["https://example.com"] }),
  project_id: Type.Optional(
    Type.String({ format: "uuid", description: "Project to file the job under. Default: your oldest project (\"Default project\")." }),
  ),
  formats: Type.Optional(
    Type.Array(OutputFormat, { minItems: 1, maxItems: 4, uniqueItems: true, description: "Default: [\"markdown\"]" }),
  ),
  only_main_content: Type.Optional(Type.Boolean({ description: "Strip nav/footer boilerplate. Default true." })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, description: "Per-page timeout. Default 30000; server max applies." })),
  wait_for_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000, description: "Extra wait after load (<= timeout/2)." })),
};

export const ScrapeRequest = Type.Object(ScrapeFields, { additionalProperties: false, title: "ScrapeRequest" });
export type ScrapeRequest = Static<typeof ScrapeRequest>;

export const CrawlRequest = Type.Object(
  {
    ...ScrapeFields,
    max_depth: Type.Optional(Type.Integer({ minimum: 0, description: "Link depth from the start URL. Default 3." })),
    max_pages: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum pages to fetch. Default 200; server max applies (2000 by default)." })),
    include_patterns: Type.Optional(
      Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20, description: "Regexes matched against the URL path; only matching pages are crawled." }),
    ),
    exclude_patterns: Type.Optional(
      Type.Array(Type.String({ maxLength: 200 }), { maxItems: 20, description: "Regexes matched against the URL path; matching pages are skipped." }),
    ),
    allowed_domain: Type.Optional(
      Type.String({ maxLength: 253, description: "Confine the crawl to this domain (start host or a parent of it). Default: start host." }),
    ),
    allow_subdomains: Type.Optional(Type.Boolean({ description: "Also follow links to subdomains of allowed_domain. Default false." })),
  },
  { additionalProperties: false, title: "CrawlRequest" },
);
export type CrawlRequest = Static<typeof CrawlRequest>;

export const MapRequest = Type.Object(
  {
    url: ScrapeFields.url,
    limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum URLs to return. Default 5000; server max applies." })),
    include_patterns: CrawlRequest.properties.include_patterns,
    exclude_patterns: CrawlRequest.properties.exclude_patterns,
    allowed_domain: CrawlRequest.properties.allowed_domain,
    allow_subdomains: CrawlRequest.properties.allow_subdomains,
  },
  { additionalProperties: false, title: "MapRequest" },
);
export type MapRequest = Static<typeof MapRequest>;

export const MapBody = Type.Object(
  {
    url: Type.String({ description: "The start URL, normalised" }),
    platform: Nullable(
      Type.String({ description: "Store platform whose public catalog supplied product URLs: magento, shopify or woocommerce" }),
    ),
    product_urls: Type.Integer({ description: "How many of `urls` came from the store catalog" }),
    count: Type.Integer(),
    urls: Type.Array(Type.String(), {
      description: "Start URL first, then store catalog products, sitemap entries and links on the start page, deduplicated",
    }),
  },
  { title: "MapResult" },
);

export const ScrapeQuery = Type.Object({
  wait: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Block until the scrape finishes (up to timeout_ms + 30s) and return the job with the page content inline (HTTP 200). If it doesn't finish in time you get the usual 202 + job to poll.",
    }),
  ),
});

export const JobStatus = Type.Union(
  [Type.Literal("queued"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled")],
  { description: "queued -> running -> completed | failed | cancelled" },
);

export const JobBody = Type.Object(
  {
    id: Uuid,
    project_id: Uuid,
    type: Type.Union([Type.Literal("scrape"), Type.Literal("crawl")]),
    target_url: Type.String(),
    status: JobStatus,
    source: Type.Union([Type.Literal("dashboard"), Type.Literal("api")]),
    options: Type.Record(Type.String(), Type.Unknown()),
    progress: Type.Object({
      pages_discovered: Type.Integer(),
      pages_processed: Type.Integer(),
      pages_succeeded: Type.Integer(),
      pages_failed: Type.Integer(),
    }),
    error: Nullable(Type.Object({ code: Type.String(), message: Type.String() })),
    created_at: Type.String({ format: "date-time" }),
    started_at: Nullable(Type.String({ format: "date-time" })),
    completed_at: Nullable(Type.String({ format: "date-time" })),
    duration_ms: Nullable(Type.Integer()),
    links: Type.Object({ self: Type.String(), results: Type.String() }),
  },
  { title: "Job" },
);

export const ResultSummary = Type.Object(
  {
    id: Uuid,
    job_id: Uuid,
    project_id: Uuid,
    url: Type.String(),
    title: Nullable(Type.String()),
    status_code: Nullable(Type.Integer()),
    success: Type.Boolean(),
    error: Nullable(Type.Object({ code: Type.String(), message: Type.String() })),
    formats: Type.Array(Type.String()),
    content_bytes: Type.Integer(),
    truncated: Type.Boolean(),
    links_count: Type.Integer(),
    metadata: Type.Record(Type.String(), Type.Unknown()),
    created_at: Type.String({ format: "date-time" }),
  },
  { title: "ResultSummary" },
);

const Confidence = Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]);
const Hex = Nullable(Type.String({ description: "#RRGGBB" }));

export const Branding = Type.Object(
  {
    final_url: Nullable(Type.String()),
    site_name: Nullable(Type.String()),
    logo: Nullable(
      Type.Object({
        url: Nullable(Type.String({ description: "Logo image URL (or an SVG data URI for inline SVG logos)" })),
        image: Nullable(Type.String({ description: "PNG data URI of the logo as rendered on the page" })),
        source: Type.String({ description: "dom-img | dom-svg | dom-background | json-ld | icon" }),
        alt: Nullable(Type.String()),
        width: Nullable(Type.Integer()),
        height: Nullable(Type.Integer()),
        tone: Nullable(Type.Union([Type.Literal("dark"), Type.Literal("light"), Type.Literal("color")], { description: "dark = for light backgrounds, light = for dark backgrounds" })),
        colors: Type.Array(Type.String(), { description: "The logo's own colors, most prominent first" }),
        confidence: Confidence,
      }),
    ),
    favicon: Nullable(Type.Object({ url: Type.String(), sizes: Nullable(Type.String()), type: Nullable(Type.String()), source: Type.String() })),
    icons: Type.Array(Type.Object({ url: Type.String(), rel: Type.String(), sizes: Nullable(Type.String()), type: Nullable(Type.String()) })),
    colors: Type.Object({
      primary: Hex,
      secondary: Hex,
      accent: Hex,
      background: Hex,
      text: Hex,
      palette: Type.Array(Type.Object({ hex: Type.String(), weight: Type.Number(), sources: Type.Array(Type.String()) })),
      basis: Type.String({ description: "Signals behind the primary color, e.g. buttons+logo+header" }),
      confidence: Confidence,
    }),
    fonts: Type.Object({ heading: Nullable(Type.String()), body: Nullable(Type.String()) }),
    theme_color: Nullable(Type.String()),
    og_image: Nullable(Type.String()),
  },
  { title: "Branding" },
);

export const ResultContent = Type.Object({
  markdown: Type.Optional(Type.String()),
  html: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  links: Type.Optional(Type.Array(Type.String())),
  branding: Type.Optional(Nullable(Branding)),
  branding_error: Type.Optional(Nullable(Type.Object({ code: Type.String(), message: Type.String() }))),
});

export const ResultWithContent = Type.Intersect([ResultSummary, Type.Object({ content: Nullable(ResultContent) })], {
  title: "Result",
});

export const JobResultsQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  success: Type.Optional(Type.Boolean()),
  include_content: Type.Optional(Type.Boolean({ default: false, description: "Inline page content (markdown/html/text/links)." })),
});

export const JobResultsPage = Type.Object(
  {
    job: JobBody,
    data: Type.Array(Type.Union([ResultWithContent, ResultSummary])),
    pagination: Type.Object({ total: Type.Integer(), limit: Type.Integer(), offset: Type.Integer(), next_offset: Nullable(Type.Integer()) }),
  },
  { title: "JobResultsPage" },
);

export const Credentials = Type.Object(
  {
    email: Type.String({ format: "email", maxLength: 320 }),
    password: Type.String({ minLength: 10, maxLength: 200 }),
    name: Type.Optional(Type.String({ maxLength: 120 })),
  },
  { additionalProperties: false },
);

export const LoginBody = Type.Object(
  { email: Type.String({ maxLength: 320 }), password: Type.String({ maxLength: 200 }) },
  { additionalProperties: false },
);

export const ProjectCreate = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  },
  { additionalProperties: false },
);

export const ProjectUpdate = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    description: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  },
  { additionalProperties: false },
);

export const ApiKeyCreate = Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false });

export const JobListQuery = Type.Object({
  project_id: Type.Optional(Uuid),
  status: Type.Optional(JobStatus),
  type: Type.Optional(Type.Union([Type.Literal("scrape"), Type.Literal("crawl")])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  before: Type.Optional(Type.String({ format: "date-time" })),
});

export const DownloadQuery = Type.Object({
  format: Type.Optional(
    Type.Union([Type.Literal("markdown"), Type.Literal("html"), Type.Literal("text"), Type.Literal("json")], { default: "json" }),
  ),
});

export const ExportQuery = Type.Object({
  format: Type.Optional(Type.Union([Type.Literal("jsonl"), Type.Literal("json")], { default: "jsonl" })),
});

export const ScrapeSyncBody = Type.Object(
  { job: JobBody, result: Nullable(ResultWithContent) },
  { title: "ScrapeSyncResponse", description: "Returned by POST /scrape?wait=true when the job finished in time." },
);

// ------------------------------------------------------------------ traffic estimates

const TrafficDomain = Type.String({
  minLength: 1,
  maxLength: 2048,
  description: "A domain or URL. It is reduced to the registrable domain: `https://www.shop.example.co.uk/x` → `example.co.uk`.",
  examples: ["example.com"],
});
const Refresh = Type.Boolean({
  description: "Collect fresh data even if the domain was estimated in the last 7 days. Default false (reuse the recent estimate).",
});

export const TrafficRequest = Type.Object({ domain: TrafficDomain, refresh: Type.Optional(Refresh) }, { additionalProperties: false, title: "TrafficRequest" });
export type TrafficRequest = Static<typeof TrafficRequest>;

export const TrafficBulkRequest = Type.Object(
  { domains: Type.Array(TrafficDomain, { minItems: 1, maxItems: 100 }), refresh: Type.Optional(Refresh) },
  { additionalProperties: false, title: "TrafficBulkRequest" },
);
export type TrafficBulkRequest = Static<typeof TrafficBulkRequest>;

const TrafficDetails = Type.Optional(
  Type.Boolean({ default: false, description: "Include `estimate.details`, the per-signal breakdown (diagnostic; its shape may change)." }),
);

export const TrafficCreateQuery = Type.Object({
  wait: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Block until the estimate is ready (a new domain takes 10-30 s; at most 60 s) and return it with HTTP 200. If it is not ready in time you get 202 with `status: pending`; poll `GET /traffic/{domain}`.",
    }),
  ),
  details: TrafficDetails,
});

export const TrafficGetQuery = Type.Object({ details: TrafficDetails });
export const TrafficParams = Type.Object({ domain: Type.String({ minLength: 1, maxLength: 253, examples: ["example.com"] }) });

export const TrafficEstimateBody = Type.Object(
  {
    estimated_monthly_visits: Nullable(Type.Integer({ description: "Point estimate of monthly visits (all devices, worldwide)" })),
    lower_bound: Nullable(Type.Integer({ description: "Low end of the plausible range" })),
    upper_bound: Nullable(Type.Integer({ description: "High end of the plausible range" })),
    traffic_bucket: Type.String({ description: "`<1K`, `1K-10K`, `10K-100K`, `100K-1M`, `1M-10M` or `10M+` monthly visits" }),
    confidence: Confidence,
    confidence_score: Type.Number({ minimum: 0, maximum: 1, description: "How much evidence backs the estimate (not how large it is)" }),
    model_version: Type.String({ description: "Estimator that produced it, e.g. `heuristic_v2`" }),
    generated_at: Type.String({ format: "date-time" }),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Only with `details=true`" })),
  },
  { title: "TrafficEstimate" },
);

const TrafficStatus = Type.Union([Type.Literal("pending"), Type.Literal("ready"), Type.Literal("failed")], {
  description: "pending: being estimated; ready: `estimate` is set; failed: estimation failed and there is no earlier estimate",
});
const TrafficFields = {
  domain: Type.String({ description: "Registrable domain the estimate is for" }),
  status: TrafficStatus,
  refreshing: Type.Boolean({ description: "A newer estimate is being computed; `estimate` is the previous one" }),
  estimate: Nullable(TrafficEstimateBody),
  error: Nullable(Type.Object({ code: Type.String(), message: Type.String() })),
};

export const TrafficBody = Type.Object(
  {
    ...TrafficFields,
    disclaimer: Type.String(),
    links: Type.Object({ self: Type.String() }),
  },
  { title: "Traffic" },
);

export const TrafficBulkBody = Type.Object(
  {
    data: Type.Array(
      Type.Object({
        input: Type.String({ description: "The string you sent" }),
        domain: Nullable(Type.String()),
        status: Type.Union([TrafficStatus, Type.Literal("invalid")]),
        refreshing: Type.Boolean(),
        estimate: Nullable(TrafficEstimateBody),
        error: Nullable(Type.Object({ code: Type.String(), message: Type.String() })),
        links: Nullable(Type.Object({ self: Type.String() })),
      }),
    ),
    disclaimer: Type.String(),
  },
  { title: "TrafficBulk" },
);
