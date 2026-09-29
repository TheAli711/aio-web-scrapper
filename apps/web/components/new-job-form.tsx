"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ErrorBox } from "@/components/error-box";
import { MapResultView } from "@/components/map-result";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/field";
import { Tabs } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { CrawlRequest, JobType, MapRequest, MapResult, OutputFormat, ScrapeRequest, UrlScope } from "@/lib/types";

/** Map is not a job: it runs synchronously and its result is shown inline. */
type Mode = JobType | "map";

const DESCRIPTIONS: Record<Mode, string> = {
  scrape: "Fetch a single page and convert it to the selected formats.",
  crawl: "Start at a URL and follow links within the allowed domain, up to the depth and page limits.",
  map: "List a site's URLs without scraping them. For Magento, Shopify and WooCommerce stores, product pages come from the store's catalog.",
};

const SUBMIT_LABELS: Record<Mode, string> = { scrape: "Start scrape", crawl: "Start crawl", map: "Map URLs" };

const FORMATS: OutputFormat[] = ["markdown", "html", "text", "branding"];
/** Branding extraction is scrape-only; the API rejects it for crawls. */
const SCRAPE_ONLY_FORMATS: OutputFormat[] = ["branding"];
const FORMAT_LABELS: Partial<Record<OutputFormat, string>> = { branding: "Branding (logo, colors)" };

