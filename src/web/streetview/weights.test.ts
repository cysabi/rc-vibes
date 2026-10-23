import { describe, expect, it } from "vitest";
import type { Frame } from "../../shared/arclamp.ts";
import { SOLVERS } from "../../shared/devices.ts";
import { bulbsOf, sameWeights, weightsOf } from "./weights.ts";

const [wa, wb] = SOLVERS.bulb.wwAb;
const frame = (lights: [number, Record<string, number>][]): Frame => ({ initialTime: 0, lights: new Map(lights) });
const bulbs = bulbsOf(["b01-R", "b01-WW", "b02-WW", "b12-CW", "amb"]);

describe("weightsOf", () => {
  it("knows the bulbs from the map names", () => {
    expect(bulbs).toEqual([1, 2, 12]);
  });

  it("lights a warm white bulb's warm white map, as a share of the duty it was photographed at", () => {
    // Dim enough that the solve makes it from the warm white channel alone (brighter, it adds red and green).
    const w = weightsOf(frame([[1, { a: wa, b: wb, brightness: 0.3, fidelity: 1 }]]), bulbs, new Map());
    expect(w.get("amb")).toBe(1);
    expect(w.get("b01-WW")).toBeGreaterThan(0.1);
    expect(w.get("b01-WW")).toBeLessThanOrEqual(1);
    expect(w.get("b01-R")).toBeLessThan(w.get("b01-WW")! / 10);
    // Missing from the frame: off.
    for (const c of ["R", "G", "B", "CW", "WW"]) expect(w.get(`b02-${c}`)).toBe(0);
  });

  it("brighter is more", () => {
    const at = (brightness: number) => weightsOf(frame([[1, { a: wa, b: wb, brightness, fidelity: 1 }]]), bulbs, new Map()).get("b01-WW")!;
    expect(at(0.6)).toBeGreaterThan(at(0.3));
    expect(at(0)).toBe(0);
  });

  it("leaves out a light that isn't a color bulb now", () => {
    const w = weightsOf(frame([[12, { on: 1 }]]), bulbs, new Map([[12, "relay"]]));
    for (const c of ["R", "G", "B", "CW", "WW"]) expect(w.get(`b12-${c}`)).toBe(0);
  });

  it("tells settled lights from changing ones", () => {
    const a = weightsOf(frame([[1, { a: wa, b: wb, brightness: 0.5, fidelity: 1 }]]), bulbs, new Map());
    const b = weightsOf(frame([[1, { a: wa, b: wb, brightness: 0.5, fidelity: 1 }]]), bulbs, new Map());
    const c = weightsOf(frame([[1, { a: wa, b: wb, brightness: 0.4, fidelity: 1 }]]), bulbs, new Map());
    expect(sameWeights(a, b)).toBe(true);
    expect(sameWeights(a, c)).toBe(false);
  });
});
