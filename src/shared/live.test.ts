import { describe, expect, it } from "vitest";
import { diff, pathOf, same, valueAt, withOp, withOps, type Op } from "./live.ts";

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
