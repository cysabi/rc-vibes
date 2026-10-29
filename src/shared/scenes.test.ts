import { describe, expect, it } from "vitest";
import { BASE_COLOR } from "./base-color.ts";
import type { Pool } from "./live.ts";
import type { ParamSpec } from "./params.ts";
import { applyingOf, knobsOf, onScene, type Scene, type Scenes } from "./scenes.ts";
import type { Shader } from "./vibes.ts";

const speed: ParamSpec = { kind: "number", name: "speed", label: "Speed", lights: {}, default: 1, min: 0, max: 10, step: 0.1 };
const hue: ParamSpec = { kind: "number", name: "hue", label: "Hue", lights: {}, default: 0, min: 0, max: 1, step: 0.01 };

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
const pool = (values: Pool["values"], declared: ParamSpec[] = [speed, hue]): Pool => ({ declared, values }) as Pool;
const scene = (shaders: Scene["shaders"]): Scene => ({ name: "s", shaders, by: { id: "u", name: "U" }, at: 0 });

describe("applying a scene", () => {
  it("puts its sketch on, every other shader off but Base Color (and any that failed), and its knobs as it keeps them", () => {
    const room = [
      shader("a", { muted: true, pool: "pa" }),
      shader("b"),
      shader("c", { muted: true }),
      shader("base", { pool: BASE_COLOR.pool }),
      shader("broken", { stage: "failed" }),
    ];
    const pools = { pa: pool({ speed: { "1": 2, "2": 3 } }) };
    const a = applyingOf(scene({ a: { speed: { "1": 5 }, hue: { "3": 0.5 } } }), room, pools);
    expect(a.on).toEqual(["a"]);
    expect(a.off).toEqual(["b"]);
    expect(a.knobs).toEqual([
      // Light 2 back to the default, light 1 to 5.
      { key: "a", pool: "pa", param: "speed", set: [["2", null], ["1", 5]] },
      { key: "a", pool: "pa", param: "hue", set: [["3", 0.5]] },
    ]);
  });

  it("leaves knobs its sketch no longer declares, and passes over a sketch gone from the room", () => {
    const room = [shader("a", { pool: "pa" })];
    const pools = { pa: pool({}, [speed]) };
    expect(applyingOf(scene({ a: { hue: { "1": 0.5 } }, gone: {} }), room, pools)).toEqual({ on: [], off: [], knobs: [] });
  });

  it("says which scene the room looks like: none, once anything differs", () => {
    const room = [shader("a", { pool: "pa" }), shader("b", { muted: true }), shader("base", { pool: BASE_COLOR.pool })];
    const pools = { pa: pool({ speed: { "1": 5 } }) };
    const scenes: Scenes = {
      list: { one: scene({ b: {} }), two: scene({ a: { speed: { "1": 5 } } }), empty: scene({}) },
      order: ["empty", "one", "two"],
    };
    expect(onScene(scenes, room, pools)).toBe("two");
    expect(onScene(scenes, room, { pa: pool({ speed: { "1": 6 } }) })).toBeNull();
    expect(onScene(scenes, [...room.slice(0, 1), shader("b")], pools)).toBeNull();
  });

  it("takes a sketch's knobs from the room as they are, to keep apart from them", () => {
    const pools = { pa: pool({ speed: { "1": 5 } }) };
    const knobs = knobsOf({ pool: "pa" }, pools);
    expect(knobs).toEqual({ speed: { "1": 5 } });
    knobs.speed!["1"] = 9;
    expect(pools.pa.values.speed!["1"]).toBe(5);
    expect(knobsOf({ pool: null }, pools)).toEqual({});
  });
});
