import { randomUUID } from "node:crypto";
import { convert } from "html-to-text";
import type { Db, DbClient } from "../db/pool.js";
import { results as resultsRepo } from "../db/repos.js";
import type { Job, OutputFormat, ResultContent, ResultRow } from "../domain.js";
import type { PageResult } from "../engine/types.js";
import type { ObjectStorage } from "../storage/object-storage.js";
import { AppError } from "../lib/errors.js";

const MAX_METADATA_KEYS = 40;
const MAX_METADATA_VALUE = 1000;
const MAX_LINKS = 5000;

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      // Keep original casing (the library upper-cases headings and table headers by default).
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({ selector, options: { uppercase: false } })),
      { selector: "table", options: { uppercaseHeaderCells: false } },
    ],
  });
}

/** Keep metadata small and JSON-safe: primitives / short string arrays only. */
export function sanitizeMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (Object.keys(out).length >= MAX_METADATA_KEYS) break;
    if (k.length > 100) continue;
    if (typeof v === "string") out[k] = v.slice(0, MAX_METADATA_VALUE);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (Array.isArray(v)) {
      const arr = v.filter((x) => typeof x === "string").slice(0, 20) as string[];
      if (arr.length) out[k] = arr.map((s) => s.slice(0, MAX_METADATA_VALUE));
    }
  }
  return out;
}

/**
 * Enforce the per-result byte budget. Fields are trimmed in order of least value first
 * (html, then text, then markdown), so the most useful representation survives.
 */
export function applySizeLimit(content: ResultContent, maxBytes: number): { content: ResultContent; truncated: boolean } {
  if (Buffer.byteLength(JSON.stringify(content)) <= maxBytes) return { content, truncated: false };
  const c: ResultContent = { ...content };
  const size = () => Buffer.byteLength(JSON.stringify(c));
  if (c.links && c.links.length > 1000) c.links = c.links.slice(0, 1000);
  // The rendered logo PNG is a convenience copy; the logo URL survives.
  if (c.branding?.logo?.image && size() > maxBytes) c.branding = { ...c.branding, logo: { ...c.branding.logo, image: null } };
  for (const field of ["html", "text", "markdown"] as const) {
    const over = size() - maxBytes;
    if (over <= 0) break;
    const val = c[field];
    if (!val) continue;
    const keep = Math.max(0, Buffer.byteLength(val) - over - 64);
    // Slice by bytes then drop any trailing partial UTF-8 sequence.
    c[field] = Buffer.from(val).subarray(0, keep).toString("utf8").replace(/�+$/, "");
  }
  if (size() > maxBytes) c.links = [];
  return { content: c, truncated: true };
}

export function contentKey(job: Pick<Job, "user_id" | "id">, resultId: string): string {
  return `users/${job.user_id}/jobs/${job.id}/${resultId}.json`;
}

export class ResultService {
  constructor(
    private readonly db: Db,
    private readonly storage: ObjectStorage,
    private readonly maxResultBytes: number,
  ) {}

  /**
   * Persist one page: body to object storage, metadata to Postgres. Idempotent per (job, url).
   * Returns true if a new row was written.
   */
  async persistPage(job: Job, page: PageResult, formats: OutputFormat[], client: DbClient = this.db): Promise<boolean> {
    const id = randomUUID();
    let storageKey: string | null = null;
    let bytes = 0;
    let truncated = false;
    let linksCount = 0;

    // Keep bodies of HTTP-error pages too (e.g. a 404 page); they are useful for debugging.
    const hasContent = page.markdown !== undefined || page.html !== undefined || page.text !== undefined;
    if (hasContent) {
      const raw: ResultContent = {};
      if (formats.includes("markdown")) raw.markdown = page.markdown ?? "";
      if (formats.includes("html")) raw.html = page.html ?? "";
      if (formats.includes("text")) raw.text = page.text ?? (page.html ? htmlToText(page.html) : page.markdown ?? "");
      if (page.links) raw.links = page.links.slice(0, MAX_LINKS);
      if (formats.includes("branding")) {
        raw.branding = page.branding?.ok ? page.branding.branding : null;
        raw.branding_error = page.branding && !page.branding.ok ? page.branding.error : null;
      }
      linksCount = page.links?.length ?? 0;
      const limited = applySizeLimit(raw, this.maxResultBytes);
      truncated = limited.truncated;
      const body = JSON.stringify(limited.content);
      bytes = Buffer.byteLength(body);
      storageKey = contentKey(job, id);
      await this.storage.put(storageKey, body, "application/json");
    }

    const inserted = await resultsRepo.insert(client, {
      id,
      jobId: job.id,
      projectId: job.project_id,
      userId: job.user_id,
      url: page.url.slice(0, 4096),
      title: page.title?.slice(0, 500) ?? null,
      statusCode: page.statusCode ?? null,
      success: page.success,
      errorCode: page.error?.code ?? null,
      errorMessage: page.error?.message?.slice(0, 1000) ?? null,
      contentType: page.contentType ?? null,
      formats: hasContent ? formats : [],
      storageKey,
      contentBytes: bytes,
      truncated,
      linksCount,
      metadata: sanitizeMetadata({ ...page.metadata, ...(page.finalUrl ? { finalUrl: page.finalUrl } : {}) }),
    });
    if (!inserted && storageKey) await this.storage.delete(storageKey).catch(() => {});
    return inserted !== null;
  }

  async loadContent(row: ResultRow): Promise<ResultContent> {
    if (!row.storage_key) return {};
    const buf = await this.storage.get(row.storage_key);
    if (!buf) throw new AppError("NOT_FOUND", "Result content is no longer available");
    return JSON.parse(buf.toString("utf8")) as ResultContent;
  }
}
