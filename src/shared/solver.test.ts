import { describe, expect, it } from "vitest";
import { MODEL as BULB_MODEL } from "./bulb.model.ts";
import * as bulbVectors from "./bulb.vectors.ts";
import { hueChroma, whiteAB } from "./lemtone.ts";
import { MODEL as PANEL_MODEL } from "./panel.model.ts";
import * as panelVectors from "./panel.vectors.ts";
import { solverOf, type SolveMode } from "./solver.ts";

const MODES: SolveMode[] = ["off", "exact", "desat", "clamp"];

const DEVICES = [
  { name: "bulb", solver: solverOf(BULB_MODEL), vectors: bulbVectors },
  { name: "panel", solver: solverOf(PANEL_MODEL), vectors: panelVectors },
];

describe.each(DEVICES)("the $name's solve", ({ solver, vectors }) => {
  it("gives the light the firmware's reference does, for any duties", () => {
    for (const [d0, d1, d2, d3, d4, ...xyz] of vectors.FORWARD_VECTORS) {
      const out = solver.forward([d0!, d1!, d2!, d3!, d4!]);
      for (let c = 0; c < 3; c++) expect(Math.abs(out[c]! - xyz[c]!)).toBeLessThanOrEqual(1e-7 * Math.max(1, xyz[c]!));
    }
  });

  // As the firmware's test_solve_vs_reference: modes agree (bar boundary cases),
  // exact solves match tightly, the bisecting ones within a step.
  it("matches the firmware's reference vectors", () => {
    let modeDiff = 0;
    let worstExact = 0;
    for (const [a, b, lm, f, mode, desat, , ...duty] of vectors.SOLVE_VECTORS) {
      const s = solver.solve(a!, b!, lm!, f!);
      if (s.mode !== MODES[mode!]) {
        modeDiff++;
        continue;
      }
      const dd = Math.max(...s.duty.map((d, i) => Math.abs(d - duty[i]!)));
      if (s.mode === "exact") worstExact = Math.max(worstExact, dd);
      else expect(dd < 0.02 || Math.abs(s.desat - desat!) < 0.01).toBe(true);
    }
    expect(modeDiff).toBeLessThanOrEqual(vectors.SOLVE_VECTORS.length / 100);
    expect(worstExact).toBeLessThan(2e-3);
  });

  // This runs float64, as the reference that made them does, so it matches them to
  // their printed digits: any change to the arithmetic that moves a solve shows up
  // here, though the firmware's own test above would let it by.
  it("matches the float64 reference to the vectors' printed digits", () => {
    for (const [a, b, lm, f, mode, desat, lmOut, ...duty] of vectors.SOLVE_VECTORS) {
      const s = solver.solve(a!, b!, lm!, f!);
      expect(s.mode).toBe(MODES[mode!]);
      expect(Math.max(...s.duty.map((d, i) => Math.abs(d - duty[i]!)))).toBeLessThan(1e-6);
      expect(Math.abs(s.desat - desat!)).toBeLessThan(1e-8);
      expect(Math.abs(s.lm - lmOut!)).toBeLessThanOrEqual(1e-7 * lmOut!);
    }
  });

  it("is off with no lumens", () => {
    expect(solver.solve(0, 0, 0, 0.5).mode).toBe("off");
    expect(solver.solve(0, 0, -3, 0.5).mode).toBe("off");
    expect(solver.output({ a: 0.1, b: 0.1, brightness: 0, fidelity: 1 })).toMatchObject({ light: { brightness: 0 }, mode: "off" });
  });

  it("makes a white it can reach exactly", () => {
    const [a, b] = whiteAB(2700);
    const t = { a, b, brightness: 0.4, fidelity: 1 };
    expect(solver.solve(a, b, 400, 1).mode).toBe("exact");
    expect(solver.makesExactly(a, b, 400, 1)).toBe(true);
    expect(solver.output(t)).toEqual({ light: t, mode: "exact", desat: 0 });
  });

  it("keeps the lumens of a saturated color asked for too bright, and pales it", () => {
    const lm = 0.3 * solver.model.ratedLm;
    const red = { a: 0.2, b: 0.1, brightness: lm / 1000, fidelity: 0 };
    const s = solver.solve(red.a, red.b, lm, 0);
    expect(s.mode).toBe("desat");
    expect(solver.makesExactly(red.a, red.b, lm, 0)).toBe(false);
    const out = solver.output(red);
    expect(out.mode).toBe("desat");
    expect(out.desat).toBe(s.desat);
    expect(out.light.brightness).toBeCloseTo(red.brightness, 1);
    expect(hueChroma(out.light.a, out.light.b).chroma).toBeLessThan(hueChroma(red.a, red.b).chroma);
  });

  it("gives its brightest white when nothing can reach the lumens", () => {
    const [a, b] = whiteAB(4000);
    const asked = 2 * solver.model.ratedLm;
    const s = solver.solve(a, b, asked, 1);
    expect(s.mode).toBe("clamp");
    const lm = solver.forward(s.duty)[1] * solver.model.lmPerY;
    expect(lm).toBeCloseTo(s.lm, -1);
    expect(lm).toBeGreaterThan(0.7 * solver.model.ratedLm);
    expect(lm).toBeLessThan(asked);
  });
});

describe("the panel's whites", () => {
  const panel = solverOf(PANEL_MODEL);
  const L = 2 ** PANEL_MODEL.whiteGridLog2;

  it("are set in whole steps of DIM and CCT, DIM never in the driver's unusable bottom", () => {
    for (const [a, b, lm, f] of panelVectors.SOLVE_VECTORS) {
      const s = panel.solve(a!, b!, lm!, f!);
      if (s.mode !== "exact" && s.mode !== "desat") continue;
      const dim = (s.duty[3]! + s.duty[4]!) * L;
      expect(Math.abs(dim - Math.round(dim))).toBeLessThan(1e-6);
      expect(Math.round(dim) === 0 || Math.round(dim) >= PANEL_MODEL.whiteDimMin).toBe(true);
      expect(s.duty[3]! + s.duty[4]!).toBeLessThanOrEqual(PANEL_MODEL.whiteSumMax + 1e-9);
    }
  });
});
