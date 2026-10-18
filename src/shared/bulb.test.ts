import { describe, expect, it } from "vitest";
import { bulbOutput, forward, solve, type SolveMode } from "./bulb.ts";
import { SOLVE_VECTORS } from "./bulb.vectors.ts";
import { MODEL } from "./bulb.model.ts";
import { hueChroma, whiteAB } from "./lemtone.ts";

const MODES: SolveMode[] = ["off", "exact", "desat", "clamp"];

describe("bulb solve", () => {
  // As the firmware's test_solve_vs_reference: modes agree (bar boundary cases),
  // exact solves match tightly, the bisecting ones within a step.
  it("matches the firmware's reference vectors", () => {
    let modeDiff = 0;
    let worstExact = 0;
    for (const [a, b, lm, f, mode, desat, , ...duty] of SOLVE_VECTORS) {
      const s = solve(a!, b!, lm!, f!);
      if (s.mode !== MODES[mode!]) {
        modeDiff++;
        continue;
      }
      const dd = Math.max(...s.duty.map((d, i) => Math.abs(d - duty[i]!)));
      if (s.mode === "exact") worstExact = Math.max(worstExact, dd);
      else expect(dd < 0.02 || Math.abs(s.desat - desat!) < 0.01).toBe(true);
    }
    expect(modeDiff).toBeLessThanOrEqual(SOLVE_VECTORS.length / 100);
    expect(worstExact).toBeLessThan(2e-3);
  });

  // This runs float64, as the reference that made them does, so it matches them to
  // their printed digits (duties within 9e-8): any change to the arithmetic that moves
  // a solve shows up here, though the firmware's own test above would let it by.
  it("matches the float64 reference to the vectors' printed digits", () => {
    for (const [a, b, lm, f, mode, desat, lmOut, ...duty] of SOLVE_VECTORS) {
      const s = solve(a!, b!, lm!, f!);
      expect(s.mode).toBe(MODES[mode!]);
      expect(Math.max(...s.duty.map((d, i) => Math.abs(d - duty[i]!)))).toBeLessThan(1e-6);
      expect(Math.abs(s.desat - desat!)).toBeLessThan(1e-8);
      expect(Math.abs(s.lm - lmOut!)).toBeLessThanOrEqual(1e-7 * lmOut!);
    }
  });

  it("is off with no lumens", () => {
    expect(solve(0, 0, 0, 0.5).mode).toBe("off");
    expect(solve(0, 0, -3, 0.5).mode).toBe("off");
    expect(bulbOutput({ a: 0.1, b: 0.1, brightness: 0, fidelity: 1 })).toMatchObject({ light: { brightness: 0 }, mode: "off" });
  });

  it("makes a white it can reach exactly", () => {
    const [a, b] = whiteAB(2700);
    const t = { a, b, brightness: 0.4, fidelity: 1 };
    expect(solve(a, b, 400, 1).mode).toBe("exact");
    expect(bulbOutput(t)).toEqual({ light: t, mode: "exact", desat: 0 });
  });

  it("keeps the lumens of a saturated color asked for too bright, and pales it", () => {
    const red = { a: 0.2, b: 0.1, brightness: 0.3, fidelity: 0 };
    const s = solve(red.a, red.b, 300, 0);
    expect(s.mode).toBe("desat");
    const out = bulbOutput(red);
    expect(out.mode).toBe("desat");
    expect(out.desat).toBe(s.desat);
    expect(out.light.brightness).toBeCloseTo(0.3, 2);
    expect(hueChroma(out.light.a, out.light.b).chroma).toBeLessThan(hueChroma(red.a, red.b).chroma);
  });

  it("gives its brightest white when nothing can reach the lumens", () => {
    const [a, b] = whiteAB(4000);
    const s = solve(a, b, 2000, 1);
    expect(s.mode).toBe("clamp");
    const lm = forward(s.duty)[1] * MODEL.lmPerY;
    expect(lm).toBeCloseTo(s.lm, -1);
    expect(lm).toBeGreaterThan(700);
    expect(lm).toBeLessThan(2000);
  });
});
