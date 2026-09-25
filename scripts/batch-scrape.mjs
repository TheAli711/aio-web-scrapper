#!/usr/bin/env node
// Batch-scrape a list of URLs through the local API (content + branding) and grade each result
// with cheap heuristics (no LLM). Writes to output/batch-<ts>/:
//   <site>.md, <site>.branding.json   per URL
//   report.json, report.md            verdicts (GOOD / CHECK / BAD) and issues
//   report.html                       visual review: logo, favicon, color swatches per site
//
//   node scripts/batch-scrape.mjs urls.txt [--concurrency 4] [--full-page] [--wait 0] [--no-branding]
//   pbpaste | node scripts/batch-scrape.mjs -
//   node scripts/batch-scrape.mjs urls.txt --sample 10      # random 10 from a long list
//
// Reads WS_API_URL / WS_API_KEY from the environment or .local/credentials.env.
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadCreds() {
  const f = join(ROOT, ".local/credentials.env");
  if (existsSync(f)) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
  if (!process.env.WS_API_KEY) throw new Error("WS_API_KEY not set; run ./scripts/local.sh up");
  return { api: process.env.WS_API_URL || "http://localhost:4000", key: process.env.WS_API_KEY };
}

function parseArgs(argv) {
  const o = { file: null, concurrency: 4, onlyMain: true, waitFor: 0, timeout: 60000, branding: true, sample: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--concurrency") o.concurrency = Number(argv[++i]);
    else if (a === "--full-page") o.onlyMain = false;
    else if (a === "--wait") o.waitFor = Number(argv[++i]);
    else if (a === "--timeout") o.timeout = Number(argv[++i]);
    else if (a === "--no-branding") o.branding = false;
    else if (a === "--sample") o.sample = Number(argv[++i]);
    else o.file = a;
  }
  if (!o.file) throw new Error("usage: batch-scrape.mjs <urls.txt|-> [--concurrency N] [--full-page] [--wait MS]");
  return o;
}

function readUrls(file) {
  const raw = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim().replace(/^["'<(]+|[">)'.;]+$/g, ""))
        .map((s) => (/^www\./i.test(s) ? `https://${s}` : s))
        .filter((s) => /^https?:\/\/[^/\s]+\.[^/\s]+/i.test(s)),
    ),
  ];
}

// ---------------------------------------------------------------- quality heuristics

const BLOCK_PATTERNS = [
  /just a moment\.\.\./i, /checking your browser/i, /attention required/i, /cf-browser-verification/i,
  /access denied/i, /request blocked/i, /are you a robot/i, /verify you are human/i, /performing security verification/i,
  /complete the security check/i, /enable javascript/i,
  /please turn javascript on/i, /pardon our interruption/i, /403 forbidden/i, /site can.t be reached/i,
  /this site is currently unavailable/i, /domain (is )?for sale/i, /account (has been )?suspended/i,
];
const PLACEHOLDER_PATTERNS = [/coming soon/i, /under construction/i, /parked/i, /lorem ipsum/i];

const SOCIAL = /(^|\.)(instagram|facebook|fb|tiktok|linkedin|twitter|x|yelp|pinterest|youtube)\.com$/i;
const BOOKING = /(^|\.)(vagaro|booksy|glossgenius|squareup|square\.site|mindbodyonline|schedulicity|fresha|boulevard|janeapp)\./i;

/**
 * Why a page failed, when it's the site's fault rather than ours:
 * social (login wall), private, dead (unconnected / removed), parked, blocked (bot wall).
 */
export function classify(url, r, words) {
  const host = (() => { try { return new URL(r?.final_url || url).hostname; } catch { return ""; } })();
  const md = (r?.content?.markdown ?? "").slice(0, 4000);
  const code = r?.status_code ?? null;
  if (SOCIAL.test(host)) return "social";
  if (code === 401 || /private site|password protected|enter (the )?password/i.test(md)) return "private";
  if (/connectyourdomain|domain (is )?not connected|site (is )?(not|no longer) (available|published)|this site can.t be reached|website (is )?(expired|unavailable)|account (has been )?suspended/i.test(md)) return "dead";
  if (/\/lander\b|domain (is )?for sale|buy this domain|parked (free|domain)|this domain may be for sale/i.test(md)) return "parked";
  if ((code === 403 || code === 429 || code === 503) && words < 80) return "blocked";
  if (code === 404 && words < 80) return "dead";
  if (BOOKING.test(host)) return "booking-platform";
  return null;
}

