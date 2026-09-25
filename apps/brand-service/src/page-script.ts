/**
 * Runs inside the target page (via page.evaluate). Must be self-contained: no imports, no
 * references to module scope. Collects raw signals only; decisions are made in brand.ts.
 */

export interface RawIcon {
  url: string;
  rel: string;
  sizes: string | null;
  type: string | null;
}

export interface RawLogoCandidate {
  index: number;
  kind: "img" | "svg" | "background" | "text";
  /** Wordmark text for "text" logos (a styled site name instead of an image). */
  text: string | null;
  url: string | null;
  alt: string | null;
  width: number;
  height: number;
  top: number;
  left: number;
  score: number;
  reasons: string[];
  /** Solid color painted behind the element (nearest ancestor background), if any. */
  backdrop: string | null;
}

export interface RawSignals {
  finalUrl: string;
  title: string;
  siteName: string | null;
  themeColor: string | null;
  ogImage: string | null;
  manifestUrl: string | null;
  icons: RawIcon[];
  jsonLdLogos: string[];
  logoCandidates: RawLogoCandidate[];
  /** color (rgb/rgba string) -> weight, per source */
  colors: {
    background: Record<string, number>;
    text: Record<string, number>;
    buttons: Record<string, number>;
    buttonText: Record<string, number>;
    links: Record<string, number>;
    headings: Record<string, number>;
    borders: Record<string, number>;
    /** Header element and full-width bands at the top of the page (announcement bar, nav bar). */
    header: Record<string, number>;
    /** Body copy (<p>, <li>) text colors. */
    paragraphs: Record<string, number>;
    footer: string | null;
    body: string | null;
  };
  fonts: { heading: string | null; body: string | null };
  cssVars: Record<string, string>;
}

