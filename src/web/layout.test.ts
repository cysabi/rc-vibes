import { describe, expect, it } from "vitest";
import type { Coords, LightInfo, Rail, RailSpot } from "../shared/arclamp.ts";
import type { Spot } from "../shared/vibes.ts";
import { FLOORS } from "./floors.ts";
import { currentRails, layoutLights, placeLights, type Pending } from "./layout.ts";

const light = (id: number, coords: Coords | null = null, type = "br30", rail: RailSpot | null = null): LightInfo => ({
  id,
  type,
  tags: [],
  coords,
  rail,
  channels: [],
});
const nothing: Pending = { spots: new Map(), types: new Map() };
const pending = (spots: [number, Spot | null][], types: [number, string][] = []): Pending => ({ spots: new Map(spots), types: new Map(types) });

// Stands in for planExtent(), which measures the drawings in a browser.
const frame = { minX: 0, minY: 0, maxX: 28700, maxY: 12200 };

describe("floor plans", () => {
  it("strips the reference grid, dimensions, room labels, accessible-stall markings and print size", () => {
    for (const floor of FLOORS) {
      expect(floor.svg).not.toContain("M2 -7L0 1H-6L-12 10H-15");
      expect(floor.svg).not.toMatch(/<circle [^>]*stroke-dasharray/);
      expect(floor.svg).toContain('data-door="Womens accessible stall"');
      expect(floor.svg).not.toContain('inkscape:label="Reference grid"');
      expect(floor.svg).not.toContain('inkscape:label="Room names and leaders"');
      expect(floor.svg).not.toContain("MEETING");
      expect(floor.svg).not.toContain('inkscape:label="Dimensions"');
      expect(floor.svg).not.toContain("<metadata>");
      expect(floor.svg).not.toMatch(/<svg[^>]*\swidth=/);
      expect(floor.svg).toContain('inkscape:label="Exterior walls and glazing"');
    }
  });

  it("shares one millimeter frame across floors", () => {
    expect(FLOORS.map((f) => f.id)).toEqual([4, 5]);
    expect(FLOORS[0]!.viewBox).toEqual(FLOORS[1]!.viewBox);
    expect(FLOORS[0]!.viewBox.width).toBeCloseTo(36281.27, 1);
  });
});

describe("layoutLights", () => {
  const lights = [
    light(1, { mm_x: 1000, mm_y: 2000, floor: 5 }),
    light(2, { mm_x: 4000, mm_y: 2000, floor: 5 }),
    light(3, { mm_x: 30000, mm_y: 2000, floor: 4 }, "4x1-horizontal"),
    light(4),
    light(6, null, "relay"),
  ];

  const placed = placeLights(lights, new Map(), nothing);

  it("places a floor's lights at their coords and leaves unplaced ones off the map", () => {
    const l = layoutLights(placed, [], 5, frame);
    expect(l.lights).toEqual([
      { id: 1, type: "br30", floor: 5, x: 1000, y: 2000, rail: null },
      { id: 2, type: "br30", floor: 5, x: 4000, y: 2000, rail: null },
    ]);
    expect(l.plan?.id).toBe(5);
    expect(l.spacing).toBe(3000);
    expect(layoutLights(placed, [], 4, frame).lights.map((p) => p.id)).toEqual([3]);
  });

  it("fits every floor to the same box, including panels' real size and rails", () => {
    const rail: Rail = { id: "r", floor: 4, from: { mm_x: 0, mm_y: 0 }, to: { mm_x: 0, mm_y: 15000 } };
    const four = layoutLights(placed, [rail], 4, frame);
    const five = layoutLights(placed, [rail], 5, frame);
    expect(four.fit).toEqual(five.fit);
    // Light 3 is a horizontal panel outside the plan: 4 ft wide, so it reaches 609.6 mm past its center.
    expect(five.fit.maxX).toBeCloseTo(30609.6);
    expect(five.fit.maxY).toBe(15000);
    expect(four.rails).toEqual([rail]);
    expect(five.rails).toEqual([]);
  });

  it("falls back to a sensible glow size on an empty floor", () => {
    expect(layoutLights(placeLights([light(1)], new Map(), nothing), [], 4, frame).spacing).toBe(1500);
  });
});

describe("placeLights", () => {
  const rail: Rail = { id: "r", floor: 5, from: { mm_x: 1000, mm_y: 1000 }, to: { mm_x: 5000, mm_y: 1000 } };
  const onRail = light(1, { mm_x: 2000, mm_y: 1000, floor: 5 }, "br30", { id: "r", mm_along: 1000 });

  it("hangs lights on their rails, following the rail as it is now", () => {
    const moved = currentRails([rail], new Map([["r", { ...rail, from: { mm_x: 1000, mm_y: 3000 }, to: { mm_x: 5000, mm_y: 3000 } }]]));
    expect(placeLights([onRail], moved, nothing)).toEqual([{ id: 1, type: "br30", floor: 5, x: 2000, y: 3000, rail: { id: "r", mm_along: 1000 } }]);
  });

  it("keeps lights within a shortened rail", () => {
    const short = currentRails([rail], new Map([["r", { ...rail, to: { mm_x: 1500, mm_y: 1000 } }]]));
    expect(placeLights([onRail], short, nothing)[0]).toMatchObject({ x: 1500, rail: { mm_along: 500 } });
  });

  it("leaves a light where it was when its rail is taken away", () => {
    const rails = currentRails([rail], new Map([["r", null]]));
    expect(rails.size).toBe(0);
    expect(placeLights([onRail], rails, nothing)[0]).toMatchObject({ x: 2000, y: 1000, rail: null });
  });

  it("shows pending moves and turns before the server has them", () => {
    const rails = currentRails([rail], new Map());
    const panel = light(2, { mm_x: 0, mm_y: 0, floor: 4 }, "4x1");
    const out = placeLights(
      [onRail, panel, light(3)],
      rails,
      pending(
        [
          [1, { coords: { mm_x: 9, mm_y: 9, floor: 4 } }],
          [3, { rail: { id: "r", mm_along: 4000 } }],
        ],
        [[2, "4x1-horizontal"]],
      ),
    );
    expect(out).toEqual([
      { id: 1, type: "br30", floor: 4, x: 9, y: 9, rail: null },
      { id: 2, type: "4x1-horizontal", floor: 4, x: 0, y: 0, rail: null },
      { id: 3, type: "br30", floor: 5, x: 5000, y: 1000, rail: { id: "r", mm_along: 4000 } },
    ]);
    expect(placeLights([onRail], rails, pending([[1, null]]))).toEqual([]);
  });
});