export function grade(r) {
  const md = r?.content?.markdown ?? "";
  const text = md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> anchor text
    .replace(/[#>*_`|\\-]+/g, " ");
  const words = text.split(/\s+/).filter((w) => /[a-z]{2,}/i.test(w));
  const lines = md.split("\n").map((l) => l.trim()).filter(Boolean);
  const linkLines = lines.filter((l) => /^\W*\[[^\]]*\]\([^)]*\)\W*$/.test(l)).length;
  const imageCount = (md.match(/!\[[^\]]*\]\(/g) || []).length;
  const uniqueLines = new Set(lines).size;
  const issues = [];

  if (!r) issues.push("no result");
  else if (!r.success) issues.push(`failed: ${r.error?.code ?? "unknown"} ${r.status_code ?? ""}`.trim());
  if (words.length < 50) issues.push(`thin content (${words.length} words)`);
  else if (words.length < 150) issues.push(`low content (${words.length} words)`);
  const head = md.slice(0, 3000);
  for (const p of BLOCK_PATTERNS) if (p.test(head) && words.length < 400) issues.push(`block/interstitial: ${p.source}`);
  for (const p of PLACEHOLDER_PATTERNS) if (p.test(head) && words.length < 200) issues.push(`placeholder: ${p.source}`);
  if (lines.length > 10 && linkLines / lines.length > 0.6) issues.push(`mostly links (${linkLines}/${lines.length} lines)`);
  if (lines.length > 20 && uniqueLines / lines.length < 0.5) issues.push("heavy duplication");
  if (r?.final_url && r.url && new URL(r.final_url).hostname.replace(/^www\./, "") !== new URL(r.url).hostname.replace(/^www\./, "")) {
    issues.push(`redirected off-host to ${new URL(r.final_url).hostname}`);
  }

  const b = r?.content?.branding;
  if (r?.content && "branding" in r.content) {
    if (!b) issues.push(`branding failed: ${r.content.branding_error?.code ?? "unknown"}`);
    else {
      if (!b.logo) issues.push("no logo");
      else if (b.logo.confidence === "low") issues.push(`logo low confidence (${b.logo.source})`);
      if (!b.favicon || b.favicon.source === "default") issues.push("favicon not declared (guessed /favicon.ico)");
      if (!b.colors?.primary) issues.push("no primary color");
      else if (b.colors.confidence === "low") issues.push(`colors low confidence (${b.colors.basis})`);
    }
  }

  const verdict = !r?.success || words.length < 50 || issues.some((i) => i.startsWith("block")) ? "BAD" : issues.length ? "CHECK" : "GOOD";
  const site = classify(r?.url ?? "", r, words.length);
  return { verdict, site_issue: verdict === "GOOD" ? null : site, words: words.length, lines: lines.length, images: imageCount, links: r?.content?.links?.length ?? 0, issues };
}

// ---------------------------------------------------------------- API

