import { describe, expect, it } from "vitest";
import { diff, fanOps, lightsField, lightsOf, pathOf, same, unfanOps, valueAt, withOp, withOps, type Op } from "./live.ts";

describe("the live tree's paths", () => {
  const tree = { roomtone: { "24": { brightness: 0.5, a: 0 } }, stack: ["x", "y"], shaders: { x: { muted: false, error: null } } };

  it("reads a value, or undefined", () => {
    expect(valueAt(tree, "roomtone/24/brightness")).toBe(0.5);
    expect(valueAt(tree, "shaders/x/error")).toBeNull();
    expect(valueAt(tree, "roomtone/25/brightness")).toBeUndefined();
    expect(valueAt(tree, "stack/0")).toBeUndefined();
  });

  it("sets a value, copying only what's on its way", () => {
    const next = withOp(tree, ["roomtone/24/brightness", 0.7]);
    expect(next.roomtone["24"]).toEqual({ brightness: 0.7, a: 0 });
    expect(next.shaders).toBe(tree.shaders);
    expect(tree.roomtone["24"].brightness).toBe(0.5);
  });

  it("makes objects on the way to a new path", () => {
    expect(withOp({}, ["pools/p/values/speed/12", 2])).toEqual({ pools: { p: { values: { speed: { "12": 2 } } } } });
  });

  it("takes a path away, and leaves a missing one as it was", () => {
    const next = withOp(tree, ["shaders/x"]);
    expect(next.shaders).toEqual({});
    expect(withOp(tree, ["shaders/z"])).toBe(tree);
  });

  it("sets null as a value, not taking it away", () => {
    expect(withOp(tree, ["shaders/x/muted", null]).shaders.x).toEqual({ muted: null, error: null });
  });

  it("replaces arrays whole", () => {
    expect(withOp(tree, ["stack", ["y", "x"]]).stack).toEqual(["y", "x"]);
  });

  it("won't make a path of a key with a slash in it", () => {
    expect(() => pathOf("shaders", "a/b")).toThrow();
    expect(pathOf("pools", "p", "values", "speed", 12)).toBe("pools/p/values/speed/12");
  });
});

describe("diff", () => {
  it("says nothing for the same tree", () => {
    expect(diff({ a: [1, 2], b: { c: null } }, { a: [1, 2], b: { c: null } })).toEqual([]);
  });

  it("goes into objects, and gives arrays and values whole", () => {
    const a = { roomtone: { "1": { b: 1 } }, stack: ["x", "y"], shaders: { x: { mask: [1] } } };
    const b = { roomtone: { "1": { b: 2 } }, stack: ["y", "x"], shaders: { x: { mask: [1] }, y: { mask: [] } } };
    expect(diff(a, b)).toEqual([
      ["roomtone/1/b", 2],
      ["stack", ["y", "x"]],
      ["shaders/y", { mask: [] }],
    ]);
  });

  it("takes away keys that are gone", () => {
    expect(diff({ shaders: { x: {}, y: {} } }, { shaders: { y: {} } })).toEqual([["shaders/x"]]);
  });

  it("makes the one tree into the other", () => {
    const a = { roomtone: { "1": { b: 1, c: 2 } }, stack: ["x"], pools: { p: { declared: null, values: { s: { "3": 1 } } } } };
    const b = { roomtone: { "1": { b: 1 } }, stack: [], pools: { p: { declared: [{ name: "s" }], values: { s: {} } } }, layout: null };
    const ops: Op[] = diff(a, b);
    expect(same(withOps(a, ops), b)).toBe(true);
  });
});

