import { describe, expect, it } from "vitest";
import { SOLVERS } from "../../../src/shared/devices.ts";
import { br30, lemtone, palettes, white } from "./color.ts";
import { abOf } from "./lemtone.ts";

const { output: bulbOutput, solve } = SOLVERS.bulb;

const exact = (a: number, b: number, lm: number) => solve(a, b, lm, 1).mode === "exact";

/** The most lumens of hue h and chroma c the bulb model makes exactly (by bisection), or 0 under 1 lm. */
function truth(h: number, c: number): number {
  const [a, b] = abOf(h, c);
  if (!exact(a, b, 1)) return 0;
  let lo = 1;
  let hi = 5000;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (exact(a, b, mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

// The same spread of colors every run.
function* colors(n: number) {
  let seed = 7;
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < n; i++) yield [next() * 360, next() * 0.8] as const;
}

describe("what a color bulb can make", () => {
  it("knows what the bulb model makes, to within a few percent away from the edge", () => {
    let checked = 0;
    const ratios: number[] = [];
    for (const [h, c] of colors(600)) {
      const edge = br30.edgeOf(h);
      if (c > edge) continue;
      const most = br30.maxLm(lemtone(h, c));
      const real = truth(h, c);
      const at = `${h.toFixed(1)}° C${c.toFixed(3)}`;
      // Near the edge it can be well under (never far over); away from it, close.
      expect(most, at).toBeLessThan(real * 1.1 + 0.5);
      if (c < edge * 0.9) {
        expect(most, at).toBeGreaterThan(real * 0.9);
        ratios.push(most / real);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(250);
    ratios.sort((a, b) => a - b);
    expect(ratios[Math.floor(ratios.length * 0.95)]).toBeLessThan(1.03);
  });

  it("never says a bulb makes a color it can't", () => {
    for (const [h, c] of colors(600)) if (truth(h, c) === 0) expect(br30.maxLm(lemtone(h, c)), `${h.toFixed(1)}° C${c.toFixed(3)}`).toBe(0);
  });

  it("makes whites bright and saturated colors dim", () => {
    expect(br30.maxLm(white(4000))).toBeGreaterThan(900);
    expect(br30.maxLm(white(2700))).toBeGreaterThan(450);
    expect(br30.maxLm("1700K")).toBe(0);
    expect(br30.maxLm(lemtone(265, 0.65))).toBeLessThan(br30.maxLm(lemtone(265, 0.2)) / 4);
    expect(br30.maxLm(lemtone(55, 0.4))).toBe(0);
  });

  it("dims a color past what the bulb makes, instead of letting it pale", () => {
    for (const [h, c] of colors(400)) {
      if (c > br30.edgeOf(h) * 0.99) continue;
      const asked = lemtone(h, c, 2000);
      const v = asked.vivid();
      if (v.lm < 1) continue;
      expect(v.a).toBe(asked.a);
      expect(v.b).toBe(asked.b);
      // The bulb makes it as asked, or so nearly that no one could tell (the picker's own "still a white" is 0.005).
      const made = bulbOutput({ a: v.a, b: v.b, brightness: v.lm / 1000, fidelity: 1 }).light;
      expect(Math.hypot(made.a - v.a, made.b - v.b), `${h.toFixed(1)}° C${c.toFixed(3)} at ${v.lm.toFixed(1)} lm`).toBeLessThan(0.003);
    }
    const dim = lemtone(265, 0.4, 5);
    expect(dim.vivid()).toBe(dim);
    expect(br30.vivid("#0000ff").lm).toBeLessThan(hex0000ff());
  });

  it("brings in a color more saturated than a bulb makes at all, to the most it does", () => {
    const v = lemtone(265, 0.9, 300).vivid();
    expect(v.hue).toBeCloseTo(265, 6);
    expect(v.chroma).toBeCloseTo(br30.edgeOf(265) * 0.999, 9);
    expect(v.lm).toBeGreaterThan(0);
    expect(exact(v.a, v.b, v.lm)).toBe(true);
  });

  it("starts people with palettes the bulbs can make", () => {
    for (const [name, p] of Object.entries(palettes)) {
      for (const stop of p.stops) expect(stop.lm, `${name}: ${stop}`).toBeLessThanOrEqual(br30.maxLm(stop));
    }
  });
});

// A screen's full blue asks for about 72 lm: more than a bulb makes of it.
const hex0000ff = () => 72;