async function scrapeOne(cfg, url, opts) {
  const body = { url, formats: opts.branding ? ["markdown", "branding"] : ["markdown"], only_main_content: opts.onlyMain, timeout_ms: opts.timeout, wait_for_ms: opts.waitFor };
  const t0 = Date.now();
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${cfg.api}/api/v1/scrape?wait=true`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, (json.error?.details?.retryAfterSeconds ?? 5) * 1000));
      continue;
    }
    if (res.status === 202) return { ms: Date.now() - t0, job: json.job ?? json, result: await pollResult(cfg, json.job?.id ?? json.id) };
    if (res.status >= 400) return { ms: Date.now() - t0, job: { status: "failed", error: json.error }, result: null };
    return { ms: Date.now() - t0, job: json.job, result: json.result };
  }
  return { ms: Date.now() - t0, job: { status: "failed", error: { code: "RATE_LIMITED" } }, result: null };
}

async function pollResult(cfg, id) {
  const h = { authorization: `Bearer ${cfg.key}` };
  for (let i = 0; i < 90; i++) {
    const job = await (await fetch(`${cfg.api}/api/v1/jobs/${id}`, { headers: h })).json();
    if (["completed", "failed", "cancelled"].includes(job.status)) {
      const r = await (await fetch(`${cfg.api}/api/v1/jobs/${id}/results?include_content=true`, { headers: h })).json();
      return r.data?.[0] ?? null;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

function slug(url) {
  const u = new URL(url);
  return (u.hostname.replace(/^www\./, "") + u.pathname).replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").slice(0, 80);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = loadCreds();
  let urls = readUrls(opts.file);
  if (opts.sample > 0 && urls.length > opts.sample) {
    urls = urls.map((u) => [Math.random(), u]).sort((a, b) => a[0] - b[0]).slice(0, opts.sample).map(([, u]) => u);
  }
  const dir = join(ROOT, "output", `batch-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
  mkdirSync(dir, { recursive: true });
  console.error(`scraping ${urls.length} URLs -> ${dir}`);

  const rows = await pool(urls, opts.concurrency, async (url) => {
    const { ms, job, result } = await scrapeOne(cfg, url, opts);
    const g = grade(result ? { ...result, success: result.success && job?.status !== "failed" } : null);
    if (!result && job?.error) g.issues.unshift(`job error: ${job.error.code} ${job.error.message ?? ""}`.trim());
    const file = `${slug(url)}.md`;
    writeFileSync(join(dir, file), result?.content?.markdown ?? "");
    const branding = result?.content?.branding ?? null;
    if (branding) writeFileSync(join(dir, `${slug(url)}.branding.json`), JSON.stringify(branding, null, 2));
    const c = branding?.colors;
    const brandLine = branding ? `  [P ${c?.primary ?? "-"} S ${c?.secondary ?? "-"} logo:${branding.logo?.confidence ?? "none"}]` : "";
    const tag = g.site_issue ? ` {site: ${g.site_issue}}` : "";
    console.error(`${g.verdict.padEnd(5)}${tag} ${String(g.words).padStart(5)}w ${(ms / 1000).toFixed(1).padStart(5)}s  ${url}${brandLine}${g.issues.length ? "  | " + g.issues.join("; ") : ""}`);
    return {
      url, final_url: result?.final_url ?? null, status_code: result?.status_code ?? null, title: result?.title ?? null, ms, file, ...g,
      branding: branding ? { logo: branding.logo, favicon: branding.favicon, colors: branding.colors, fonts: branding.fonts } : null,
    };
  });

  writeFileSync(join(dir, "report.json"), JSON.stringify(rows, null, 2));
  const md = [
    `# Batch report (${rows.length} URLs)`,
    "",
    `GOOD ${rows.filter((r) => r.verdict === "GOOD").length} · CHECK ${rows.filter((r) => r.verdict === "CHECK").length} · BAD ${rows.filter((r) => r.verdict === "BAD").length}`,
    "",
    "Site issues (not scraper bugs): " +
      (Object.entries(rows.reduce((a, r) => (r.site_issue ? { ...a, [r.site_issue]: (a[r.site_issue] ?? 0) + 1 } : a), {}))
        .map(([k, v]) => `${k} ${v}`)
        .join(", ") || "none"),
    "",
    "| verdict | site issue | words | status | primary | secondary | logo | url | issues |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.verdict} | ${r.site_issue ?? ""} | ${r.words} | ${r.status_code ?? "-"} | ${r.branding?.colors?.primary ?? "-"} | ${r.branding?.colors?.secondary ?? "-"} | ${r.branding?.logo?.confidence ?? "-"} | ${r.url} | ${r.issues.join("; ")} |`,
    ),
  ].join("\n");
  writeFileSync(join(dir, "report.md"), md + "\n");
  writeFileSync(join(dir, "report.html"), htmlReport(rows));
  console.log(dir);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const safeUrl = (u) => (typeof u === "string" && /^(https?:|data:image\/)/i.test(u) ? esc(u) : "");