export function collectSignals(maxElements: number): RawSignals {
  const abs = (u: string | null | undefined): string | null => {
    if (!u) return null;
    const s = u.trim();
    if (!s || s.startsWith("javascript:")) return null;
    try {
      return new URL(s, document.baseURI).href;
    } catch {
      return null;
    }
  };
  const meta = (sel: string): string | null => document.querySelector<HTMLMetaElement>(sel)?.content?.trim() || null;
  const add = (m: Record<string, number>, k: string | null, w: number) => {
    if (!k || w <= 0) return;
    m[k] = (m[k] ?? 0) + w;
  };
  const alphaOf = (c: string): number => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return c === "transparent" ? 0 : 1;
    const p = m[1]!.split(/[ ,/]+/).filter(Boolean);
    return p.length >= 4 ? parseFloat(p[3]!) : 1;
  };
  const solid = (c: string | null | undefined): string | null => (c && alphaOf(c) >= 0.5 ? c : null);

  // ---------------------------------------------------------------- icons / metadata
  const icons: RawIcon[] = [];
  for (const l of Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel][href]"))) {
    const rel = (l.getAttribute("rel") || "").toLowerCase();
    if (!/icon|mask-icon/.test(rel)) continue;
    const url = abs(l.getAttribute("href"));
    if (url) icons.push({ url, rel, sizes: l.getAttribute("sizes"), type: l.getAttribute("type") });
  }

  const jsonLdLogos: string[] = [];
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    const logo = o.logo;
    if (typeof logo === "string") jsonLdLogos.push(logo);
    else if (logo && typeof logo === "object") {
      const lo = logo as Record<string, unknown>;
      const u = (lo.url ?? lo.contentUrl) as unknown;
      if (typeof u === "string") jsonLdLogos.push(u);
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") visit(v, depth + 1);
  };
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      visit(JSON.parse(s.textContent || ""), 0);
    } catch {
      /* ignore malformed JSON-LD */
    }
  }

  // ---------------------------------------------------------------- logo candidates
  const host = location.hostname.replace(/^www\./, "");
  const siteName = meta('meta[property="og:site_name"]') || meta('meta[name="application-name"]');
  const nameTokens = [
    ...host.split(".")[0]!.split(/[-_]/),
    ...(siteName ?? "").toLowerCase().split(/[^a-z0-9]+/),
  ].filter((t) => t.length >= 3);
  const NEG = /(press|as-?seen|featured|vogue|allure|forbes|partner|award|payment|visa|mastercard|amex|paypal|cherry|carecredit|affirm|klarna|accessib|badge|google|yelp|facebook|instagram|tiktok|youtube|twitter|linkedin|pinterest|review|trustpilot|hamburger|menu-?icon|close|search|cart|arrow|chevron|play-?button|flag|lazy_placeholder|spinner|loader|avatar|team|staff|doctor|before-?after|gallery|allergan|galderma|merz|revance|botox|juvederm|brilliant-?distinctions|alle\b|cash|venmo|zelle|scroll|down)/i;
  const rootPaths = new Set(["/", "", "/index.html", "/home", "/en", "/en/"]);
  const isHomeLink = (a: HTMLAnchorElement | null): boolean => {
    if (!a) return false;
    try {
      const u = new URL(a.getAttribute("href") || "", document.baseURI);
      return u.hostname.replace(/^www\./, "") === host && rootPaths.has(u.pathname.replace(/\/+$/, "/"));
    } catch {
      return false;
    }
  };
  const attrText = (el: Element): string =>
    [el.id, typeof el.className === "string" ? el.className : el.getAttribute("class") || "", el.getAttribute("alt"), el.getAttribute("title"), el.getAttribute("aria-label"), el.getAttribute("src"), el.getAttribute("data-src")]
      .filter(Boolean)
      .join(" ");
  const ancestorText = (el: Element, levels: number): string => {
    let out = "";
    let p = el.parentElement;
    for (let i = 0; p && i < levels; i++, p = p.parentElement) out += " " + attrText(p);
    return out;
  };
  const imgUrl = (img: HTMLImageElement): string | null => {
    const lazy = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original");
    const cur = img.currentSrc || img.src;
    if (cur && !cur.startsWith("data:image/gif") && !/placeholder|blank\.gif|spacer/i.test(cur) && !(cur.startsWith("data:image/svg") && lazy)) return abs(cur);
    if (lazy) return abs(lazy);
    const set = img.getAttribute("data-srcset") || img.getAttribute("srcset");
    if (set) return abs(set.split(",")[0]!.trim().split(/\s+/)[0]);
    return cur ? abs(cur) : null;
  };

  const candidates: RawLogoCandidate[] = [];
  const els: Element[] = [];
  const pushCandidate = (el: Element, kind: RawLogoCandidate["kind"], url: string | null, wordmark: string | null = null) => {
    const r = el.getBoundingClientRect();
    const top = r.top + window.scrollY;
    if (r.width < 16 || r.height < 10 || top > 1500) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.1) return;
    const reasons: string[] = [];
    let score = 0;
    const own = attrText(el);
    const near = ancestorText(el, 4);
    const text = (own + " " + near).toLowerCase();
    if (/logo|brand|site-?title|navbar-brand|custom-logo/i.test(own)) (score += 4), reasons.push("logo-attr");
    else if (/logo|brand|site-?title|navbar-brand|custom-logo/i.test(near)) (score += 3), reasons.push("logo-ancestor");
    if (el.closest("header, nav, [role=banner], [class*=header], [id*=header], [class*=navbar]")) (score += 2), reasons.push("in-header");
    if (top < 200) (score += 2), reasons.push("top");
    else if (top > 700) (score -= 2), reasons.push("low");
    if (isHomeLink(el.closest("a"))) (score += 3), reasons.push("home-link");
    const alt = el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("title");
    if (nameTokens.some((t) => text.includes(t))) (score += 2), reasons.push("site-name");
    if (NEG.test(own) || NEG.test(ancestorText(el, 2))) (score -= 5), reasons.push("negative-keyword");
    if (el.closest("footer, [class*=footer], [id*=footer]")) (score -= 2), reasons.push("in-footer");
    const ar = r.width / r.height;
    if (r.width >= 40 && r.width <= 600 && r.height >= 16 && r.height <= 300) (score += 1), reasons.push("size-ok");
    if (r.width > 900 || r.height > 400) (score -= 3), reasons.push("too-big");
    if (kind !== "text" && r.width < 40 && r.height < 40) (score -= 4), reasons.push("tiny-icon");
    if (kind === "text") {
      // Prefer a real image logo when there is one; a styled site name is the fallback.
      score -= 1.5;
      if (wordmark && nameTokens.some((t) => wordmark.toLowerCase().replace(/[^a-z0-9]/g, "").includes(t))) (score += 3), reasons.push("text-is-name");
      if (parseFloat(cs.fontSize) >= 18) (score += 1), reasons.push("large-type");
    }
    if (ar < 0.4 || ar > 12) (score -= 1), reasons.push("odd-aspect");
    if (r.left + r.width / 2 < window.innerWidth * 0.66) score += 0.5;
    if (score <= 0) return;
    els.push(el);
    let backdrop: string | null = null;
    for (let p: Element | null = el.parentElement; p && !backdrop; p = p.parentElement) backdrop = solid(getComputedStyle(p).backgroundColor);
    candidates.push({ index: els.length - 1, kind, url, text: wordmark, alt, width: Math.round(r.width), height: Math.round(r.height), top: Math.round(top), left: Math.round(r.left), score, reasons, backdrop });
  };

  for (const img of Array.from(document.querySelectorAll("img"))) pushCandidate(img, "img", imgUrl(img));
  for (const svg of Array.from(document.querySelectorAll("svg"))) {
    if (svg.parentElement?.closest("svg")) continue;
    const clone = svg.cloneNode(true) as SVGElement;
    clone.querySelectorAll("script, foreignObject").forEach((n) => n.remove());
    if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const markup = clone.outerHTML;
    pushCandidate(svg, "svg", markup.length <= 60_000 ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup) : null);
  }
  // CSS-background logos (Showit, Squarespace blocks, older themes): any element near the top
  // whose background image is named like a logo, sits in the header or links home.
  for (const el of Array.from(document.body?.querySelectorAll("*") ?? []).slice(0, 4000)) {
    if (el.tagName === "IMG" || el.tagName === "svg") continue;
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg !== "none" ? bg.match(/url\(["']?([^"')]+)["']?\)/) : null;
    if (!m) continue;
    const rr = el.getBoundingClientRect();
    if (rr.top + window.scrollY > 900 || rr.width > 800) continue;
    const url = abs(m[1]);
    const logoNamed = /logo|brand|wordmark/i.test(m[1]!.split("/").pop() ?? "");
    if (logoNamed || el.closest("header, [role=banner], [class*=logo], [id*=logo]") || isHomeLink(el.closest("a"))) {
      const before = candidates.length;
      pushCandidate(el, "background", url);
      if (logoNamed && candidates.length > before) {
        const c = candidates[candidates.length - 1]!;
        c.score += 3;
        c.reasons.push("logo-filename");
      }
    }
  }
  // Text wordmarks: a short, image-free site name in the header, usually linking home.
  const NAV_WORDS = /^(home|about( us)?|services|treatments|contact( us)?|book( now| online)?|shop|blog|menu|gallery|pricing|faq|team|specials|locations?|log ?in|sign ?in|gift cards?|reviews|memberships?)$/i;
  for (const el of Array.from(document.querySelectorAll('header a, nav a, [role=banner] a, [class*=site-title], [class*=site-name], [class*=site-branding], [class*=logo], [class*=brand], h1 a, a[href="/"]'))) {
    if (el.querySelector("img, svg, picture, canvas")) continue;
    if (el.getElementsByTagName("*").length > 6) continue;
    const t = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
    if (t.length < 2 || t.length > 40 || NAV_WORDS.test(t)) continue;
    const r = el.getBoundingClientRect();
    if (r.top + window.scrollY > 300) continue;
    const homeish = isHomeLink(el.closest("a")) || /logo|brand|site-?title|site-?name|site-?branding/i.test(attrText(el) + ancestorText(el, 2));
    if (homeish) pushCandidate(el, "text", null, t);
  }
  candidates.sort((a, b) => b.score - a.score || a.top - b.top);
  const top = candidates.slice(0, 5);
  document.querySelectorAll("[data-ws-logo]").forEach((e) => e.removeAttribute("data-ws-logo"));
  top.forEach((c, i) => {
    els[c.index]!.setAttribute("data-ws-logo", String(i));
    c.index = i;
  });

  // ---------------------------------------------------------------- colors
  const colors: RawSignals["colors"] = { background: {}, text: {}, buttons: {}, buttonText: {}, links: {}, headings: {}, borders: {}, header: {}, paragraphs: {}, footer: null, body: null };
  const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);
  const vw = window.innerWidth;
  const BUTTON = 'button, input[type=submit], input[type=button], [role=button], a[class*=btn], a[class*=button], [class*=btn] > a, [class*=button] > a, a[class*=cta], .wp-block-button__link, .elementor-button, .sqs-block-button-element';
  // Fixed-position UI that is not the site header (chat widgets, cookie bars, promo tabs) is
  // third-party chrome, not brand: skip everything inside it.
  const fixedCache = new Map<Element, boolean>();
  const inFloatingWidget = (el: Element): boolean => {
    const chain: Element[] = [];
    let res = false;
    for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) {
      const hit = fixedCache.get(p);
      if (hit !== undefined) {
        res = hit;
        break;
      }
      chain.push(p);
      if (getComputedStyle(p).position === "fixed") {
        const r = p.getBoundingClientRect();
        res = !(r.top <= 5 && r.width >= vw * 0.8 && r.height <= 260);
        break;
      }
    }
    for (const c of chain) fixedCache.set(c, res);
    return res;
  };
  // Embedded third-party widgets (social feeds, review badges, consent banners, chat) carry their
  // own brand colors (Instagram blue, Google yellow ...), not the site's.
  const THIRD_PARTY = [
    "[class*=instagram]", "[id*=instagram]", "[id^=sbi]", "[class*=sbi_]", "[class*=social]", "[class*=share]",
    "[class*=elfsight]", "[class*=eapps]", "[class*=trustindex]", "[class*=ti-widget]", "[class*=review-widget]",
    "[class*=google-review]", "[class*=yelp]", "[class*=cookie]", "[id*=cookie]", "[class*=consent]", "[id*=consent]",
    "[class*=cky-]", "[id*=onetrust]", "[class*=podium]", "[id*=podium]", "[class*=chat]", "[id*=chat]",
    "[class*=accessibe]", "[class*=userway]", "[class*=cherry]", "[id*=cherry]", "[class*=carecredit]", "[class*=gtranslate]",
  ].join(", ");
  const all = Array.from(document.body?.querySelectorAll("*") ?? []).slice(0, maxElements);
  // Widget roots are small subtrees; a page wrapper (or <body>) whose class merely mentions
  // "cookie" / "chat" must not exclude the whole page.
  const tpCache = new Map<Element, boolean>();
  const inThirdParty = (el: Element): boolean => {
    const root = el.closest(THIRD_PARTY);
    if (!root || root === document.body || root === document.documentElement) return false;
    let hit = tpCache.get(root);
    if (hit === undefined) {
      hit = root.getElementsByTagName("*").length < all.length * 0.15 && !root.querySelector("h1, main, header, nav");
      tpCache.set(root, hit);
    }
    return hit;
  };
  for (const el of all) {
    if (el.closest("svg, script, style, noscript, iframe, template")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.3) continue;
    if (r.right < 0 || r.left > vw || inFloatingWidget(el) || inThirdParty(el)) continue;
    // Clip to the page; earlier (higher) content is what visitors see most, so weight it more.
    const top = r.top + window.scrollY;
    const w = Math.min(r.width, vw);
    const h = Math.min(r.height, docH);
    const fold = top < 900 ? 1.5 : 1;
    const area = (w * h) / (vw * 900);
    const bg = solid(cs.backgroundColor);
    const isButton = el.matches(BUTTON);
    if (bg && top < 180 && r.width >= vw * 0.8 && r.height >= 20 && r.height <= 260) add(colors.header, bg, r.height / 100);
    if (bg) {
      if (isButton && r.width < 600 && r.height < 200) {
        add(colors.buttons, bg, 1 + Math.min(area * 10, 2));
        add(colors.buttonText, solid(cs.color), 1);
      } else add(colors.background, bg, area * fold);
    } else if (isButton && cs.backgroundImage.includes("gradient(")) {
      const stops = cs.backgroundImage.match(/rgba?\([^)]+\)/g) ?? [];
      for (const c of stops) add(colors.buttons, solid(c), 1 / stops.length);
    } else if (isButton) {
      const bc = solid(cs.borderTopColor);
      if (bc && parseFloat(cs.borderTopWidth) >= 1) add(colors.buttons, bc, 0.5);
    }
    let ownText = 0;
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) ownText += (n.textContent || "").trim().length;
    if (ownText > 0) {
      const tw = Math.min(ownText, 400) * fold;
      if (/^H[1-6]$/.test(el.tagName)) add(colors.headings, solid(cs.color), tw * 2);
      else if (el.tagName === "A" && !isButton) add(colors.links, solid(cs.color), tw);
      else add(colors.text, solid(cs.color), tw);
      if (el.tagName === "P" || el.tagName === "LI") add(colors.paragraphs, solid(cs.color), tw);
    }
    if (parseFloat(cs.borderTopWidth) >= 2 && r.width > 40) add(colors.borders, solid(cs.borderTopColor), 1);
  }
  const bgOf = (el: Element | null): string | null => {
    for (let p = el; p; p = p.parentElement) {
      const c = solid(getComputedStyle(p).backgroundColor);
      if (c) return c;
    }
    return null;
  };
  const header = document.querySelector("header, [role=banner], #header, .header, #masthead, .site-header");
  if (header) add(colors.header, bgOf(header) ?? bgOf(header.querySelector("*")), 1);
  const footers = document.querySelectorAll("footer, [role=contentinfo], #footer, .footer, .site-footer");
  colors.footer = footers.length ? bgOf(footers[footers.length - 1]!) : null;
  colors.body = solid(getComputedStyle(document.body).backgroundColor) ?? solid(getComputedStyle(document.documentElement).backgroundColor);

  const fontOf = (sel: string) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).fontFamily.split(",")[0]!.replace(/["']/g, "").trim() || null : null;
  };

  // Named brand variables used by common builders (Elementor, Astra, Squarespace, Shopify themes ...).
  const cssVars: Record<string, string> = {};
  const rootCs = getComputedStyle(document.documentElement);
  const bodyCs = getComputedStyle(document.body);
  const VAR_NAMES = [
    "--e-global-color-primary", "--e-global-color-secondary", "--e-global-color-accent", "--e-global-color-text",
    "--ast-global-color-0", "--ast-global-color-1", "--wp--preset--color--primary", "--wp--preset--color--secondary",
    "--wp--preset--color--accent", "--color-primary", "--color-secondary", "--color-accent", "--primary", "--secondary",
    "--primary-color", "--secondary-color", "--accent-color", "--brand-color", "--color-brand", "--theme-color",
    "--custom-primary-color", "--global-palette1", "--global-palette2",
  ];
  for (const n of VAR_NAMES) {
    const v = (rootCs.getPropertyValue(n) || bodyCs.getPropertyValue(n)).trim();
    if (v && v.length < 60) cssVars[n] = v;
  }

  return {
    finalUrl: location.href,
    title: document.title,
    siteName,
    themeColor: meta('meta[name="theme-color"]'),
    ogImage: abs(meta('meta[property="og:image"]') || meta('meta[name="og:image"]')),
    manifestUrl: abs(document.querySelector('link[rel="manifest"]')?.getAttribute("href")),
    icons,
    jsonLdLogos: [...new Set(jsonLdLogos.map((u) => abs(u)).filter((u): u is string => !!u))],
    logoCandidates: top,
    colors,
    fonts: { heading: fontOf("h1") ?? fontOf("h2"), body: fontOf("p") ?? fontOf("body") },
    cssVars,
  };
}

