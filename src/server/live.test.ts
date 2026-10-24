import { describe, expect, it } from "vitest";
import type { Shader, SceneFeed } from "../shared/vibes.ts";
import { createLiveState, layoutOf, sceneParts } from "./live.ts";

const shader = (key: string, more: Partial<Shader> = {}): Shader => ({
  key,
  stage: "live",
  name: key,
  state: "running",
  error: null,
  muted: false,
  mask: [],
  sketch: null,
  instance: null,
  by: "x",
  footprint: [],
  scriptHash: null,
  pool: null,
  ...more,
});

/** Every message a listener's told, parsed. */
function listen(live: ReturnType<typeof createLiveState>) {
  const heard: { type: string; rev: number; ops: unknown[] }[] = [];
  live.subscribe((json) => heard.push(JSON.parse(json)));
  return heard;
}

describe("the live state", () => {
  it("makes changes, each that changes something counted, and tells everyone as one delta", () => {
    const live = createLiveState();
    const heard = listen(live);
    live.publish([
      ["roomtone/1/brightness", 0.5],
      ["stack", ["a"]],
    ]);
    expect(live.rev()).toBe(1);
    expect(live.tree().roomtone).toEqual({ "1": { brightness: 0.5 } });
    expect(heard).toEqual([
      {
        type: "delta",
        rev: 1,
        ops: [
          ["roomtone/1/brightness", 0.5],
          ["stack", ["a"]],
        ],
      },
    ]);
    // Nothing new: nothing counted, nothing said. Only what changes goes out.
    live.publish([["roomtone/1/brightness", 0.5], ["pools/p"]]);
    expect(live.rev()).toBe(1);
    live.publish([
      ["roomtone/1/brightness", 0.5],
      ["stack", ["b"]],
    ]);
    expect(heard.at(-1)).toEqual({ type: "delta", rev: 2, ops: [["stack", ["b"]]] });
  });

  it("takes parts as they are now, and sends what changed", () => {
    const live = createLiveState();
    live.replace([["pools", { p: { declared: null, values: {} } }]]);
    const heard = listen(live);
    live.replace([["pools", { p: { declared: null, values: { speed: { "1": 3 } } } }]]);
    expect(heard).toEqual([{ type: "delta", rev: 2, ops: [["pools/p/values/speed", { "1": 3 }]] }]);
    live.replace([["pools", {}]]);
    expect(heard.at(-1)!.ops).toEqual([["pools/p"]]);
  });

  it("has the scene as room tone, shaders by key, and their order", () => {
    const feed: SceneFeed = { shaders: [shader("b"), shader("a", { muted: true })], roomtone: { lights: { "1": { on: 1 } } } };
    expect(sceneParts(feed)).toEqual([
      ["roomtone", { "1": { on: 1 } }],
      ["shaders", { b: shader("b"), a: shader("a", { muted: true }) }],
      ["stack", ["b", "a"]],
    ]);
    expect(sceneParts({ shaders: [], roomtone: null })[0]).toEqual(["roomtone", {}]);
    const live = createLiveState();
    live.scene(feed);
    expect(live.tree().stack).toEqual(["b", "a"]);
    const heard = listen(live);
    live.scene({ ...feed, shaders: [shader("b"), shader("a", { muted: false })] });
    expect(heard).toEqual([{ type: "delta", rev: 2, ops: [["shaders/a/muted", false]] }]);
  });

  it("has the layout keyed, its order kept beside", () => {
    const rail = { id: "r1", floor: 4, from: { mm_x: 0, mm_y: 0 }, to: { mm_x: 1000, mm_y: 0 } };
    const l = (id: number) => ({ id, type: "br30", tags: [], coords: null, rail: null, channels: ["on"] });
    const lights = { id_width: 1 as const, lights: [l(5), l(2)], rails: [rail], changed: 3 };
    expect(layoutOf(lights)).toEqual({ id_width: 1, order: [5, 2], lights: { "5": l(5), "2": l(2) }, railOrder: ["r1"], rails: { r1: rail }, changed: 3 });
    const live = createLiveState();
    live.layout(lights);
    expect(live.tree().layout!.order).toEqual([5, 2]);
  });

  it("gives a page that had a change of this run what it's missed since; the whole tree to one of another run, ahead, or too far behind", () => {
    const live = createLiveState();
    const state = JSON.parse(live.state()) as { type: string; rev: number; epoch: string; tree: unknown };
    expect(state).toMatchObject({ type: "state", rev: 0, tree: live.tree() });
    const { epoch } = state;
    live.publish([["stack", ["a"]]]);
    live.publish([["stack", ["b"]]]);
    expect(live.since(2, epoch)).toEqual([]);
    expect(live.since(0, epoch)!.map((m) => JSON.parse(m))).toEqual([
      { type: "delta", rev: 1, ops: [["stack", ["a"]]] },
      { type: "delta", rev: 2, ops: [["stack", ["b"]]] },
    ]);
    expect(live.since(1, epoch)).toHaveLength(1);
    expect(live.since(1, "another run")).toBeNull();
    expect(live.since(1, undefined)).toBeNull();
    expect(live.since(3, epoch)).toBeNull();
    expect(live.since(-1, epoch)).toBeNull();
    // Each run its own.
    expect(JSON.parse(createLiveState().state()).epoch).not.toBe(epoch);
    // Only so many kept.
    for (let i = 0; i < 4001; i++) live.publish([["stack", [String(i)]]]);
    expect(live.since(0, epoch)).toBeNull();
    expect(live.since(live.rev() - 10, epoch)).toHaveLength(10);
  });
});