function lines(s: string): string[] {
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function invalidRegexes(patterns: string[]): string[] {
  return patterns.filter((p) => {
    try {
      new RegExp(p);
      return false;
    } catch {
      return true;
    }
  });
}

/** Parse an optional positive integer field. Returns undefined when blank, null when invalid. */
function optInt(v: string, min: number): number | undefined | null {
  if (!v.trim()) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= min ? n : null;
}

export function NewJobForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("scrape");
  const [url, setUrl] = useState("");
  const [formats, setFormats] = useState<OutputFormat[]>(["markdown"]);
  const [onlyMain, setOnlyMain] = useState(true);
  const [timeoutSec, setTimeoutSec] = useState("");
  const [maxDepth, setMaxDepth] = useState("");
  const [maxPages, setMaxPages] = useState("");
  const [mapLimit, setMapLimit] = useState("");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [allowedDomain, setAllowedDomain] = useState("");
  const [allowSubdomains, setAllowSubdomains] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [mapResult, setMapResult] = useState<MapResult | null>(null);

  const toggleFormat = (f: OutputFormat, on: boolean) =>
    setFormats((cur) => (on ? FORMATS.filter((x) => x === f || cur.includes(x)) : cur.filter((x) => x !== f)));

  const changeMode = (m: Mode) => {
    setMode(m);
    setError(null);
    setFieldErrors({});
    if (m === "crawl") setFormats((cur) => cur.filter((x) => !SCRAPE_ONLY_FORMATS.includes(x)));
  };

  const availableFormats = mode === "crawl" ? FORMATS.filter((f) => !SCRAPE_ONLY_FORMATS.includes(f)) : FORMATS;

  /** URL filters shared by crawl and map; problems are recorded in `errs`. */
  const scopeFields = (errs: Record<string, string>): UrlScope => {
    const inc = lines(include);
    const exc = lines(exclude);
    const badInc = invalidRegexes(inc);
    const badExc = invalidRegexes(exc);
    if (badInc.length) errs.include = `Invalid regex: ${badInc.join(", ")}`;
    if (badExc.length) errs.exclude = `Invalid regex: ${badExc.join(", ")}`;
    const scope: UrlScope = { allow_subdomains: allowSubdomains };
    if (inc.length) scope.include_patterns = inc;
    if (exc.length) scope.exclude_patterns = exc;
    if (allowedDomain.trim()) scope.allowed_domain = allowedDomain.trim();
    return scope;
  };

  const submitMap = async () => {
    const errs: Record<string, string> = {};
    const limit = optInt(mapLimit, 1);
    if (limit === null) errs.limit = "Whole number, 1 or more.";
    const body: MapRequest = { url: url.trim(), ...scopeFields(errs) };
    if (limit !== undefined && limit !== null) body.limit = limit;

    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setBusy(true);
    setMapResult(null);
    try {
      setMapResult(await api.map(body));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === "map") return submitMap();

    const errs: Record<string, string> = {};
    if (formats.length === 0) errs.formats = "Select at least one output format.";
    const timeout = optInt(timeoutSec, 1);
    if (timeout === null) errs.timeout = "Whole number of seconds, at least 1.";

    const base: ScrapeRequest = { url: url.trim(), project_id: projectId, formats, only_main_content: onlyMain };
    if (timeout !== undefined && timeout !== null) base.timeout_ms = timeout * 1000;

    let body: ScrapeRequest | CrawlRequest = base;
    if (mode === "crawl") {
      const depth = optInt(maxDepth, 0);
      const pages = optInt(maxPages, 1);
      if (depth === null) errs.maxDepth = "Whole number, 0 or more.";
      if (pages === null) errs.maxPages = "Whole number, 1 or more.";
      const crawl: CrawlRequest = { ...base, ...scopeFields(errs) };
      if (depth !== undefined && depth !== null) crawl.max_depth = depth;
      if (pages !== undefined && pages !== null) crawl.max_pages = pages;
      body = crawl;
    }

    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setBusy(true);
    try {
      const job = mode === "crawl" ? await api.crawl(body) : await api.scrape(body);
      router.push(`/jobs/${job.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <Tabs
        items={[
          { id: "scrape", label: "Scrape" },
          { id: "crawl", label: "Crawl" },
          { id: "map", label: "Map" },
        ]}
        value={mode}
        onChange={changeMode}
      />
      <p className="text-xs text-muted">{DESCRIPTIONS[mode]}</p>

      <Field label={mode === "scrape" ? "URL" : "Start URL"} htmlFor="job-url">
        <Input
          id="job-url"
          type="url"
          inputMode="url"
          required
          placeholder="https://example.com"
          className="font-mono"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </Field>

      {mode !== "map" && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Output formats"
              hint={mode === "scrape" ? "Branding adds ~15–30 s. Scrape only." : undefined}
              error={fieldErrors.formats}
            >
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
                {availableFormats.map((f) => (
                  <Checkbox
                    key={f}
                    id={`fmt-${f}`}
                    label={FORMAT_LABELS[f] ?? f}
                    checked={formats.includes(f)}
                    onChange={(e) => toggleFormat(f, e.target.checked)}
                  />
                ))}
              </div>
            </Field>
            <Field label="Timeout (seconds)" htmlFor="job-timeout" hint="Per page. Blank = server default (30 s)." error={fieldErrors.timeout}>
              <Input
                id="job-timeout"
                type="number"
                min={1}
                step={1}
                placeholder="30"
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(e.target.value)}
              />
            </Field>
          </div>

          <Checkbox
            id="only-main"
            label="Only main content (strip navigation, headers and footers)"
            checked={onlyMain}
            onChange={(e) => setOnlyMain(e.target.checked)}
          />
        </>
      )}

      {mode !== "scrape" && (
        <div className={cn("space-y-3", mode === "crawl" && "border-t border-line pt-3")}>
          <div className="grid gap-3 sm:grid-cols-2">
            {mode === "map" ? (
              <Field label="Limit" htmlFor="map-limit" hint="Default 5000; the server may cap this." error={fieldErrors.limit}>
                <Input
                  id="map-limit"
                  type="number"
                  min={1}
                  step={1}
                  placeholder="5000"
                  value={mapLimit}
                  onChange={(e) => setMapLimit(e.target.value)}
                />
              </Field>
            ) : (
              <>
                <Field label="Max depth" htmlFor="max-depth" hint="Link depth from the start URL. Default 3." error={fieldErrors.maxDepth}>
                  <Input
                    id="max-depth"
                    type="number"
                    min={0}
                    step={1}
                    placeholder="3"
                    value={maxDepth}
                    onChange={(e) => setMaxDepth(e.target.value)}
                  />
                </Field>
                <Field label="Max pages" htmlFor="max-pages" hint="Default 200; the server may cap this." error={fieldErrors.maxPages}>
                  <Input
                    id="max-pages"
                    type="number"
                    min={1}
                    step={1}
                    placeholder="200"
                    value={maxPages}
                    onChange={(e) => setMaxPages(e.target.value)}
                  />
                </Field>
              </>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Include patterns"
              htmlFor="include"
              hint={`One regex per line, matched against the URL path. Only matching ${mode === "map" ? "URLs are listed" : "pages are crawled"}.`}
              error={fieldErrors.include}
            >
              <Textarea
                id="include"
                rows={3}
                className="font-mono text-xs"
                placeholder={"^/blog/"}
                value={include}
                onChange={(e) => setInclude(e.target.value)}
              />
            </Field>
            <Field
              label="Exclude patterns"
              htmlFor="exclude"
              hint={`One regex per line. Matching ${mode === "map" ? "URLs are left out" : "pages are skipped"}.`}
              error={fieldErrors.exclude}
            >
              <Textarea
                id="exclude"
                rows={3}
                className="font-mono text-xs"
                placeholder={"/tag/\n\\.pdf$"}
                value={exclude}
                onChange={(e) => setExclude(e.target.value)}
              />
            </Field>
          </div>
          <div className="grid items-end gap-3 sm:grid-cols-2">
            <Field label="Allowed domain" htmlFor="allowed-domain" hint="Default: the start URL's host.">
              <Input
                id="allowed-domain"
                placeholder="example.com"
                className="font-mono"
                value={allowedDomain}
                onChange={(e) => setAllowedDomain(e.target.value)}
              />
            </Field>
            <Checkbox
              id="allow-subdomains"
              className="pb-6"
              label="Allow subdomains"
              checked={allowSubdomains}
              onChange={(e) => setAllowSubdomains(e.target.checked)}
            />
          </div>
        </div>
      )}

      <ErrorBox error={error} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button type="submit" variant="primary" disabled={busy || !url.trim()}>
          {busy ? (mode === "map" ? "Mapping…" : "Starting…") : SUBMIT_LABELS[mode]}
        </Button>
        {busy && mode === "map" && <span className="text-xs text-muted">This usually takes 5–20 seconds.</span>}
      </div>

      {mode === "map" && mapResult && <MapResultView result={mapResult} />}
    </form>
  );
}
