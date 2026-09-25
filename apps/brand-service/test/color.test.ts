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
});
