import { describe, expect, it } from "vitest";
import type { LightInfo, LightsResponse, Rail } from "../shared/arclamp.ts";
import type { RailShape } from "../shared/rails.ts";
import type { Spot } from "../shared/vibes.ts";
import { applyEdits, lightsFile, type Edits } from "./lights.ts";

const channels = ["brightness"];
const light = (id: number, more: Partial<LightInfo> = {}): LightInfo => ({
  id,
  type: "relay",
  tags: [],
  coords: null,
  rail: null,
  channels,
  ...more,
});
const shape = (fx: number, fy: number, tx: number, ty: number, floor = 5): RailShape => ({
  floor,
  from: { mm_x: fx, mm_y: fy },
  to: { mm_x: tx, mm_y: ty },
});
const edits = (
  e: Partial<{ rails: [string, RailShape | null][]; placements: [number, Spot | null][]; types: [number, string][]; tags: [number, string[]][] }> = {},
): Edits => ({
  rails: new Map(e.rails ?? []),
  placements: new Map(e.placements ?? []),
  types: new Map(e.types ?? []),
  tags: new Map(e.tags ?? []),
});

// arclamp's own map: one rail with light 1 on it (coords as arclamp derived
// them, not quite whole), light 2 free, light 3 unplaced, panel 4 free.
const theirRail: Rail = { id: "a", floor: 5, from: { mm_x: 0, mm_y: 1000 }, to: { mm_x: 3000, mm_y: 1000 } };
const arclamp: LightsResponse = {
  id_width: 1,
  rails: [theirRail],
  lights: [
    light(1, { rail: { id: "a", mm_along: 1000.4 }, coords: { mm_x: 1000.4, mm_y: 1000, floor: 5 } }),
    light(2, { coords: { mm_x: 5000, mm_y: 5000, floor: 4 } }),
    light(3),
    light(4, { type: "4x1", coords: { mm_x: 7000, mm_y: 2000, floor: 5 } }),
  ],
};
const at = (lights: LightInfo[], id: number) => lights.find((l) => l.id === id)!;

describe("applyEdits", () => {
  it("passes arclamp's map through untouched", () => {
    const out = applyEdits(arclamp, edits());
    expect(out.changed).toBe(0);
    expect(out.rails).toEqual(arclamp.rails);
    expect(out.lights).toEqual(arclamp.lights);
  });

  it("puts a light on a new rail, with coords from the rail", () => {
    const out = applyEdits(arclamp, edits({ rails: [["b", shape(0, 0, 0, 4000)]], placements: [[3, { rail: { id: "b", mm_along: 2500 } }]] }));
    expect(out.rails.map((r) => r.id)).toEqual(["a", "b"]);
    expect(at(out.lights, 3)).toMatchObject({ rail: { id: "b", mm_along: 2500 }, coords: { mm_x: 0, mm_y: 2500, floor: 5 } });
    expect(out.changed).toBe(2);
  });

  it("moves lights with their rail", () => {
    const out = applyEdits(arclamp, edits({ rails: [["a", shape(0, 1200, 3000, 1200)]] }));
    expect(at(out.lights, 1)).toMatchObject({ rail: { id: "a", mm_along: 1000.4 }, coords: { mm_x: 1000, mm_y: 1200, floor: 5 } });
    expect(out.changed).toBe(2);
  });

  it("keeps lights on a shortened rail", () => {
    const out = applyEdits(arclamp, edits({ rails: [["a", shape(0, 1000, 800, 1000)]] }));
    expect(at(out.lights, 1)).toMatchObject({ rail: { id: "a", mm_along: 800 }, coords: { mm_x: 800, mm_y: 1000 } });
  });

  it("leaves lights where they were when their rail is taken away", () => {
    const out = applyEdits(arclamp, edits({ rails: [["a", null]] }));
    expect(out.rails).toEqual([]);
    expect(at(out.lights, 1)).toMatchObject({ rail: null, coords: { mm_x: 1000.4, mm_y: 1000, floor: 5 } });
    expect(out.changed).toBe(2);
  });

  it("frees a light taken off its rail, and unplaces one taken off the map", () => {
    const out = applyEdits(arclamp, edits({ placements: [[1, { coords: { mm_x: 1, mm_y: 2, floor: 4 } }], [2, null]] }));
    expect(at(out.lights, 1)).toMatchObject({ rail: null, coords: { mm_x: 1, mm_y: 2, floor: 4 } });
    expect(at(out.lights, 2)).toMatchObject({ rail: null, coords: null });
    expect(out.changed).toBe(2);
  });

  it("never hangs a panel on a rail", () => {
    const out = applyEdits(arclamp, edits({ placements: [[4, { rail: { id: "a", mm_along: 10 } }]] }));
    expect(at(out.lights, 4)).toMatchObject({ rail: null, coords: { mm_x: 7000, mm_y: 2000, floor: 5 } });
    expect(out.changed).toBe(0);
  });

  it("gives lights the tags set in vibes, and counts them as changes", () => {
    const out = applyEdits(arclamp, edits({ tags: [[2, ["kitchen", "east"]], [3, []]] }));
    expect(at(out.lights, 2).tags).toEqual(["kitchen", "east"]);
    expect(at(out.lights, 3).tags).toEqual([]);
    expect(out.changed).toBe(1);
    expect(lightsFile(out).lights.find((l) => l.id === 2)?.tags).toEqual(["kitchen", "east"]);
  });

  it("keeps arclamp's order when the tags are the same, so the export doesn't change", () => {
    const tagged = { ...arclamp, lights: [light(2, { tags: ["b", "a"], coords: { mm_x: 1, mm_y: 1, floor: 4 } })] };
    const out = applyEdits(tagged, edits({ tags: [[2, ["a", "b"]]] }));
    expect(at(out.lights, 2).tags).toEqual(["b", "a"]);
    expect(out.changed).toBe(0);
  });

  it("applies orientations of the same hardware only", () => {
    const out = applyEdits(arclamp, edits({ types: [[4, "4x1-horizontal"], [2, "4x1-horizontal"]] }));
    expect(at(out.lights, 4).type).toBe("4x1-horizontal");
    expect(at(out.lights, 2).type).toBe("relay");
    expect(out.changed).toBe(1);
  });
});

describe("lightsFile", () => {
  it("writes rails between the types and the lights, and each light's rail before its coords", () => {
    const file = lightsFile(applyEdits(arclamp, edits({ types: [[4, "4x1-horizontal"]] })));
    expect(Object.keys(file)).toEqual(["id_width", "light_types", "rails", "lights"]);
    expect(file.light_types).toEqual([
      { name: "relay", channels: ["brightness"] },
      { name: "4x1-horizontal", channels: ["brightness"] },
    ]);
    expect(file.rails).toEqual([theirRail]);
    expect(file.lights[0]).toEqual({
      id: 1,
      type: "relay",
      tags: [],
      rail: { id: "a", mm_along: 1000.4 },
      coords: { mm_x: 1000.4, mm_y: 1000, floor: 5 },
    });
    expect(Object.keys(file.lights[0]!)).toEqual(["id", "type", "tags", "rail", "coords"]);
    expect(file.lights[2]).toEqual({ id: 3, type: "relay", tags: [] });
  });

  it("leaves rails out when there are none", () => {
    const file = lightsFile(applyEdits({ ...arclamp, rails: [], lights: [light(2, { coords: { mm_x: 1, mm_y: 1, floor: 5 } })] }, edits()));
    expect(Object.keys(file)).toEqual(["id_width", "light_types", "lights"]);
  });
});