/** Self-contained visual review page: one card per site with logo, favicon and swatches. */
function htmlReport(rows) {
  const sw = (hex, label) =>
    hex ? `<div class="sw"><span style="background:${esc(hex)}"></span><b>${label}</b><code>${esc(hex)}</code></div>` : `<div class="sw none"><span></span><b>${label}</b><code>-</code></div>`;
  const cards = rows.map((r) => {
    const b = r.branding, c = b?.colors, logo = b?.logo;
    const logoSrc = safeUrl(logo?.image) || safeUrl(logo?.url);
    return `<article class="${r.verdict.toLowerCase()}">
  <header><span class="v">${r.verdict}</span>${r.site_issue ? ` <span class="si">site: ${esc(r.site_issue)}</span>` : ""} <a href="${safeUrl(r.url)}" target="_blank" rel="noreferrer">${esc(r.url)}</a> <small>${r.words} words · ${(r.ms / 1000).toFixed(1)}s</small></header>
  <div class="row">
    <div class="logo ${logo?.tone === "light" ? "dark" : ""}">${logoSrc ? `<img src="${logoSrc}" referrerpolicy="no-referrer" alt="">` : "<em>no logo</em>"}</div>
    <div class="meta">
      <div>${b?.favicon ? `<img class="fav" src="${safeUrl(b.favicon.url)}" referrerpolicy="no-referrer" alt="">` : ""} favicon ${esc(b?.favicon?.source ?? "-")}</div>
      <div>logo: ${esc(logo?.source ?? "-")} · ${esc(logo?.confidence ?? "-")} · tone ${esc(logo?.tone ?? "-")}</div>
      <div>colors: ${esc(c?.confidence ?? "-")} (${esc(c?.basis ?? "-")})</div>
      <div>fonts: ${esc(b?.fonts?.heading ?? "-")} / ${esc(b?.fonts?.body ?? "-")}</div>
    </div>
  </div>
  <div class="row sws">${sw(c?.primary, "primary")}${sw(c?.secondary, "secondary")}${sw(c?.accent, "accent")}${sw(c?.background, "background")}${sw(c?.text, "text")}</div>
  <div class="pal">${(c?.palette ?? []).map((p) => `<span title="${esc(p.hex)} ${esc(p.sources.join("+"))}" style="background:${esc(p.hex)}"></span>`).join("")}</div>
  ${r.issues.length ? `<ul>${r.issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}
</article>`;
  });
  const n = (v) => rows.filter((r) => r.verdict === v).length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Batch review</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--fg:#1d1d1b;--mute:#6b6b66;--line:#e2e2dd}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#20201e;--fg:#ececea;--mute:#9a9a94;--line:#34342f}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
h1{font-size:18px;margin:0 0 12px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));gap:12px}
article{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;min-width:0}
article header{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;margin-bottom:8px}article header a{color:inherit;word-break:break-all}
small,.meta{color:var(--mute);font-size:12px}.v{font:600 11px system-ui;padding:2px 6px;border-radius:4px;background:#2e7d32;color:#fff}
.si{font:600 11px system-ui;padding:2px 6px;border-radius:4px;border:1px solid var(--line);color:var(--mute)}.check .v{background:#b26a00}.bad .v{background:#c62828}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.logo{width:180px;height:72px;display:grid;place-items:center;border-radius:6px;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/14px 14px}
.logo.dark{background:#222}.logo img{max-width:170px;max-height:64px}.fav{width:16px;height:16px;vertical-align:-3px}
.sws{margin-top:10px}.sw{display:flex;flex-direction:column;align-items:center;font-size:11px;gap:2px}
.sw span{width:56px;height:32px;border-radius:5px;border:1px solid var(--line)}.sw.none span{background:repeating-linear-gradient(45deg,transparent 0 4px,var(--line) 4px 5px)}
.pal{display:flex;margin-top:8px;border-radius:4px;overflow:hidden;height:10px}.pal span{flex:1}
ul{margin:8px 0 0;padding-left:18px;color:var(--mute);font-size:12px}
</style></head><body><h1>Batch review · ${rows.length} URLs · GOOD ${n("GOOD")} · CHECK ${n("CHECK")} · BAD ${n("BAD")}</h1><div class="grid">${cards.join("\n")}</div></body></html>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
