import { describe, expect, it } from "vitest";
import { distinctRole, isNeutral, isTint, logoInk, parseColor, pickColors, toHex, type ColorInputs, type RGB } from "../src/color.js";

const base = (o: Partial<ColorInputs> = {}): ColorInputs => ({
  buttons: {}, links: {}, headings: {}, background: {}, text: {}, paragraphs: {}, borders: {}, header: {},
  footer: null, body: "rgb(255, 255, 255)", themeColor: null, cssVars: {}, logo: [], screenshot: [], ...o,
});

describe("color parsing", () => {
  it("parses hex, rgb and rgba, dropping mostly transparent colors", () => {
    expect(parseColor("#abc")).toEqual([170, 187, 204]);
    expect(parseColor("#6B8F71")).toEqual([107, 143, 113]);
    expect(parseColor("rgb(180, 121, 90)")).toEqual([180, 121, 90]);
    expect(parseColor("rgba(0, 0, 0, 0)")).toBeNull();
    expect(parseColor("rgba(0 0 0 / 0.2)")).toBeNull();
    expect(parseColor("transparent")).toBeNull();
    expect(toHex([107, 143, 113])).toBe("#6B8F71");
  });

  it("classifies neutrals and tints", () => {
    expect(isNeutral([0, 0, 0])).toBe(true);
    expect(isNeutral([245, 245, 245])).toBe(true);
    expect(isNeutral([107, 143, 113])).toBe(false);
    expect(isTint([246, 200, 211])).toBe(true); // blush
    expect(isTint([107, 143, 113])).toBe(false);
  });

  it("treats shades of one hue as the same role", () => {
    expect(distinctRole([186, 218, 85], [134, 163, 41])).toBe(false); // lime / darker lime
    expect(distinctRole([107, 143, 113], [180, 121, 90])).toBe(true); // green / terracotta
    expect(distinctRole([107, 143, 113], [0, 0, 0])).toBe(true); // hue / neutral
  });
});

describe("pickColors", () => {
  it("prefers the button color over body text and page background", () => {
    const c = pickColors(base({
      buttons: { "rgb(107, 143, 113)": 3 },
      text: { "rgb(0, 0, 0)": 500 },
      paragraphs: { "rgb(17, 17, 17)": 400 },
      background: { "rgb(255, 255, 255)": 0.7, "rgb(180, 121, 90)": 0.2 },
      headings: { "rgb(180, 121, 90)": 50 },
    }));
    expect(c.primary).toBe("#6B8F71");
    expect(c.secondary).toBe("#B4795A");
    expect(c.background).toBe("#FFFFFF");
    expect(c.text).toBe("#111111");
  });

  it("gives monochrome brands a dark primary", () => {
    const c = pickColors(base({
      buttons: { "rgb(0, 0, 0)": 4 },
      logo: [{ rgb: [10, 10, 10] as RGB, weight: 1 }],
      background: { "rgb(255, 255, 255)": 1 },
      links: { "rgb(113, 113, 113)": 20 },
    }));
    expect(c.primary).toBe("#000000");
  });

  it("uses a named primary CSS variable, but ignores page-builder defaults", () => {
    const c = pickColors(base({
      buttons: { "rgb(54, 48, 42)": 2 },
      header: { "rgb(236, 228, 218)": 1 },
      background: { "rgb(236, 228, 218)": 1 },
      cssVars: { "--custom-primary-color": "#36302a", "--e-global-color-primary": "#6EC1E4" },
    }));
    expect(c.primary).toBe("#36302A");
    expect(c.palette.map((p) => p.hex)).not.toContain("#6EC1E4");
  });

  it("returns nulls and low confidence without signals", () => {
    const c = pickColors(base({ body: null }));
    expect(c.primary).toBeNull();
    expect(c.confidence).toBe("low");
  });
});

describe("logoInk", () => {
  it("calls a black wordmark dark and a white one light", () => {
    expect(logoInk([{ rgb: [5, 5, 5], weight: 0.7 }, { rgb: [120, 120, 120], weight: 0.3 }]).tone).toBe("dark");
    expect(logoInk([{ rgb: [253, 254, 254], weight: 1 }]).tone).toBe("light");
    expect(logoInk([{ rgb: [198, 60, 145], weight: 0.6 }, { rgb: [0, 0, 0], weight: 0.4 }]).tone).toBe("color");
    expect(logoInk([]).tone).toBeNull();
  });

  it("keeps a small saturated brand color ahead of anti-aliasing greys", () => {
    // Black wordmark with an orange "hive" and grey tagline, JPEG on white (shophive.com).
    const ink: Array<{ rgb: RGB; weight: number }> = [
      { rgb: [54, 53, 58], weight: 0.2 }, { rgb: [27, 26, 27], weight: 0.08 }, { rgb: [69, 75, 84], weight: 0.06 },
      { rgb: [220, 219, 220], weight: 0.1 }, { rgb: [188, 188, 188], weight: 0.08 }, { rgb: [203, 203, 203], weight: 0.07 },
      { rgb: [116, 116, 116], weight: 0.09 }, { rgb: [147, 147, 147], weight: 0.06 }, { rgb: [131, 131, 132], weight: 0.05 },
      { rgb: [244, 106, 60], weight: 0.03 }, { rgb: [245, 117, 75], weight: 0.02 }, { rgb: [244, 102, 58], weight: 0.015 },
      { rgb: [251, 186, 51], weight: 0.02 }, { rgb: [252, 173, 52], weight: 0.015 },
    ];
    const { tone, colors } = logoInk(ink);
    expect(tone).toBe("dark");
    expect(colors[0]).toBe("#36353A");
    expect(colors[1]).toBe("#F46A3C");
    expect(colors).toContain("#FBBA33");
  });

  it("does not promote faint color noise in a monochrome logo", () => {
    const { colors } = logoInk([
      { rgb: [10, 10, 10], weight: 0.8 }, { rgb: [128, 128, 128], weight: 0.18 }, { rgb: [200, 60, 60], weight: 0.02 },
    ]);
    expect(colors).toEqual(["#0A0A0A", "#808080"]);
  });
});