/**
 * Runs in the target page: scroll down like a visitor (fires lazy-loading and scroll-reveal
 * animations), then force-finish common reveal libraries. While scrolling, sample a point grid
 * with elementFromPoint and record the solid background actually visible at each point, which is
 * the true surface distribution (box areas overlap and double count; pixels of photos are noise).
 * Returns color -> share of sampled points.
 */
export interface SurfaceSamples {
  /** color -> share of sampled points */
  shares: Record<string, number>;
  /** [pageX, pageY, color] for pixel verification against a page screenshot */
  points: Array<[number, number, string]>;
}

export async function scrollAndSample(maxY: number): Promise<SurfaceSamples> {
  const out: Record<string, number> = {};
  const points: Array<[number, number, string]> = [];
  const vw = window.innerWidth, vh = window.innerHeight;
  const alpha = (c: string) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return c === "transparent" ? 0 : 1;
    const p = m[1]!.split(/[ ,/]+/).filter(Boolean);
    return p.length >= 4 ? parseFloat(p[3]!) : 1;
  };
  const MEDIA = new Set(["IMG", "VIDEO", "PICTURE", "CANVAS", "IFRAME", "svg"]);
  let samples = 0;
  const sample = (fromY: number) => {
    for (let gy = fromY; gy < vh; gy += 60) {
      for (let gx = 20; gx < vw; gx += Math.max(40, vw / 16)) {
        // Walk the paint stack at this point (top to bottom), which includes sibling layers such as
        // background videos / slideshows that aren't ancestors of the text on top of them.
        const stack = document.elementsFromPoint(gx, gy);
        if (!stack.length) continue;
        samples++;
        let color: string | null = null;
        let painted = false;
        for (const el of stack) {
          if (el === document.documentElement || el === document.body) break;
          if (MEDIA.has(el.tagName)) {
            painted = true;
            break;
          }
          const cs = getComputedStyle(el);
          if (cs.position === "fixed" && el.getBoundingClientRect().top > 5) continue;
          const a = alpha(cs.backgroundColor);
          // Translucent tint layers (photo / video overlays) belong to the media underneath.
          if (a > 0.05 && (a < 0.95 || parseFloat(cs.opacity) < 0.95)) {
            painted = true;
            break;
          }
          if (a >= 0.95) {
            color = cs.backgroundColor;
            painted = true;
            break;
          }
          if (cs.backgroundImage && cs.backgroundImage !== "none" && !cs.backgroundImage.startsWith("linear-gradient")) {
            painted = true;
            break;
          }
          // ::before / ::after layers (builder backgrounds and overlays) are not in the hit stack.
          let pseudo: string | null = null;
          for (const which of ["::after", "::before"]) {
            const ps = getComputedStyle(el, which);
            if (ps.content === "none" || ps.display === "none") continue;
            const pa = alpha(ps.backgroundColor);
            if ((ps.backgroundImage && ps.backgroundImage !== "none") || (pa > 0.05 && (pa < 0.95 || parseFloat(ps.opacity) < 0.95))) {
              pseudo = "media";
              break;
            }
            if (pa >= 0.95 && (ps.position === "absolute" || ps.position === "fixed")) {
              pseudo = ps.backgroundColor;
              break;
            }
          }
          if (pseudo) {
            painted = true;
            if (pseudo !== "media") color = pseudo;
            break;
          }
        }
        if (!painted) {
          // Nothing painted above the canvas: the canvas shows body/html background or white.
          const b = getComputedStyle(document.body).backgroundColor, h = getComputedStyle(document.documentElement).backgroundColor;
          color = alpha(b) >= 0.5 ? b : alpha(h) >= 0.5 ? h : "rgb(255, 255, 255)";
        }
        if (color && alpha(color) >= 0.5) {
          out[color] = (out[color] ?? 0) + 1;
          // Canvas points: the DOM can't say what is painted there; the pixel check decides.
          if (points.length < 4000) points.push([Math.round(gx), Math.round(gy + window.scrollY), painted ? color : "canvas"]);
        }
      }
    }
  };
  // Pass 1 (down): trigger lazy-loading and scroll-reveal observers.
  const step = vh * 0.6;
  const max = Math.min(document.documentElement.scrollHeight, maxY);
  for (let y = step; y < max; y += step) {
    window.scrollTo({ top: y, behavior: "instant" });
    await new Promise((r) => setTimeout(r, 150));
  }
  // Force-finish common reveal libraries whose observers didn't fire in time.
  document.querySelectorAll(".elementor-invisible").forEach((e) => e.classList.remove("elementor-invisible"));
  document.querySelectorAll("[data-aos]").forEach((e) => e.classList.add("aos-animate"));
  document.querySelectorAll(".wow, .reveal, [data-animate], [data-scroll]").forEach((e) => {
    const el = e as HTMLElement;
    if (getComputedStyle(el).opacity === "0") el.style.setProperty("opacity", "1", "important");
    if (getComputedStyle(el).visibility === "hidden") el.style.setProperty("visibility", "visible", "important");
  });
  await new Promise((r) => setTimeout(r, 400));
  // Pass 2 (up): sample what is now rendered, one viewport at a time.
  for (let y = Math.floor((max - 1) / vh) * vh; y >= 0; y -= vh) {
    window.scrollTo({ top: y, behavior: "instant" });
    await new Promise((r) => setTimeout(r, 80));
    sample(y === 0 ? 0 : 120);
  }
  window.scrollTo({ top: 0, behavior: "instant" });
  for (const k of Object.keys(out)) out[k] = out[k]! / Math.max(samples, 1);
  return { shares: out, points };
}

