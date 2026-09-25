"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, type ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { ErrorBox } from "@/components/error-box";
import { DefinitionList, Empty, Loading, PageHeader } from "@/components/states";
import { ResultBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { ButtonAnchor } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { paths, type ResultWithContent } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import type { Branding, Confidence, ErrorInfo, ResultContent } from "@/lib/types";
import { isHttpUrl } from "@/lib/url";
import { useApi } from "@/lib/use-api";

type TabId = "markdown" | "html" | "text" | "links" | "branding" | "metadata";

function availableTabs(content: ResultContent | null): TabItem<TabId>[] {
  const tabs: TabItem<TabId>[] = [];
  if (content?.markdown !== undefined) tabs.push({ id: "markdown", label: "Markdown" });
  if (content?.html !== undefined) tabs.push({ id: "html", label: "HTML" });
  if (content?.text !== undefined) tabs.push({ id: "text", label: "Text" });
  if (content?.links !== undefined) tabs.push({ id: "links", label: `Links (${content.links.length})` });
  if (content?.branding !== undefined) tabs.push({ id: "branding", label: "Branding" });
  tabs.push({ id: "metadata", label: "Metadata" });
  return tabs;
}

function Toolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 border-b border-line px-3 py-2">{children}</div>;
}

function ContentPre({ text }: { text: string }) {
  if (!text) return <Empty>This format is empty for this page.</Empty>;
  return (
    <pre className="max-h-[70vh] overflow-auto p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
      {text}
    </pre>
  );
}

function TextTab({ resultId, format, text }: { resultId: string; format: "markdown" | "text"; text: string }) {
  return (
    <>
      <Toolbar>
        <CopyButton text={text} />
        <ButtonAnchor size="sm" href={paths.resultDownload(resultId, format)} download>
          Download {format === "markdown" ? ".md" : ".txt"}
        </ButtonAnchor>
      </Toolbar>
      <ContentPre text={text} />
    </>
  );
}

function HtmlTab({ resultId, html }: { resultId: string; html: string }) {
  const [view, setView] = useState<"source" | "preview">("source");
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <Tabs
          size="sm"
          className="border-b-0"
          items={[
            { id: "source", label: "Source" },
            { id: "preview", label: "Preview" },
          ]}
          value={view}
          onChange={setView}
        />
        <div className="flex flex-wrap gap-2">
          <CopyButton text={html} />
          <ButtonAnchor size="sm" href={paths.resultDownload(resultId, "html")} download>
            Download .html
          </ButtonAnchor>
        </div>
      </div>
      {view === "source" ? (
        <ContentPre text={html} />
      ) : (
        <div className="p-3">
          <p className="mb-2 text-xs text-muted">
            Sandboxed preview: scripts, forms and same-origin access are disabled. External images and styles may still load.
          </p>
          {/* sandbox="" = no allow-scripts, no allow-same-origin, no forms/popups/top navigation. */}
          <iframe
            title="HTML preview"
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={html}
            className="h-[70vh] w-full rounded-sm border border-line bg-white"
          />
        </div>
      )}
    </>
  );
}

