/**
 * ScrapingEngine: the only boundary between our product layer and the scraping backend.
 *
 * Today the sole implementation is FirecrawlEngine (HTTP adapter to a self-hosted Firecrawl).
 * Later phases can wrap it (reliability / retries / proxy routing) or replace it
 * (own browser orchestration) without touching routes, persistence or the dashboard.
 *
 * All engine-originated failures are normalised to our ErrorCode vocabulary here, so no
 * upstream error strings or internal hostnames leak to users.
 */
import type { ErrorCode } from "../lib/errors.js";
import type { CrawlJobOptions, OutputFormat, ScrapeJobOptions } from "../domain.js";

export interface EngineError {
  code: ErrorCode;
  message: string;
}

export interface PageResult {
  /** URL as requested / discovered. */
  url: string;
  /** Final URL after redirects, when known. */
  finalUrl?: string;
  statusCode?: number;
  title?: string;
  contentType?: string;
  success: boolean;
  error?: EngineError;
  markdown?: string;
  html?: string;
  text?: string;
  links?: string[];
  /** Small, bounded metadata (description, language, og tags ...). */
  metadata: Record<string, unknown>;
}

export type EngineJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface CrawlSnapshot {
  status: EngineJobStatus;
  /** Pages the engine knows about (queued + done). */
  discovered: number;
  /** Pages the engine has finished (success or failure). */
  processed: number;
  /** Successful page documents after `cursor`, in engine order. */
  pages: PageResult[];
  /** Cursor to pass on the next call to continue after the returned pages. */
  nextCursor: number;
  /** True when more pages are available right now beyond nextCursor. */
  hasMore: boolean;
  error?: EngineError;
}

export interface ScrapingEngine {
  readonly name: string;

  /** Scrape a single URL. Resolves with a PageResult (success or failure); rejects only on programmer error. */
  scrape(url: string, options: ScrapeJobOptions, signal?: AbortSignal): Promise<PageResult>;

  /** Start an asynchronous crawl; returns the engine's job id. */
  crawl(url: string, options: CrawlJobOptions): Promise<{ engineJobId: string }>;

  /** Crawl progress plus the next batch of successful pages after `cursor`. */
  getJobStatus(engineJobId: string, cursor: number): Promise<CrawlSnapshot>;

  /** Pages the engine failed to fetch (network / timeout / blocked), for terminal bookkeeping. */
  getFailures(engineJobId: string): Promise<PageResult[]>;

  cancel(engineJobId: string): Promise<void>;

  health(): Promise<boolean>;
}

export type { OutputFormat };
