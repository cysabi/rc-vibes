import { beforeEach, describe, expect, it } from "vitest";
import type { Op, Pool } from "../shared/live.ts";
import type { ParamSpec } from "../shared/params.ts";
import type { Me, Shader } from "../shared/vibes.ts";
import { openDb, type Db } from "./db.ts";
import { createScenes } from "./scenes.ts";
import { Refused } from "./shaders.ts";

const ada: Me = { id: "rc:1", name: "Ada", dev: false };
const speed: ParamSpec = { kind: "number", name: "speed", label: "Speed", lights: {}, default: 1, min: 0, max: 10, step: 0.1 };
const S1 = "00000000-0000-4000-8000-000000000001";
const S2 = "00000000-0000-4000-8000-000000000002";

describe("the scenes, as vibes keeps them", () => {
  let db: Db;
  let published: Op[];
  const room = { shaders: { a: { key: "a", pool: "pa" } as Shader }, pools: { pa: { declared: [speed], values: {} } as unknown as Pool } };
  const make = () => createScenes({ db, publish: (ops) => published.push(...ops), room: () => room, now: () => 1000 });
  const refused = (f: () => void) => {
    try {
      f();
      return null;
    } catch (err) {
      return err instanceof Refused ? err.code : "thrown";
    }
  };

  beforeEach(() => {
    db = openDb(":memory:");
    published = [];
  });

  it("makes, names, gives a sketch and its knobs to, and takes away scenes, each told to every page, and kept", () => {
    const scenes = make();
    scenes.act({ op: "create", id: S1, name: "Intro" }, ada);
    scenes.act({ op: "create", id: S2, name: "Drop" }, ada);
    scenes.act({ op: "name", id: S1, name: "Opening" }, ada);
    scenes.act({ op: "sketch", id: S1, key: "a", knobs: { speed: { "1": 5 } } }, ada);
    scenes.act({ op: "knob", id: S1, key: "a", param: "speed", light: "2", value: 7 }, ada);
    scenes.act({ op: "knob", id: S1, key: "a", param: "speed", light: "1", value: null }, ada);
    const one = { name: "Opening", shaders: { a: { speed: { "2": 7 } } }, by: { id: "rc:1", name: "Ada" }, at: 1000 };
    expect(scenes.tree()).toEqual({ list: { [S1]: one, [S2]: expect.objectContaining({ name: "Drop", shaders: {} }) }, order: [S1, S2] });
    expect(published).toContainEqual([`scenes/list/${S1}`, one]);
    expect(published).toContainEqual(["scenes/order", [S1, S2]]);

    scenes.act({ op: "order", ids: [S2, S1] }, ada);
    scenes.act({ op: "sketch", id: S2, key: "a", knobs: {} }, ada);
    scenes.act({ op: "remove", id: S1 }, ada);
    expect(published).toContainEqual([`scenes/list/${S1}`]);
    // vibes starts again: they're as they were.
    expect(make().tree()).toEqual({ list: { [S2]: expect.objectContaining({ name: "Drop", shaders: { a: {} } }) }, order: [S2] });
  });

  it("keeps only knobs its sketch declares, with values it'll take", () => {
    const scenes = make();
    scenes.act({ op: "create", id: S1, name: "Intro" }, ada);
    expect(refused(() => scenes.act({ op: "sketch", id: S1, key: "a", knobs: { hue: { "1": 1 } } }, ada))).toBe("no_such_knob");
    expect(refused(() => scenes.act({ op: "sketch", id: S1, key: "a", knobs: { speed: { "1": true } } }, ada))).toBe("bad_knob");
    expect(refused(() => scenes.act({ op: "knob", id: S1, key: "a", param: "speed", light: "1", value: 2 }, ada))).toBe("not_in_scene");
    // Out of range: kept as its param would keep it (within its range).
    scenes.act({ op: "sketch", id: S1, key: "a", knobs: { speed: { "1": 99 } } }, ada);
    expect(scenes.get(S1)!.shaders.a!.speed!["1"]).toBe(10);
  });

  it("refuses one that isn't there, and an order that doesn't name every scene once", () => {
    const scenes = make();
    scenes.act({ op: "create", id: S1, name: "Intro" }, ada);
    expect(refused(() => scenes.act({ op: "name", id: S2, name: "x" }, ada))).toBe("no_such_scene");
    expect(refused(() => scenes.act({ op: "remove", id: S2 }, ada))).toBe("no_such_scene");
    expect(refused(() => scenes.act({ op: "order", ids: [] }, ada))).toBe("scenes_changed");
    expect(refused(() => scenes.act({ op: "order", ids: [S1, S1] }, ada))).toBe("scenes_changed");
  });

  it("notes changes in the history, a run to one scene as one entry", async () => {
    const scenes = make();
    scenes.act({ op: "create", id: S1, name: "Intro" }, ada);
    scenes.act({ op: "sketch", id: S1, key: "a", knobs: {} }, ada);
    for (const v of [1, 2, 3]) scenes.act({ op: "knob", id: S1, key: "a", param: "speed", light: "1", value: v }, ada);
    expect((await db.activity(10)).map((a) => [a.action, a.detail])).toEqual([
      ["scenes.change", { do: "knob", scene: "Intro" }],
      ["scenes.change", { do: "sketch", scene: "Intro" }],
      ["scenes.change", { do: "create", scene: "Intro" }],
    ]);
  });
});