/**
 * Runs in the target page before collection: hide large fixed/sticky overlays (newsletter and
 * discount modals, cookie walls) so they don't pose as the site's design. Returns how many.
 */
export function hideOverlays(): number {
  const vw = window.innerWidth, vh = window.innerHeight;
  const total = document.body?.getElementsByTagName("*").length ?? 0;
  const MARKER = /modal|popup|pop-up|overlay|newsletter|klaviyo|privy|optin|opt-in|cookie|consent|gdpr|lightbox|backdrop|dialog|interstitial|signup|subscribe/i;
  let n = 0;
  for (const el of Array.from(document.body?.querySelectorAll("*") ?? []).slice(0, 8000)) {
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "absolute") continue;
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    const covers = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (covers < vw * vh * 0.3 || (r.top <= 5 && r.height <= 260)) continue;
    // Never hide a wrapper that holds most of the page (smooth-scroll / app-shell layouts).
    if (el.getElementsByTagName("*").length > total * 0.4) continue;
    const label = [el.id, el.getAttribute("class"), el.getAttribute("role"), el.getAttribute("aria-modal") === "true" ? "dialog" : ""].join(" ");
    if (!MARKER.test(label) && el.tagName !== "DIALOG") continue;
    (el as HTMLElement).style.setProperty("display", "none", "important");
    n++;
  }
  if (n) {
    for (const root of [document.documentElement, document.body]) {
      if (root && getComputedStyle(root).overflow === "hidden") root.style.setProperty("overflow", "visible", "important");
    }
  }
  return n;
}

