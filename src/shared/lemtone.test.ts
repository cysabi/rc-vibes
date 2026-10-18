import { describe, expect, it } from "vitest";
import { abOf, cssColor, hueChroma, kelvinOf, lemtoneCode, lightRgb, lookOf, lumensText, swatch, whiteAB } from "./lemtone.ts";

describe("lemtone colors", () => {
  it("puts whites where Walter's tool page does", () => {
    // Computed with the tool page's own math (lemtone/web/lemtone_tool.template.html).
    const cases: [number, number, number][] = [
      [2200, 0.110249, 0.185127],
      [2700, 0.074312, 0.15326],
      [2800, 0.069097, 0.146986],
      [4000, 0.032434, 0.080269],
      [6500, 0.008747, -0.005228],
    ];
    for (const [k, a, b] of cases) {
      const [wa, wb] = whiteAB(k);
      expect(wa).toBeCloseTo(a, 6);
      expect(wb).toBeCloseTo(b, 6);
    }
    // 2700 K lands on the firmware's golden 0x07 codes (a 1139, b 1616).
    const [a, b] = whiteAB(2700);
    expect(Math.round(a / 0.0008) + 1046).toBe(1139);
    expect(Math.round(b / 0.0008) + 1424).toBe(1616);
  });

  it("reads whites back as their color temperature, and colors as none", () => {
    for (const k of [2000, 2800, 4000, 6500]) expect(Math.abs(kelvinOf(...whiteAB(k))! - k)).toBeLessThan(5);
    expect(kelvinOf(0.25, 0.05)).toBeNull();
    // ...unless asked for the nearest white.
    expect(kelvinOf(0.08, 0.2, Infinity)).toBeGreaterThan(1700);
  });

  it("turns hue and chroma into a and b and back", () => {
    const [a, b] = abOf(120, 0.2);
    const { hue, chroma } = hueChroma(a, b);
    expect(hue).toBeCloseTo(120, 9);
    expect(chroma).toBeCloseTo(0.2, 9);
    expect(hueChroma(0, -0.1).hue).toBeCloseTo(270, 9);
  });

  it("shows colors as the brightest sRGB of their hue", () => {
    for (const v of swatch(0.069097, 0.146986)) expect(v).toBeGreaterThanOrEqual(0);
    const [r, g, b] = swatch(0.069097, 0.146986);
    expect(r).toBeCloseTo(1, 6); // 2800 K: red-heavy, then green, then blue
    expect(g).toBeLessThan(r);
    expect(b).toBeLessThan(g);
    const red = swatch(0.25, 0.05);
    expect(red[0]).toBeCloseTo(1, 6);
    expect(Math.max(red[1], red[2])).toBeLessThan(0.6);
    // Far outside sRGB still gives a color in range.
    for (const v of swatch(-0.6, -0.9)) expect(v >= 0 && v <= 1).toBe(true);
  });

  it("keeps saturated colors that sRGB can't show in Display P3", () => {
    // A vivid green past sRGB's edge: sRGB has to drop its red, P3 doesn't.
    expect(swatch(-0.26, 0.16)[0]).toBe(0);
    expect(swatch(-0.26, 0.16, "display-p3")[0]).toBeGreaterThan(0.2);
    // White is white either way.
    for (const v of swatch(0, 0, "display-p3")) expect(v).toBeCloseTo(1, 6);
    expect(cssColor([1, 0.5, 0], "srgb", 0.25)).toBe("rgb(255 128 0 / 0.25)");
    expect(cssColor([1, 0.5, 0], "display-p3")).toBe("color(display-p3 1 0.5 0)");
  });

  it("gives light as linear RGB with a luminance of one", () => {
    for (const v of lightRgb(0, 0)) expect(v).toBeCloseTo(1, 6);
    const [r, g, b] = lightRgb(0.069097, 0.146986, "display-p3"); // 2800 K
    expect(0.2289746 * r + 0.6917385 * g + 0.0792869 * b).toBeCloseTo(1, 6);
    expect(r).toBeGreaterThan(g);
  });

  it("dims by how bright a light looks", () => {
    expect(lookOf(0.8)).toBeCloseTo(Math.cbrt(0.8), 9);
    expect(lookOf(2)).toBe(1);
    expect(lookOf(-1)).toBe(0);
  });

  it("writes brightness in lumens and codes people can read", () => {
    expect(lumensText(0.8)).toBe("800 lm");
    expect(lumensText(0.025)).toBe("25 lm");
    expect(lumensText(0.0025)).toBe("2.5 lm");
    expect(lumensText(0)).toBe("0 lm");
    const [a, b] = whiteAB(2800);
    expect(lemtoneCode({ a, b, brightness: 0.8, fidelity: 1 })).toBe("2800 K · 800 lm · F1.00");
    expect(lemtoneCode({ a: 0.2, b: 0, brightness: 0.03, fidelity: 0 })).toBe("0° C0.20 · 30 lm · F0.00");
  });
});
