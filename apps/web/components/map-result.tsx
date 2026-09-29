"use client";

import { useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isHttpUrl } from "@/lib/url";
import type { MapResult, StorePlatform } from "@/lib/types";

const PLATFORM_LABELS: Record<StorePlatform, string> = {
  magento: "Magento",
  shopify: "Shopify",
  woocommerce: "WooCommerce",
};

/** A map can return 10k URLs; rendering them all at once makes the page sluggish, so start with this many. */
const PREVIEW_COUNT = 500;

function fileName(url: string): string {
  try {
    return `${new URL(url).hostname || "site"}-urls.txt`;
  } catch {
    return "site-urls.txt";
  }
}

function downloadText(text: string, name: string) {
  const href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** Inline result of a map request: summary, copy/download, and the URL list. */
export function MapResultView({ result }: { result: MapResult }) {
  const [showAll, setShowAll] = useState(false);
  const text = useMemo(() => result.urls.join("\n") + "\n", [result.urls]);
  const shown = showAll ? result.urls : result.urls.slice(0, PREVIEW_COUNT);
  const hidden = result.urls.length - shown.length;

  return (
    <section className="space-y-2 border-t border-line pt-3" aria-label="Map result">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
          <span>
            <span className="font-medium tabular-nums">{result.count.toLocaleString()}</span> URL{result.count === 1 ? "" : "s"}
          </span>
          {result.platform && <Badge tone="blue">{PLATFORM_LABELS[result.platform] ?? result.platform}</Badge>}
          {result.product_urls > 0 && (
            <span className="text-muted">
              {result.product_urls.toLocaleString()} product page{result.product_urls === 1 ? "" : "s"} from the store catalog
            </span>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton text={text} label="Copy all" />
          <Button size="sm" onClick={() => downloadText(text, fileName(result.url))}>
            Download .txt
          </Button>
        </div>
      </div>

      {result.urls.length === 0 ? (
        <p className="text-sm text-muted">No URLs were found.</p>
      ) : (
        <ol className="max-h-[60vh] divide-y divide-line overflow-auto rounded-md border border-line">
          {shown.map((u, i) => (
            <li key={`${i}-${u}`} className="flex gap-3 px-3 py-1">
              <span className="w-10 shrink-0 text-right font-mono text-xs text-muted tabular-nums">{i + 1}</span>
              {isHttpUrl(u) ? (
                <a href={u} target="_blank" rel="noopener noreferrer" className="link min-w-0 font-mono text-xs break-all">
                  {u}
                </a>
              ) : (
                <span className="min-w-0 font-mono text-xs break-all">{u}</span>
              )}
            </li>
          ))}
        </ol>
      )}

      {hidden > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>
            Showing the first {shown.length.toLocaleString()} of {result.urls.length.toLocaleString()}.
          </span>
          <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
            Show all
          </Button>
        </div>
      )}
    </section>
  );
}
