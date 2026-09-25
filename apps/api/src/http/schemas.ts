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
    max_pages: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum pages to fetch. Default 50." })),
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
