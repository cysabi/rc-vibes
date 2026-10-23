import { describe, expect, it } from "vitest";
import type { Frame } from "../../shared/arclamp.ts";
import { SOLVERS } from "../../shared/devices.ts";
import { bulbsOf, channelWeights, sameWeights, weightsOf } from "./weights.ts";

const [wa, wb] = SOLVERS.bulb.wwAb;
const frame = (lights: [number, Record<string, number>][]): Frame => ({ initialTime: 0, lights: new Map(lights) });
const bulbs = bulbsOf(["b01-R", "b01-WW", "b02-WW", "b12-CW", "amb"]);
const only = (i: number, d: number) => [0, 1, 2, 3, 4].map((j) => (j === i ? d : 0));
const [R, G, , WW] = [0, 1, 2, 3, 4];

describe("channelWeights", () => {
  it("weighs a channel driven full, alone, as its map: that's how it was photographed", () => {
    const w = channelWeights(only(WW, 1));
    for (const v of w[WW]!) expect(v).toBeCloseTo(1, 6);
    for (const c of [0, 1, 2, 4]) expect(w[c]).toEqual([0, 0, 0]);
  });

  it("isn't in proportion to duty: each channel's light per unit duty shifts with it", () => {
    // Red gives a little more per unit duty dimmer, green less (bulb 55's calibration).
    expect(channelWeights(only(R, 0.1))[R]![0]).toBeGreaterThan(0.1 * 1.01);
    expect(channelWeights(only(G, 0.1))[G]![1]).toBeLessThan(0.1 * 0.95);
    // And warm white dimmer is warmer: less of its blue than its red.
    const [r, , b] = channelWeights(only(WW, 0.1))[WW]!;
    expect(b).toBeLessThan(r * 0.97);
  });

  it("sags when the other channels draw too", () => {
    const alone = channelWeights(only(R, 0.8))[R]![0];
    const together = channelWeights([0.8, 0.8, 0.8, 0, 0])[R]![0];
    expect(together).toBeLessThan(alone * 0.95);
  });

  it("gives a color a map barely has its strongest color's weight", () => {
    // Red's map has next to no blue, and too little green for its own ratio.
    const [r, g, b] = channelWeights(only(R, 0.4))[R]!;
    expect(g).toBe(r);
    expect(b).toBe(r);
  });
});

describe("weightsOf", () => {
  it("knows the bulbs from the map names", () => {
    expect(bulbs).toEqual([1, 2, 12]);
  });

  it("lights a warm white bulb's warm white map, as a share of the light it was photographed in", () => {
    // Dim enough that the solve makes it from the warm white channel alone (brighter, it adds red and green).
    const w = weightsOf(frame([[1, { a: wa, b: wb, brightness: 0.3, fidelity: 1 }]]), bulbs, new Map());
    expect(w.get("amb")).toEqual([1, 1, 1]);
    for (const v of w.get("b01-WW")!) {
      expect(v).toBeGreaterThan(0.1);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...w.get("b01-R")!)).toBeLessThan(Math.min(...w.get("b01-WW")!) / 10);
    // Missing from the frame: off.
    for (const c of ["R", "G", "B", "CW", "WW"]) expect(w.get(`b02-${c}`)).toEqual([0, 0, 0]);
  });

  it("brighter is more", () => {
    const at = (brightness: number) => weightsOf(frame([[1, { a: wa, b: wb, brightness, fidelity: 1 }]]), bulbs, new Map()).get("b01-WW")!;
    for (let c = 0; c < 3; c++) expect(at(0.6)[c]).toBeGreaterThan(at(0.3)[c]!);
    expect(at(0)).toEqual([0, 0, 0]);
  });

  it("leaves out a light that isn't a color bulb now", () => {
    const w = weightsOf(frame([[12, { on: 1 }]]), bulbs, new Map([[12, "relay"]]));
    for (const c of ["R", "G", "B", "CW", "WW"]) expect(w.get(`b12-${c}`)).toEqual([0, 0, 0]);
  });

  it("tells settled lights from changing ones", () => {
    const a = weightsOf(frame([[1, { a: wa, b: wb, brightness: 0.5, fidelity: 1 }]]), bulbs, new Map());
    const b = weightsOf(frame([[1, { a: wa, b: wb, brightness: 0.5, fidelity: 1 }]]), bulbs, new Map());
    const c = weightsOf(frame([[1, { a: wa, b: wb, brightness: 0.4, fidelity: 1 }]]), bulbs, new Map());
    expect(sameWeights(a, b)).toBe(true);
    expect(sameWeights(a, c)).toBe(false);
  });
});
