import { describe, expect, it } from "vitest";
import { cleanValues, packetOf, patchValues, valueFor, type ParamSpec } from "./params.ts";

const speed: ParamSpec = { name: "speed", default: 7, min: 0, max: 20, step: 0.1, label: "Speed", perLight: true };

describe("a param's values", () => {
  it("read as a light's own, else everywhere's, else the default, within the range", () => {
    expect(valueFor(speed, undefined, 1)).toBe(7);
    expect(valueFor(speed, { all: 3 }, 1)).toBe(3);
    expect(valueFor(speed, { all: 3, lights: { "1": 10 } }, 1)).toBe(10);
    expect(valueFor(speed, { all: 3, lights: { "1": 10 } }, 2)).toBe(3);
    expect(valueFor(speed, { all: 99 }, 2)).toBe(20);
  });

  it("are cleaned to what's set, within the range", () => {
    expect(cleanValues(speed, { all: -4, lights: { "1": 30, "2": Number.NaN } })).toEqual({ all: 0, lights: { "1": 20 } });
    expect(cleanValues(speed, { lights: {} })).toEqual({});
  });

  it("take a patch: a part given replaces it, null unsets it, and lights merge", () => {
    const prev = { all: 3, lights: { "1": 10, "2": 11 } };
    expect(patchValues(speed, prev, { all: 5 })).toEqual({ all: 5, lights: { "1": 10, "2": 11 } });
    expect(patchValues(speed, prev, { lights: { "2": null, "3": 12 } })).toEqual({ all: 3, lights: { "1": 10, "3": 12 } });
    expect(patchValues(speed, prev, { all: null, lights: null })).toEqual({});
    expect(patchValues(speed, undefined, { lights: { "4": 1 } })).toEqual({ lights: { "4": 1 } });
  });

  it("go out as one packet each, as the library reads them", () => {
    expect(JSON.parse(packetOf(3, "speed", { all: 7, lights: { "1": 9 } }))).toEqual({ vibes: "params", v: 1, seq: 3, name: "speed", all: 7, lights: { "1": 9 } });
    expect(JSON.parse(packetOf(4, "speed", {}))).toEqual({ vibes: "params", v: 1, seq: 4, name: "speed" });
  });
});
