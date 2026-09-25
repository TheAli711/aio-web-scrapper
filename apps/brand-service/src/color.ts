/** Color parsing, distance and brand-role selection. Pure functions (unit-tested). */

export type RGB = [number, number, number];

export function parseColor(input: string | null | undefined): RGB | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    if (h.length === 8 && parseInt(h.slice(6, 8), 16) < 128) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1]!.split(/[ ,/]+/).filter(Boolean);
    if (p.length < 3) return null;
    if (p.length >= 4 && parseFloat(p[3]!) < 0.5) return null;
    const v = p.slice(0, 3).map((x) => (x.endsWith("%") ? (parseFloat(x) * 255) / 100 : parseFloat(x)));
    if (v.some((x) => !Number.isFinite(x))) return null;
    return v.map((x) => Math.max(0, Math.min(255, Math.round(x)))) as RGB;
  }
  return null;
}

export function toHex([r, g, b]: RGB): string {
  return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function hsl([r, g, b]: RGB): { h: number; s: number; l: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

function toLab([r, g, b]: RGB): [number, number, number] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 distance: ~2 just noticeable, ~10 clearly different, ~25+ different hue family. */
export function deltaE(a: RGB, b: RGB): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Near-white, near-black and greys. Brand colors are chosen from non-neutrals first. */
export function isNeutral(c: RGB): boolean {
  const { s, l } = hsl(c);
  return l > 0.94 || l < 0.08 || s < 0.14 || (s < 0.25 && (l < 0.2 || l > 0.88));
}

/** Very light tints (cream, blush, pale blue): brand-adjacent, but backgrounds rather than primaries. */
export function isTint(c: RGB): boolean {
  return !isNeutral(c) && hsl(c).l >= 0.85;
}

/** Page-builder default palette values nobody chose (Elementor, Astra, WordPress). */
const BUILDER_DEFAULTS = new Set([
  // Elementor
  "#6EC1E4", "#54595F", "#7A7A7A", "#61CE70",
  // Astra (classic and 4.x palettes)
  "#0170B9", "#3A3A3A", "#4B4F58", "#F5F5F5", "#0274BE", "#046BD2", "#045CB4", "#1E293B", "#334155", "#F9FAFB", "#E2E8F0", "#CBD5E1", "#94A3B8",
  // Kadence
  "#2B6CB0", "#3B3B3B", "#215387",
]);

export interface WeightedColor {
  rgb: RGB;
  weight: number;
  sources: Set<string>;
}

/** Normalise a {color -> weight} map so each source contributes a comparable total. */
export function normalise(map: Record<string, number> | Array<{ rgb: RGB; weight: number }>, sourceWeight: number, source: string): WeightedColor[] {
  const entries: Array<[RGB, number]> = Array.isArray(map)
    ? map.map((e) => [e.rgb, e.weight])
    : Object.entries(map).flatMap(([k, w]) => {
        const c = parseColor(k);
        return c ? [[c, w] as [RGB, number]] : [];
      });
  const total = entries.reduce((a, [, w]) => a + w, 0);
  if (total <= 0) return [];
  return entries.map(([rgb, w]) => ({ rgb, weight: (w / total) * sourceWeight, sources: new Set([source]) }));
}

/** Greedy clustering: merge colors closer than `threshold` into the heaviest representative. */
export function cluster(colors: WeightedColor[], threshold = 12): WeightedColor[] {
  const sorted = [...colors].sort((a, b) => b.weight - a.weight);
  const out: WeightedColor[] = [];
  for (const c of sorted) {
    const hit = out.find((o) => deltaE(o.rgb, c.rgb) < threshold);
    if (hit) {
      hit.weight += c.weight;
      for (const s of c.sources) hit.sources.add(s);
    } else out.push({ rgb: c.rgb, weight: c.weight, sources: new Set(c.sources) });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/**
 * Summarise a logo's ink (pixels that differ from its backdrop): main colors and tone.
 * Tone: "dark" logo for light backgrounds, "light" logo for dark backgrounds, "color" when a
 * saturated color carries a real share. Mid-grey anti-aliasing pixels are ignored for tone.
 */
export function logoInk(palette: Array<{ rgb: RGB; weight: number }>): { tone: "dark" | "light" | "color" | null; colors: string[] } {
  if (!palette.length) return { tone: null, colors: [] };
  let dark = 0, light = 0, chroma = 0;
  for (const { rgb, weight } of palette) {
    const { s, l } = hsl(rgb);
    if (s > 0.3 && l > 0.15 && l < 0.85) chroma += weight;
    else if (l < 0.4) dark += weight;
    else if (l > 0.75) light += weight;
  }
  const tone = chroma >= 0.3 ? "color" : dark >= light ? "dark" : "light";
  const colors = cluster(palette.map((p) => ({ rgb: p.rgb, weight: p.weight, sources: new Set(["logo"]) })), 18)
    .filter((c) => c.weight >= 0.08)
    .slice(0, 4)
    .map((c) => toHex(c.rgb));
  return { tone, colors };
}

export interface ColorInputs {
  buttons: Record<string, number>;
  links: Record<string, number>;
  headings: Record<string, number>;
  background: Record<string, number>;
  text: Record<string, number>;
  paragraphs: Record<string, number>;
  borders: Record<string, number>;
  header: Record<string, number>;
  footer: string | null;
  body: string | null;
  themeColor: string | null;
  cssVars: Record<string, string>;
  logo: Array<{ rgb: RGB; weight: number }>;
  screenshot: Array<{ rgb: RGB; weight: number }>;
}

export interface PaletteEntry {
  hex: string;
  weight: number;
  sources: string[];
}

export interface BrandColors {
  primary: string | null;
  secondary: string | null;
  accent: string | null;
  background: string | null;
  text: string | null;
  palette: PaletteEntry[];
  /** Signals behind the primary, e.g. "buttons+logo+header". */
  basis: string;
  confidence: "high" | "medium" | "low";
}

/** Relative weight of each signal when picking brand colors. */
const SOURCE_WEIGHTS: Record<string, number> = {
  buttons: 5,
  logo: 4,
  cssvar: 3,
  header: 2.5,
  links: 2,
  headings: 2,
  borders: 1,
  background: 2,
  footer: 1.5,
  theme: 2,
  screenshot: 1.5,
};

const CARRIERS = ["buttons", "logo", "header", "cssvar"];

/** Different enough to be a second brand color, not a shade of the first. */
export function distinctRole(a: RGB, b: RGB): boolean {
  if (deltaE(a, b) < 20) return false;
  if (isNeutral(a) !== isNeutral(b)) return true;
  const ha = hsl(a), hb = hsl(b);
  const dh = Math.min(Math.abs(ha.h - hb.h), 360 - Math.abs(ha.h - hb.h));
  return dh >= 30 || Math.abs(ha.l - hb.l) >= 0.3;
}

export function pickColors(inp: ColorInputs): BrandColors {
  const single = (c: string | null, name: string): WeightedColor[] => {
    const rgb = parseColor(c);
    return rgb ? [{ rgb, weight: SOURCE_WEIGHTS[name]!, sources: new Set([name]) }] : [];
  };
  const namedVars = Object.entries(inp.cssVars).filter(([, v]) => {
    const c = parseColor(v);
    return c && !BUILDER_DEFAULTS.has(toHex(c));
  });
  const brandVars = namedVars.filter(([k]) => /primary|secondary|accent|brand|theme|global-color-0|palette1/.test(k)).map(([, v]) => v);
  const primaryVar = parseColor(namedVars.find(([k]) => /primary|global-color-0|palette1/.test(k))?.[1]);

  const pooled: WeightedColor[] = [
    ...normalise(inp.buttons, SOURCE_WEIGHTS.buttons!, "buttons"),
    ...normalise(inp.logo, SOURCE_WEIGHTS.logo!, "logo"),
    ...normalise(Object.fromEntries(brandVars.map((v) => [v, 1])), SOURCE_WEIGHTS.cssvar!, "cssvar"),
    ...normalise(inp.header, SOURCE_WEIGHTS.header!, "header"),
    ...normalise(inp.links, SOURCE_WEIGHTS.links!, "links"),
    ...normalise(inp.headings, SOURCE_WEIGHTS.headings!, "headings"),
    ...normalise(inp.borders, SOURCE_WEIGHTS.borders!, "borders"),
    ...normalise(inp.background, SOURCE_WEIGHTS.background!, "background"),
    ...single(inp.footer, "footer"),
    ...single(inp.themeColor, "theme"),
    ...normalise(inp.screenshot, SOURCE_WEIGHTS.screenshot!, "screenshot"),
  ];
  const clusters = cluster(pooled);
  // A color seen only in the screenshot (e.g. a photo) is not a brand color.
  const support = (c: WeightedColor) => [...c.sources].filter((s) => s !== "screenshot").length;

  // Page surface: the most-painted neutral or tint. Saturated full-width sections are brand
  // sections, not the background. Screenshot pixels only break ties (hidden content can leave
  // large gaps of body color in a headless capture).
  const surface = (c: WeightedColor) => isNeutral(c.rgb) || isTint(c.rgb);
  const bgC =
    cluster([
      ...normalise(inp.background, 1, "background"),
      ...normalise(inp.screenshot, 0.3, "screenshot"),
      ...single(inp.body, "background").map((c) => ({ ...c, weight: 0.1 })),
    ]).filter(surface)[0] ?? cluster(single(inp.body, "background"))[0];
  const background = bgC ? toHex(bgC.rgb) : null;
  const bgRgb = bgC?.rgb ?? null;
  const textC = cluster(normalise(Object.keys(inp.paragraphs).length ? inp.paragraphs : inp.text, 1, "text"))[0];
  const text = textC ? toHex(textC.rgb) : null;

  /**
   * Brand score = pooled weight x role multiplier. Saturated colors win; tints (cream, blush)
   * count when a brand-carrying element (header, button, logo) uses them; dark neutrals
   * (black, charcoal, espresso) count when buttons / logo / CSS brand vars use them, so
   * monochrome brands still get a primary. Plain body text and page background don't count.
   */
  const score = (c: WeightedColor): number => {
    if (support(c) === 0) return 0;
    const has = (s: string) => c.sources.has(s);
    const carrier = CARRIERS.some(has);
    const { l } = hsl(c.rgb);
    let m: number;
    if (!isNeutral(c.rgb) && !isTint(c.rgb)) m = support(c) >= 2 || has("buttons") || has("logo") ? 1 : 0.5;
    else if (isTint(c.rgb)) m = carrier ? 0.7 : 0.3;
    else if (l < 0.4 && (has("buttons") || has("cssvar") || has("logo"))) m = 0.45;
    else if (carrier && l >= 0.4 && l <= 0.85) m = 0.25;
    else return 0;
    if (bgRgb && deltaE(c.rgb, bgRgb) < 6 && !has("buttons")) m *= 0.5;
    if (primaryVar && deltaE(c.rgb, primaryVar) < 12) m *= 1.5;
    return c.weight * m;
  };
  const ranked = clusters
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const primary = ranked[0]?.c;
  // Secondary: a second hue when the brand has one (black/white/grey are not a "secondary color"
  // unless the brand has nothing else), otherwise the strongest distinct brand neutral.
  const distinctRanked = ranked.filter((x) => primary && x.c !== primary && distinctRole(x.c.rgb, primary.rgb));
  const topScore = ranked[0]?.s ?? 0;
  const secondary = (distinctRanked.find((x) => !isNeutral(x.c.rgb) && x.s >= topScore * 0.15) ?? distinctRanked[0])?.c;
  const accent = ranked.find(
    (x) => x.c !== primary && x.c !== secondary && !isNeutral(x.c.rgb) && [primary, secondary].every((o) => !o || distinctRole(x.c.rgb, o.rgb)),
  )?.c;

  let confidence: BrandColors["confidence"] = "low";
  if (primary) {
    const s = support(primary);
    const margin = ranked[1] ? ranked[0]!.s / ranked[1].s : 3;
    confidence = (s >= 3 || (primary.sources.has("buttons") && primary.sources.has("logo"))) && margin >= 1.2 ? "high" : s >= 2 ? "medium" : "low";
  }
  const byWeight = (a: string, b: string) => (SOURCE_WEIGHTS[b] ?? 0) - (SOURCE_WEIGHTS[a] ?? 0);

  const palette = clusters
    .filter((c) => support(c) >= 1 || c.weight > 0.3)
    .slice(0, 8)
    .map((c) => ({ hex: toHex(c.rgb), weight: Math.round(c.weight * 100) / 100, sources: [...c.sources].sort(byWeight) }));

  return {
    primary: primary ? toHex(primary.rgb) : null,
    secondary: secondary ? toHex(secondary.rgb) : null,
    accent: accent ? toHex(accent.rgb) : null,
    background,
    text,
    palette,
    basis: primary ? [...primary.sources].sort(byWeight).join("+") : "none",
    confidence,
  };
}