/**
 * Runs in a blank page: keep only surface samples whose screenshot pixel really shows that color
 * (drops points where a photo, video or pseudo-element layer covers the element background).
 * Returns color -> share of all points.
 */
export async function verifySurface([dataUrl, points]: readonly [string, Array<[number, number, string]>]): Promise<Record<string, number>> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const out: Record<string, number> = {};
  for (const [x, y, color] of points) {
    if (x >= c.width || y >= c.height) continue;
    const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
    if (color === "canvas") {
      const k = `rgb(${r}, ${g}, ${b})`;
      out[k] = (out[k] ?? 0) + 1;
      continue;
    }
    const m = color.match(/(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)[ ,]+(\d+(?:\.\d+)?)/);
    if (!m) continue;
    if (Math.abs(r! - +m[1]!) + Math.abs(g! - +m[2]!) + Math.abs(b! - +m[3]!) <= 30) out[color] = (out[color] ?? 0) + 1;
  }
  const n = Math.max(points.length, 1);
  for (const k of Object.keys(out)) out[k] = out[k]! / n;
  return out;
}

/** Runs in a blank page: quantize an image (data URL) into weighted colors. */
export async function imageEdgeColor(dataUrl: string): Promise<[number, number, number] | null> {
  // Dominant opaque color along the image border = what is painted behind a logo capture.
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const counts = new Map<number, number>();
  let opaque = 0, total = 0;
  const at = (x: number, y: number) => {
    const i = (y * c.width + x) * 4;
    total++;
    if (d[i + 3]! < 200) return;
    opaque++;
    const key = ((d[i]! >> 3) << 10) | ((d[i + 1]! >> 3) << 5) | (d[i + 2]! >> 3);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < c.width; x++) (at(x, 0), at(x, c.height - 1));
  for (let y = 1; y < c.height - 1; y++) (at(0, y), at(c.width - 1, y));
  if (!total || opaque / total < 0.6) return null;
  const [key, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
  if (n / opaque < 0.5) return null;
  return [((key >> 10) & 31) * 8 + 4, ((key >> 5) & 31) * 8 + 4, (key & 31) * 8 + 4];
}

export async function paletteFromImage([dataUrl, ignoreTransparent]: readonly [string, boolean]): Promise<Array<{ rgb: [number, number, number]; weight: number }>> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const scale = Math.min(1, 200 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (ignoreTransparent && d[i + 3]! < 128) continue;
    const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const e = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    e.r += r;
    e.g += g;
    e.b += b;
    e.n++;
    buckets.set(key, e);
    total++;
  }
  return [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 40)
    .map((e) => ({ rgb: [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)] as [number, number, number], weight: e.n / Math.max(total, 1) }));
}
