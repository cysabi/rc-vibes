import { describe, expect, it } from "vitest";
import { baseType, channelsFor, footprintOf, isBinary, isOn, lemtoneOf, orientationsOf, ratedBrightnessOf, requestedOf, seenOf, switchChannels } from "./fixtures.ts";
import { hueChroma, whiteAB } from "./lemtone.ts";

describe("fixture orientations", () => {
  it("treats a turned panel as the same hardware", () => {
    expect(baseType("4x1-horizontal")).toBe("4x1");
    expect(baseType("br30")).toBe("br30");
    const warm = { a: 0.07, b: 0.15, brightness: 0.5, fidelity: 1 };
    expect(channelsFor(warm, "4x1-horizontal")).toEqual(channelsFor(warm, "4x1"));
  });

  it("only lets panels turn", () => {
    expect(orientationsOf("4x1")).toEqual(["4x1", "4x1-horizontal"]);
    expect(orientationsOf("4x1-horizontal")).toEqual(["4x1", "4x1-horizontal"]);
    expect(orientationsOf("br30")).toEqual([]);
  });

  it("rates panels at 4000 lm, standing or on their side, and color bulbs at 1000 lm", () => {
    expect(ratedBrightnessOf("4x1")).toBe(4);
    expect(ratedBrightnessOf("4x1-horizontal")).toBe(4);
    expect(ratedBrightnessOf("br30")).toBe(1);
  });

  it("gives panels their real 1 ft × 4 ft footprint, standing or on their side", () => {
    expect(footprintOf("4x1")).toEqual({ width: 304.8, height: 1219.2 });
    expect(footprintOf("4x1-horizontal")).toEqual({ width: 1219.2, height: 304.8 });
    expect(footprintOf("br30")).toBeNull();
  });
});

describe("fixture channels", () => {
  const t = { a: 0.1, b: -0.2, brightness: 0.3, fidelity: 0.5 };

  it("asks color lights for all four Lemtone channels, and switches old bulbs on their own channel", () => {
    expect(channelsFor(t, "br30")).toEqual({ a: 0.1, b: -0.2, brightness: 0.3, fidelity: 0.5 });
    expect(channelsFor(t, "relay")).toBeNull();
    expect(switchChannels(true)).toEqual({ on: 1 });
    expect(switchChannels(false)).toEqual({ on: 0 });
    expect(isBinary("relay")).toBe(true);
    expect(isBinary("4x1")).toBe(false);
  });

  it("reads color lights back from their channels", () => {
    expect(lemtoneOf({ a: 0.1, b: -0.2, brightness: 0.3, fidelity: 0.5 }, "br30")).toEqual(t);
    // Missing channels: white, fidelity 1.
    expect(lemtoneOf({ brightness: 0.3 }, "br30")).toEqual({ a: 0, b: 0, brightness: 0.3, fidelity: 1 });
    // Dark is null; what it asks for is still there.
    expect(lemtoneOf({ ...t, brightness: 0 }, "br30")).toBeNull();
    expect(requestedOf({ ...t, brightness: 0 }, "br30")).toEqual({ ...t, brightness: 0 });
    expect(lemtoneOf(undefined, "br30")).toBeNull();
  });

  it("shows old bulbs as a 2700 K incandescent, on at 0.5 or more", () => {
    expect(isOn({ on: 1 })).toBe(true);
    expect(isOn({ on: 0.5 })).toBe(true);
    expect(isOn({ on: 0.49 })).toBe(false);
    expect(isOn({ brightness: 1 })).toBe(false); // brightness doesn't switch them
    expect(lemtoneOf({ on: 0 }, "relay")).toBeNull();
    const on = lemtoneOf({ on: 1 }, "relay")!;
    const [a, b] = whiteAB(2700);
    expect(on.a).toBeCloseTo(a, 9);
    expect(on.b).toBeCloseTo(b, 9);
    expect(requestedOf({ on: 1 }, "relay")).toBeNull();
  });

  it("shows color bulbs and panels as their solves make them, each on its own calibration, and old bulbs as asked", () => {
    const red = { a: 0.2, b: 0.1, brightness: 0.4, fidelity: 0 };
    const chroma = (l: { a: number; b: number }) => hueChroma(l.a, l.b).chroma;
    const bulb = seenOf(red, "br30")!;
    expect(chroma(bulb)).toBeLessThan(chroma(red));
    expect(bulb.brightness).toBeCloseTo(0.4, 2);
    // A panel pales it too, though less: it's brighter.
    const panel = seenOf(red, "4x1-horizontal")!;
    expect(chroma(panel)).toBeLessThan(chroma(red));
    expect(chroma(panel)).toBeGreaterThan(chroma(bulb));
    // At 2000 lm a bulb gives what it can (700 lm or so); a panel keeps the lumens.
    expect(seenOf({ ...red, brightness: 2 }, "br30")!.brightness).toBeLessThan(1);
    expect(seenOf({ ...red, brightness: 2 }, "4x1")!.brightness).toBeCloseTo(2, 2);
    // A color it can make is made as asked.
    expect(seenOf(t, "br30")).toEqual(lemtoneOf(t, "br30"));
    const [wa, wb] = whiteAB(3000);
    const white = { a: wa, b: wb, brightness: 2.5, fidelity: 1 };
    expect(seenOf(white, "4x1")).toEqual(lemtoneOf(white, "4x1"));
    // Old bulbs only switch.
    expect(seenOf({ on: 1 }, "relay")).toEqual(lemtoneOf({ on: 1 }, "relay"));
    expect(seenOf({ ...red, brightness: 0 }, "br30")).toBeNull();
  });
});
