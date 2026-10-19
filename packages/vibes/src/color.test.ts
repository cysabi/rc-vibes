import { describe, expect, it } from "vitest";
import { Color, color, hex, hsl, lemtone, off, oklab, oklch, palette, rgb, toPalette, white, xy } from "./color.ts";

const close = (c: Color, d: Color, digits = 6) => {
  expect(c.a).toBeCloseTo(d.a, digits);
  expect(c.b).toBeCloseTo(d.b, digits);
  expect(c.lm).toBeCloseTo(d.lm, Math.max(0, digits - 4));
};

describe("lumens", () => {
  it("are rigid, with a screen's white at 1000 lm", () => {
    const w = rgb(1, 1, 1);
    expect(w.lm).toBeCloseTo(1000, 3);
    expect(Math.abs(w.a)).toBeLessThan(1e-4);
    expect(Math.abs(w.b)).toBeLessThan(1e-4);
    // As dim, next to white, as on a screen: by luminance.
    expect(hex("#0000ff").lm).toBeCloseTo(72.2, 0);
    expect(hex("#ff0000").lm).toBeCloseTo(212.6, 0);
    expect(hex("#808080").lm).toBeCloseTo(215.9, 0);
    expect(oklch(1, 0, 0).lm).toBeCloseTo(1000, 3);
    expect(oklch(0.5, 0, 0).lm).toBeCloseTo(125, 3);
    expect(hex("#000").lm).toBe(0);
  });

  it("are given straight for whites and the lights' own colors", () => {
    expect(white(2700, 400).lm).toBe(400);
    expect(white(2700).lm).toBe(1000);
    expect(lemtone(265, 0.3, 40).lm).toBe(40);
    expect(hex("#f80").at(120).lm).toBe(120);
  });
});