function LinksTab({ links }: { links: string[] }) {
  return (
    <>
      <Toolbar>
        <CopyButton text={links.join("\n")} label="Copy all" />
      </Toolbar>
      {links.length === 0 ? (
        <Empty>No links were found on this page.</Empty>
      ) : (
        <ol className="max-h-[70vh] divide-y divide-line overflow-auto">
          {links.map((l, i) => (
            <li key={`${i}-${l}`} className="flex gap-3 px-3 py-1">
              <span className="w-8 shrink-0 text-right font-mono text-xs text-muted tabular-nums">{i + 1}</span>
              {isHttpUrl(l) ? (
                <a href={l} target="_blank" rel="noopener noreferrer" className="link min-w-0 font-mono text-xs break-all">
                  {l}
                </a>
              ) : (
                <span className="min-w-0 font-mono text-xs break-all">{l}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

const HEX_RE = /^#[0-9a-f]{6}$/i;
const CHECKERBOARD = {
  backgroundImage: "repeating-conic-gradient(#e5e5e5 0 25%, #ffffff 0 50%)",
  backgroundSize: "16px 16px",
};

/** Only http(s) URLs and raster/SVG data URIs are ever used as <img> sources (SVG in <img> cannot run scripts). */
function safeImageSrc(u: string | null | undefined): string | null {
  if (!u) return null;
  if (u.startsWith("data:image/")) return u;
  return isHttpUrl(u) ? u : null;
}

function confidenceTone(c: Confidence) {
  return c === "high" ? "green" : c === "medium" ? "amber" : "gray";
}

function ExternalUrl({ url }: { url: string }) {
  if (url.startsWith("data:")) return <span className="font-mono text-xs text-muted">inline data URI</span>;
  return isHttpUrl(url) ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className="link font-mono text-xs break-all">
      {url}
    </a>
  ) : (
    <span className="font-mono text-xs break-all">{url}</span>
  );
}

function Swatch({ hex, size = "size-4" }: { hex: string; size?: string }) {
  return (
    <span
      className={`inline-block shrink-0 rounded-sm border border-line-strong ${size}`}
      style={{ backgroundColor: HEX_RE.test(hex) ? hex : "transparent" }}
    />
  );
}

function ColorRole({ role, hex }: { role: string; hex: string | null }) {
  return (
    <div className="min-w-0 rounded-md border border-line">
      <div
        className="h-12 rounded-t-md border-b border-line"
        style={hex && HEX_RE.test(hex) ? { backgroundColor: hex } : CHECKERBOARD}
      />
      <div className="flex items-center justify-between gap-1 px-2 py-1.5">
        <div className="min-w-0">
          <div className="text-xs text-muted capitalize">{role}</div>
          <code className="text-xs">{hex ?? "—"}</code>
        </div>
        {hex && <CopyButton text={hex} variant="ghost" />}
      </div>
    </div>
  );
}

function BrandingSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-b border-line p-3 last:border-b-0">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function BrandingTab({ branding, error }: { branding: Branding | null; error: ErrorInfo | null | undefined }) {
  if (branding === null) {
    return (
      <div className="p-3">
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <div className="flex flex-wrap items-baseline gap-x-2">
            {error?.code && <code className="text-xs font-semibold">{error.code}</code>}
            <span>{error?.message ?? "Branding extraction failed for this page."}</span>
          </div>
        </div>
      </div>
    );
  }

  const { logo, favicon, colors, fonts } = branding;
  const logoSrc = safeImageSrc(logo?.image) ?? safeImageSrc(logo?.url);
  const faviconSrc = safeImageSrc(favicon?.url);
  const roles = ["primary", "secondary", "accent", "background", "text"] as const;

  return (
    <>
      <Toolbar>
        <CopyButton text={JSON.stringify(branding, null, 2)} label="Copy JSON" />
      </Toolbar>

      <BrandingSection title="Logo">
        {!logo ? (
          <p className="text-sm text-muted">No logo was detected.</p>
        ) : (
          <div className="space-y-2">
            {logoSrc ? (
              <div className="flex flex-wrap gap-2">
                <div
                  className="flex h-32 min-w-[200px] items-center justify-center rounded-md border border-line p-3"
                  style={CHECKERBOARD}
                >
                  <img
                    src={logoSrc}
                    alt={logo.alt ?? "Logo"}
                    referrerPolicy="no-referrer"
                    className="max-h-full max-w-[320px] object-contain"
                  />
                </div>
                {logo.tone === "light" && (
                  <div className="flex h-32 min-w-[200px] items-center justify-center rounded-md border border-line bg-neutral-900 p-3">
                    <img
                      src={logoSrc}
                      alt={`${logo.alt ?? "Logo"} on dark background`}
                      referrerPolicy="no-referrer"
                      className="max-h-full max-w-[320px] object-contain"
                    />
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted">The logo has no displayable image.</p>
            )}
            <DefinitionList
              items={[
                ["Source", <code key="s" className="text-xs">{logo.source}</code>],
                ["Confidence", <Badge key="c" tone={confidenceTone(logo.confidence)}>{logo.confidence}</Badge>],
                ["Tone", logo.tone ?? "—"],
                ["Size", logo.width && logo.height ? `${logo.width} × ${logo.height}` : "—"],
                ["Alt text", logo.alt ?? "—"],
                ["URL", logo.url ? <ExternalUrl key="u" url={logo.url} /> : "—"],
                [
                  "Logo colors",
                  logo.colors.length ? (
                    <span key="lc" className="flex flex-wrap gap-2">
                      {logo.colors.map((h) => (
                        <span key={h} className="inline-flex items-center gap-1">
                          <Swatch hex={h} />
                          <code className="text-xs">{h}</code>
                        </span>
                      ))}
                    </span>
                  ) : (
                    "—"
                  ),
                ],
              ]}
            />
          </div>
        )}
      </BrandingSection>

      <BrandingSection title="Favicon">
        {!favicon ? (
          <p className="text-sm text-muted">No favicon was detected.</p>
        ) : (
          <div className="flex items-center gap-3">
            {faviconSrc && (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-sm border border-line" style={CHECKERBOARD}>
                <img src={faviconSrc} alt="Favicon" referrerPolicy="no-referrer" className="size-8 object-contain" />
              </div>
            )}
            <div className="min-w-0 space-y-0.5">
              <ExternalUrl url={favicon.url} />
              <div className="text-xs text-muted">
                {[favicon.type, favicon.sizes, favicon.source].filter(Boolean).join(" · ")}
              </div>
            </div>
          </div>
        )}
      </BrandingSection>

      <BrandingSection title="Colors">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {roles.map((role) => (
            <ColorRole key={role} role={role} hex={colors[role]} />
          ))}
        </div>
        {colors.palette.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs text-muted">Palette</div>
            <div className="flex flex-wrap gap-1.5">
              {colors.palette.map((p) => (
                <span
                  key={p.hex}
                  className="inline-flex items-center gap-1 rounded-sm border border-line px-1 py-0.5"
                  title={`${p.hex} · weight ${p.weight}${p.sources.length ? ` · ${p.sources.join(", ")}` : ""}`}
                >
                  <Swatch hex={p.hex} size="size-3.5" />
                  <code className="text-xs">{p.hex}</code>
                </span>
              ))}
            </div>
          </div>
        )}
        <p className="text-xs text-muted">
          Basis: <code>{colors.basis}</code> · Confidence{" "}
          <Badge tone={confidenceTone(colors.confidence)}>{colors.confidence}</Badge>
        </p>
      </BrandingSection>

      <BrandingSection title="Details">
        <DefinitionList
          items={[
            ["Site name", branding.site_name ?? "—"],
            ["Final URL", branding.final_url ? <ExternalUrl key="f" url={branding.final_url} /> : "—"],
            ["Heading font", fonts.heading ?? "—"],
            ["Body font", fonts.body ?? "—"],
            [
              "Theme color",
              branding.theme_color ? (
                <span key="t" className="inline-flex items-center gap-1">
                  <Swatch hex={branding.theme_color} />
                  <code className="text-xs">{branding.theme_color}</code>
                </span>
              ) : (
                "—"
              ),
            ],
            ["OG image", branding.og_image ? <ExternalUrl key="o" url={branding.og_image} /> : "—"],
            [
              "Icons",
              branding.icons.length ? (
                <ul key="i" className="space-y-0.5">
                  {branding.icons.map((ic, i) => (
                    <li key={`${i}-${ic.url}`} className="flex flex-wrap items-baseline gap-x-2">
                      <code className="text-xs text-muted">{ic.rel}</code>
                      <ExternalUrl url={ic.url} />
                      {ic.sizes && <span className="text-xs text-muted">{ic.sizes}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                "—"
              ),
            ],
          ]}
        />
      </BrandingSection>
    </>
  );
}

function renderValue(v: unknown): ReactNode {
  if (v === null || v === undefined) return <span className="text-muted">—</span>;
  if (typeof v === "string") return <span className="break-words">{v}</span>;
  if (typeof v === "number" || typeof v === "boolean") return <code className="text-xs">{String(v)}</code>;
  return <code className="text-xs break-all">{JSON.stringify(v)}</code>;
}

function MetadataTab({ result }: { result: ResultWithContent }) {
  const entries = Object.entries(result.metadata ?? {});
  const raw = JSON.stringify(result.metadata ?? {}, null, 2);
  return (
    <>
      <Toolbar>
        <CopyButton text={raw} label="Copy JSON" />
      </Toolbar>
      {entries.length === 0 ? (
        <Empty>No metadata was extracted for this page.</Empty>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH className="w-[220px]">Key</TH>
              <TH>Value</TH>
            </tr>
          </THead>
          <TBody>
            {entries.map(([k, v]) => (
              <TR key={k}>
                <TD className="align-top font-mono text-xs whitespace-nowrap">{k}</TD>
                <TD className="max-w-[640px]">{renderValue(v)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <details className="border-t border-line px-3 py-2">
        <summary className="cursor-pointer text-xs text-muted">Raw JSON</summary>
        <pre className="mt-1 max-h-[50vh] overflow-auto rounded-sm bg-subtle p-2 text-xs">{raw}</pre>
      </details>
    </>
  );
}

export default function ResultPage() {
  const { id } = useParams<{ id: string }>();
  const res = useApi<ResultWithContent>(paths.result(id));
  const r = res.data;
  const tabs = availableTabs(r?.content ?? null);
  const [picked, setPicked] = useState<TabId | null>(null);
  const tab: TabId = picked && tabs.some((t) => t.id === picked) ? picked : (tabs[0]?.id ?? "metadata");

  if (!r) {
    return res.error ? (
      <div className="space-y-3">
        <ErrorBox error={res.error} />
        <Link href="/results" className="link text-sm">
          Back to results
        </Link>
      </div>
    ) : (
      <Loading />
    );
  }

  const c = r.content;

  return (
    <>
      <div className="mb-2 text-xs text-muted">
        <Link href="/results" className="hover:underline">
          Results
        </Link>{" "}
        /{" "}
        <Link href={`/jobs/${r.job_id}`} className="hover:underline">
          Job <code>{r.job_id.slice(0, 8)}</code>
        </Link>
      </div>
      <PageHeader
        title={r.title || <span className="text-muted">Untitled page</span>}
        description={
          isHttpUrl(r.url) ? (
            <a href={r.url} target="_blank" rel="noopener noreferrer" className="link font-mono text-xs break-all">
              {r.url}
            </a>
          ) : (
            <span className="font-mono text-xs break-all">{r.url}</span>
          )
        }
        actions={
          <ButtonAnchor size="sm" href={paths.resultDownload(r.id, "json")} download>
            Download JSON
          </ButtonAnchor>
        }
      />

      <div className="space-y-4">
        {r.error && (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <code className="text-xs font-semibold">{r.error.code}</code>
              <span>{r.error.message}</span>
            </div>
          </div>
        )}

        <Panel>
          <DefinitionList
            items={[
              ["Result", <ResultBadge key="s" success={r.success} code={r.error?.code} />],
              ["HTTP status", <code key="h">{r.status_code ?? "—"}</code>],
              ["Formats", r.formats.length ? r.formats.join(", ") : "—"],
              [
                "Size",
                <span key="z">
                  {formatBytes(r.content_bytes)} {r.truncated && <Badge tone="amber">truncated</Badge>}
                </span>,
              ],
              ["Links", r.links_count],
              ["Created", formatDateTime(r.created_at)],
              ["Result ID", <code key="id" className="text-xs">{r.id}</code>],
            ]}
          />
        </Panel>

        {c === null && r.success && (
          <p className="text-sm text-muted">The stored content for this result could not be loaded.</p>
        )}

        <Panel flush className="min-w-0">
          <Tabs items={tabs} value={tab} onChange={setPicked} className="px-2 pt-1" />
          {tab === "markdown" && c?.markdown !== undefined && <TextTab resultId={r.id} format="markdown" text={c.markdown} />}
          {tab === "html" && c?.html !== undefined && <HtmlTab resultId={r.id} html={c.html} />}
          {tab === "text" && c?.text !== undefined && <TextTab resultId={r.id} format="text" text={c.text} />}
          {tab === "links" && c?.links !== undefined && <LinksTab links={c.links} />}
          {tab === "branding" && c?.branding !== undefined && (
            <BrandingTab branding={c.branding} error={c.branding_error} />
          )}
          {tab === "metadata" && <MetadataTab result={r} />}
        </Panel>
      </div>
    </>
  );
}