describe("fans", () => {
  const color = { a: 0.06, b: 0.13, lm: 700, fidelity: 1 };
  const values = (ids: number[], v: unknown = color): Op[] => ids.map((id) => [pathOf("pools", "p", "values", "color", id), v]);

  it("says lights as a bitfield, and reads them back, lowest first", () => {
    for (const ids of [[1], [7, 8], [1, 2, 3, 120], [65535], [9, 300, 4]]) {
      expect(lightsOf(lightsField(ids))).toEqual([...ids].sort((a, b) => a - b));
    }
    // Lights 1 to 120: 16 bytes, 22 characters.
    expect(lightsField(Array.from({ length: 120 }, (_, i) => i + 1))).toHaveLength(22);
  });

  it("won't read what isn't a lights field", () => {
    expect(lightsOf("ab+c")).toBeNull();
    expect(lightsOf("A")).toBeNull();
    expect(lightsOf("AQ")).toBeNull(); // light 0
    expect(lightsOf("A".repeat(11_000))).toBeNull();
  });

  it("sends lights set to one value as one fan, and opens it into the same changes", () => {
    const ops = values([2, 3, 4, 5]);
    const fanned = fanOps(ops);
    expect(fanned).toEqual([["pools/p/values/color/*", color, lightsField([2, 3, 4, 5])]]);
    expect(unfanOps(fanned)).toEqual(ops);
    expect(JSON.stringify(fanned).length).toBeLessThan(JSON.stringify(ops).length / 2);
  });

  it("fans each value in a run on its own, and leaves a light alone with its value as it was", () => {
    const ops = [...values([1, 3], 1), ...values([2, 4], 2), ...values([5], 3)];
    expect(fanOps(ops)).toEqual([
      ["pools/p/values/color/*", 1, lightsField([1, 3])],
      ["pools/p/values/color/*", 2, lightsField([2, 4])],
      ["pools/p/values/color/5", 3],
    ]);
  });

  it("fans only runs in a row, so whatever's between them comes between them still", () => {
    const ops: Op[] = [...values([1, 2]), ["stack", ["x"]], ...values([3, 4]), ["pools/p/values/color/5"], ...values([6, 7])];
    const fanned = fanOps(ops);
    expect(fanned.map((o) => o[0])).toEqual(["pools/p/values/color/*", "stack", "pools/p/values/color/*", "pools/p/values/color/5", "pools/p/values/color/*"]);
    expect(unfanOps(fanned)).toEqual(ops);
  });

  it("ends a run at a light it's had, so the later value still wins", () => {
    const ops = [...values([1, 2], 1), ...values([1], 2), ...values([3], 2)];
    expect(withOps({}, unfanOps(fanOps(ops)) as Op[])).toEqual(withOps({}, ops));
    expect(fanOps(ops)[0]).toEqual(["pools/p/values/color/*", 1, lightsField([1, 2])]);
  });

  it("fans room tone's channels and the lights' layout, and nothing without a light in it", () => {
    expect(fanOps([["roomtone/1/brightness", 0.5], ["roomtone/2/brightness", 0.5]])).toEqual([["roomtone/*/brightness", 0.5, lightsField([1, 2])]]);
    expect(fanOps([["layout/lights/1/tags", ["couch"]], ["layout/lights/9/tags", ["couch"]]])).toEqual([["layout/lights/*/tags", ["couch"], lightsField([1, 9])]]);
    const plain: Op[] = [["shaders/1/muted", true], ["shaders/2/muted", true], ["layout/rails/7", null], ["layout/rails/8", null]];
    expect(fanOps(plain)).toEqual(plain);
    // Not lights' ids: as they are.
    const odd: Op[] = [["pools/p/values/color/07", 1], ["pools/p/values/color/x", 1], ["pools/p/values/color/65536", 1]];
    expect(fanOps(odd)).toEqual(odd);
  });

  it("refuses a fan that isn't of lights' paths, or opens into more than it may", () => {
    expect(unfanOps([["shaders/*/muted", true, lightsField([1, 2])]])).toBe("bad");
    expect(unfanOps([["pools/*/values/color/*", 1, lightsField([1, 2])]])).toBe("bad");
    expect(unfanOps([["pools/p/values/color/*", 1, "not a field"]])).toBe("bad");
    expect(unfanOps([["pools/p/values/color/*", 1, ""]])).toBe("bad");
    const all = lightsField(Array.from({ length: 65535 }, (_, i) => i + 1));
    expect(unfanOps([["pools/p/values/color/*", 1, all]], 20_000)).toBe("too_big");
    expect(unfanOps([...values([1, 2, 3]), ["pools/p/values/color/*", 1, lightsField([4, 5])]], 4)).toBe("too_big");
  });
});