describe("making colors", () => {
  it("makes whites where Walter's tool page puts them", () => {
    const c = white(2700, 400);
    expect(c.a).toBeCloseTo(0.074312, 6);
    expect(c.b).toBeCloseTo(0.15326, 6);
    expect(c.kelvin).toBeCloseTo(2700, -1);
    expect(white("3000K").kelvin).toBeCloseTo(3000, -1);
    expect(white()).toEqual(new Color(0, 0, 1000));
  });

  it("makes the lights' own colors by hue and chroma", () => {
    const c = lemtone(110, 0.2, 60);
    expect(c.hue).toBeCloseTo(110, 9);
    expect(c.chroma).toBeCloseTo(0.2, 9);
    expect(c.kelvin).toBeNull();
  });

  it("reads CSS's spaces as CSS does", () => {
    expect(hsl(240, 1, 0.5).hex).toBe("#0000ff");
    expect(hsl(240, 100, 50).hex).toBe("#0000ff");
    expect(hsl(120, 1, 0.5).hex).toBe("#00ff00");
    expect(hsl(60, 1, 0.5).hex).toBe("#ffff00");
    expect(rgb(255, 136, 0).hex).toBe("#ff8800");
    const o = oklch(0.7, 0.2, 265).oklch;
    expect(o.l).toBeCloseTo(0.7, 6);
    expect(o.c).toBeCloseTo(0.2, 6);
    expect(o.h).toBeCloseTo(265, 4);
    close(oklch(70, 0.2, 265), oklch(0.7, 0.2, 265));
    // OKLCh's chroma is at its lightness; the lights' is at full lightness.
    expect(oklch(0.5, 0.1, 265).chroma).toBeCloseTo(0.2, 3);
    close(oklab(0.6, 0.1, -0.05), color("oklab(0.6 0.1 -0.05)"));
    const d65 = xy(0.3127, 0.329);
    expect(Math.abs(d65.a)).toBeLessThan(2e-3);
    expect(Math.abs(d65.b)).toBeLessThan(2e-3);
  });

  it("reads text of every kind", () => {
    const orange = hex("#ff8800");
    for (const text of ["#ff8800", "ff8800", "#f80", "F80", " #FF8800 ", "rgb(255, 136, 0)", "rgb(255 136 0)", "rgb(100% 53.33% 0%)", "rgba(255,136,0,1)", "color(srgb 1 0.5333 0)"]) {
      close(color(text), orange, 3);
    }
    expect(color("orange").hex).toBe("#ffa500");
    expect(color("RebeccaPurple").hex).toBe("#663399");
    expect(color("light blue").hex).toBe("#add8e6");
    expect(color("hsl(240 100% 50%)").hex).toBe("#0000ff");
    expect(color("hsl(240deg, 100%, 50%)").hex).toBe("#0000ff");
    expect(color("hsl(0.6667turn 100% 50%)").hex).toBe("#0000ff");
    expect(color("hwb(240 0% 0%)").hex).toBe("#0000ff");
    close(color("oklch(70% 0.2 265)"), oklch(0.7, 0.2, 265));
    close(color("oklch(0.7 50% 265deg)"), oklch(0.7, 0.2, 265));
    const labWhite = color("lab(100 0 0)");
    expect(labWhite.lm).toBeCloseTo(1000, 0);
    expect(Math.abs(labWhite.a)).toBeLessThan(1e-3);
    expect(Math.abs(labWhite.b)).toBeLessThan(1e-3);
    close(color("lch(50 0 0)"), color("lab(50 0 0)"));
    expect(color("color(display-p3 1 1 1)").lm).toBeCloseTo(1000, 0);
    // Display P3's red is redder than sRGB's.
    expect(color("color(display-p3 1 0 0)").chroma).toBeGreaterThan(color("red").chroma);
    expect(color("color(xyz 0.9505 1 1.089)").lm).toBeCloseTo(1000, 3);
  });

  it("reads color temperatures, and the lights' own way of writing colors", () => {
    for (const text of ["2700K", "2700 k", "2700 kelvin", "white(2700)", "kelvin(2700)"]) expect(color(text).kelvin).toBeCloseTo(2700, -1);
    expect(color("candlelight").kelvin).toBeCloseTo(1850, -1);
    expect(color("daylight").kelvin).toBeCloseTo(6500, -1);
    close(color("lemtone(265 0.3 40)"), lemtone(265, 0.3, 40));
    close(color("265° C0.3 · 40 lm"), lemtone(265, 0.3, 40));
  });

  it("reads lumens and fidelity alongside a color", () => {
    expect(color("#f80 · 120 lm").lm).toBe(120);
    expect(color("2700k @ 400lm").lm).toBe(400);
    expect(color("2700k 400lm").lm).toBe(400);
    expect(color("orange 50 lumens").lm).toBe(50);
    expect(color("white(3000 200)").lm).toBe(200);
    expect(color("rgb(255 0 0) · 30 lm · F0.25").fidelity).toBe(0.25);
    expect(color("2700 K · 400 lm · fidelity 0").fidelity).toBe(0);
  });

  it("reads alpha as less light", () => {
    const full = hex("#ff8800").lm;
    expect(color("#ff880080").lm).toBeCloseTo(full * (128 / 255), 6);
    expect(color("rgba(255, 136, 0, 0.5)").lm).toBeCloseTo(full / 2, 6);
    expect(color("rgb(255 136 0 / 50%)").lm).toBeCloseTo(full / 2, 6);
    expect(rgb(1, 0.5333, 0, 0.25).lm).toBeCloseTo(hex("#ff8800").lm / 4, 0);
  });

  it("prints itself so it reads back", () => {
    expect(white(2700, 400).toString()).toBe("2700 K · 400 lm");
    expect(lemtone(265, 0.3, 40).toString()).toBe("265° C0.300 · 40 lm");
    expect(off.toString()).toBe("off");
    for (const c of [white(2700, 400), lemtone(265, 0.3, 40), lemtone(30, 0.2, 12.5).with({ fidelity: 0.5 })]) {
      const back = color(c.toString());
      expect(back.a).toBeCloseTo(c.a, 2);
      expect(back.b).toBeCloseTo(c.b, 2);
      expect(back.lm).toBe(c.lm);
      expect(back.fidelity).toBe(c.fidelity);
    }
    expect(JSON.parse(JSON.stringify(white(2700, 400)))).toEqual({ ...white(2700, 400) });
    close(color(JSON.parse(JSON.stringify(lemtone(200, 0.1, 30)))), lemtone(200, 0.1, 30));
  });

  it("reads numbers, lists and objects", () => {
    expect(color(2700).kelvin).toBeCloseTo(2700, -1);
    close(color([1, 0.5, 0]), rgb(1, 0.5, 0));
    close(color([255, 128, 0]), rgb(1, 128 / 255, 0));
    const c = lemtone(40, 0.2, 300);
    close(color({ a: c.a, b: c.b, lm: 300 }), c);
    // arclamp's own channels.
    close(color({ a: c.a, b: c.b, brightness: 0.3, fidelity: 1 }), c);
    expect(color({ a: 0.1, b: 0.1 }).lm).toBe(1000);
    close(color({ r: 1, g: 0.5, b: 0 }), rgb(1, 0.5, 0));
    close(color({ r: 255, g: 128, b: 0 }), rgb(255, 128, 0));
    close(color({ r: "1", g: "0.5", b: "0" }), rgb(1, 0.5, 0));
    close(color({ h: 240, s: 1, l: 0.5 }), hsl(240, 1, 0.5));
    close(color({ h: 240, s: 100, l: 50 }), hsl(240, 1, 0.5));
    close(color({ l: 0.7, c: 0.2, h: 265 }), oklch(0.7, 0.2, 265));
    close(color({ hue: 265, chroma: 0.3, lm: 40 }), lemtone(265, 0.3, 40));
    expect(color({ kelvin: 3000, lm: 200 }).lm).toBe(200);
    expect(color({ k: 3000 }).kelvin).toBeCloseTo(3000, -1);
    close(color({ x: 0.3127, y: 0.329 }), xy(0.3127, 0.329));
    expect(color({ on: 1 }).lm).toBe(800);
    expect(color({ on: true }).kelvin).toBeCloseTo(2700, -1);
    expect(color({ on: 0 })).toBe(off);
    expect(color({ lumens: 300 }).lm).toBe(300);
    expect(color(null as never)).toBe(off);
    expect(color(undefined as never)).toBe(off);
    const same = white(2700, 5);
    expect(color(same)).toBe(same);
    expect(Color.from("#f80", 30).lm).toBe(30);
  });

  it("says what it can't read, and how to say it", () => {
    expect(() => color("blurple")).toThrow(/isn't a color I can read.*2700K/);
    expect(() => color({ foo: 1 })).toThrow(/r, g, b/);
    expect(() => color(0.5)).toThrow(/kelvin/);
    expect(() => color([1, 2])).toThrow(/\[r, g, b\]/);
  });
});

describe("reading colors", () => {
  it("gives the lights' terms, arclamp's, and screens'", () => {
    const c = white(4000, 500);
    expect(c.looks).toBeCloseTo(Math.cbrt(0.5), 9);
    expect(c.brightness).toBe(0.5);
    expect(c.channels).toEqual({ a: c.a, b: c.b, brightness: 0.5, fidelity: 1 });
    expect(c.nearestKelvin).toBeCloseTo(4000, -1);
    expect(lemtone(200, 0.3, 1).nearestKelvin).toBeGreaterThan(1600);
    expect(hex("#ff8800").hex).toBe("#ff8800");
    expect(hex("#ff8800").rgb.r).toBeCloseTo(1, 6);
    const h = hex("#ff8800").hsl;
    expect(h.h).toBeCloseTo(32, 0);
    expect(h.s).toBeCloseTo(1, 6);
    expect(white(6500, 2000).rgb.r).toBeGreaterThan(1);
    expect(white(6500, 2000).hex).toBe("#ffffff");
    const { x, y } = white().xy;
    expect(x).toBeCloseTo(0.3127, 3);
    expect(y).toBeCloseTo(0.329, 3);
    expect(white(2700, 0).xyz).toEqual([0, 0, 0]);
  });
});

describe("changing colors", () => {
  it("never changes the color it's called on", () => {
    const c = white(2700, 100);
    const copy = { ...c };
    c.at(5).dim(2).fade(0.5).shiftHue(40).saturate(2).mix(off, 0.3).add(c).with({ fidelity: 0 });
    expect({ ...c }).toEqual(copy);
    expect(Object.isFrozen(off)).toBe(true);
  });

  it("dims by the lumen and fades by the look", () => {
    const c = white(4000, 800);
    expect(c.dim(0.5).lm).toBe(400);
    expect(c.fade(0.5).lm).toBe(100);
    expect(c.at(30).a).toBe(c.a);
  });

  it("changes any part with with()", () => {
    const c = lemtone(100, 0.2, 50);
    expect(c.with({ fidelity: 0 }).fidelity).toBe(0);
    expect(c.with({ hue: 200 }).hue).toBeCloseTo(200, 9);
    expect(c.with({ hue: 200 }).chroma).toBeCloseTo(0.2, 9);
    expect(c.with({ kelvin: 3000 }).kelvin).toBeCloseTo(3000, -1);
    expect(c.with({ lumens: 7 }).lm).toBe(7);
    expect(c.with({ brightness: 0.25 }).lm).toBe(250);
  });

  it("turns hue and scales chroma", () => {
    const c = lemtone(100, 0.2, 50);
    expect(c.shiftHue(30).hue).toBeCloseTo(130, 9);
    expect(c.shiftHue(300).hue).toBeCloseTo(40, 9);
    expect(c.saturate(1.5).chroma).toBeCloseTo(0.3, 9);
  });
});

describe("mixing", () => {
  it("fades evenly as it looks, and holds its ends", () => {
    const a = white(2700, 0);
    const b = white(2700, 1000);
    expect(a.mix(b, 0.5).lm).toBeCloseTo(125, 9);
    expect(a.mix(b).lm).toBeCloseTo(125, 9);
    expect(a.mix(b, 0)).toBe(a);
    expect(a.mix(b, 1)).toBe(b);
    expect(a.mix(b, 7)).toBe(b);
  });

  it("keeps the color when fading to or from dark", () => {
    const red = lemtone(30, 0.3, 40);
    const half = red.mix(off, 0.5);
    expect(half.hue).toBeCloseTo(30, 9);
    expect(half.chroma).toBeCloseTo(0.3, 9);
    expect(off.mix(red, 0.5).a).toBe(red.a);
  });

  it("goes straight through OKLab, taking anything that says a color", () => {
    const m = lemtone(0, 0.2, 100).mix(lemtone(180, 0.2, 100), 0.5);
    expect(m.chroma).toBeCloseTo(0, 9);
    expect(m.lm).toBeCloseTo(100, 9);
    close(white(2700, 100).mix("#ff8800", 0.5), white(2700, 100).mix(hex("#ff8800"), 0.5));
    close(white(2700, 100).mix(6500), white(2700, 100).mix(white(6500)));
  });

  it("adds lights as light", () => {
    const c = lemtone(265, 0.3, 20);
    const twice = c.add(c);
    expect(twice.lm).toBeCloseTo(40, 9);
    // To OKLab's precision: its published inverses round-trip to about 1e-8.
    expect(twice.a).toBeCloseTo(c.a, 7);
    expect(twice.b).toBeCloseTo(c.b, 7);
    const k = white(2700, 100).add(white(6500, 100)).nearestKelvin;
    expect(k).toBeGreaterThan(3200);
    expect(k).toBeLessThan(5000);
    expect(white(2700, 10).add("#00f", { a: 0, b: 0, lm: 5 }).lm).toBeCloseTo(10 + hex("#00f").lm + 5, 6);
    close(c.add(), c);
    expect(off.add(off)).toBe(off);
    expect(off.add(white(4000, 50).with({ fidelity: 0 })).fidelity).toBeCloseTo(0, 9);
  });
});

describe("palettes", () => {
  it("runs through its stops from 0 to 1 and holds the ends", () => {
    const p = palette(lemtone(0, 0.2, 10), lemtone(120, 0.2, 10), lemtone(240, 0.2, 10));
    expect(p(0)).toEqual(p.stops[0]);
    expect(p(0.5)).toEqual(p.stops[1]);
    expect(p(1)).toEqual(p.stops[2]);
    expect(p(-3)).toEqual(p.stops[0]);
    expect(p(7)).toEqual(p.stops[2]);
    expect(p(NaN)).toEqual(p.stops[0]);
    expect(palette(white(2700, 5))(0.4)).toEqual(white(2700, 5));
    expect(() => palette()).toThrow();
  });

  it("takes stops as anything that says a color, in a list, or at places", () => {
    const p = palette(["black", "#f80", "white"]);
    expect(p.stops.map((s) => s.hex)).toEqual(["#000000", "#ff8800", "#ffffff"]);
    const placed = palette([0, "black"], [0.2, "#f80"], [1, 6500]);
    expect(placed.positions).toEqual([0, 0.2, 1]);
    expect(placed(0.2).hex).toBe("#ff8800");
    expect(palette([1, 0.5, 0]).stops).toHaveLength(1);
  });

  it("are made from one color, dark to it", () => {
    const p = toPalette("#f80");
    expect(p(0).lm).toBe(0);
    expect(p(1).hex).toBe("#ff8800");
    expect(toPalette(["red", "blue"]).stops).toHaveLength(2);
    expect(toPalette(p)).toBe(p);
  });
});
