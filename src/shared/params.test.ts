import { describe, expect, it } from "vitest";
import { appliesTo, colorOfLemtone, factsOf, filterOf, kindOf, lemtoneOf, paramText, passes, valuesAt, withChanges, type ParamSpec } from "./params.ts";

const speed: ParamSpec = { kind: "number", name: "speed", label: "Speed", lights: {}, default: 7, min: 0, max: 20, step: 0.1 };
const on: ParamSpec = { kind: "toggle", name: "on", label: "On", lights: { kinds: ["switch"] }, default: false };
const tint: ParamSpec = { kind: "color", name: "tint", label: "Tint", lights: { kinds: ["color"] }, default: { a: 0, b: 0, lm: 300, fidelity: 1 } };

describe("which lights a param is for", () => {
  const light = (id: number, kind: "color" | "switch", tags: string[] = []) => ({ id, kind, tags });

  it("is every light passing every part given, any one value in a part doing", () => {
    const filter = { kinds: ["color" as const], tags: ["rail", "desk"] };
    expect(passes(filter, light(1, "color", ["desk"]))).toBe(true);
    expect(passes(filter, light(2, "color", ["wall"]))).toBe(false);
    expect(passes(filter, light(3, "switch", ["rail"]))).toBe(false);
    expect(passes({ ids: [4, 5] }, light(5, "switch"))).toBe(true);
    expect(passes({}, light(6, "switch"))).toBe(true);
  });

  it("is read from a kind, kinds, or { kinds, tags, ids }, leaving out empty parts", () => {
    expect(filterOf("switch")).toEqual({ kinds: ["switch"] });
    expect(filterOf({ kinds: [], tags: "rail", ids: [3, 3] })).toEqual({ tags: ["rail"], ids: [3] });
    expect(filterOf({ kinds: ["bulb"] })).toBe('lights\' kinds are "color" or "switch", not "bulb"');
    expect(filterOf({ ids: [0] })).toBe("lights' ids are light ids");
  });

  it("tells a light's kind by its channels, as sketches do, and by its type where they aren't known", () => {
    expect(kindOf({ type: "br30", channels: ["on"] })).toBe("switch");
    expect(kindOf({ type: "relay", channels: ["a", "b", "brightness", "fidelity"] })).toBe("color");
    expect(kindOf({ type: "relay", channels: [] })).toBe("switch");
    expect(kindOf({ type: "br30" })).toBe("color");
  });

  it("knows old bulbs from color lights the way sketches do", () => {
    const relay = { id: 6, type: "relay", tags: ["hall"] };
    const bulb = { id: 7, type: "br30", tags: null };
    expect(factsOf(relay)).toEqual({ id: 6, kind: "switch", tags: ["hall"] });
    expect(factsOf(bulb)).toEqual({ id: 7, kind: "color", tags: [] });
    expect([appliesTo(on, relay), appliesTo(on, bulb), appliesTo(tint, relay), appliesTo(tint, bulb)]).toEqual([true, false, false, true]);
  });
});

describe("a param's values", () => {
  it("change light by light, grouped by value, the default and anything not its kind left out", () => {
    let groups = withChanges(speed, [], [[3, [1, 2]], [99, [3]], [7, [4]], ["fast" as never, [5]]]);
    expect(groups).toEqual([
      [3, [1, 2]],
      [20, [3]],
    ]);
    groups = withChanges(speed, groups, [[null, [1]], [20, [2]]]);
    expect(groups).toEqual([[20, [2, 3]]]);
    expect(withChanges(on, [], [[true, [6, 7]]], (id) => id === 6)).toEqual([[true, [6]]]);
    expect(valuesAt(speed, groups, [1, 2])).toEqual([7, 20]);
  });

  it("group colors by the same color", () => {
    const red = { a: 0.2, b: 0.1, lm: 500, fidelity: 1 };
    expect(withChanges(tint, [], [[red, [1]], [{ ...red }, [2]], [{ ...red, lm: 400 }, [3]]])).toEqual([
      [red, [1, 2]],
      [{ ...red, lm: 400 }, [3]],
    ]);
  });

  it("show as many decimals as their step has", () => {
    expect([paramText(2.5, 2.5), paramText(7.5, 2.5), paramText(0.25, 0.25), paramText(3, 1), paramText(0.1, 0.01), paramText(1 / 3, 1 / 300)]).toEqual([
      "2.5",
      "7.5",
      "0.25",
      "3",
      "0.10",
      "0.3333",
    ]);
  });

  it("go between the wire's colors and room tone's editor's", () => {
    const c = { a: 0.1, b: -0.05, lm: 400, fidelity: 0.5 };
    expect(lemtoneOf(c)).toEqual({ a: 0.1, b: -0.05, brightness: 0.4, fidelity: 0.5 });
    expect(colorOfLemtone(lemtoneOf(c))).toEqual(c);
  });
});
