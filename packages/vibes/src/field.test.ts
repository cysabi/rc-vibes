import { describe, expect, it } from "vitest";
import type { Prev } from "./arclamp.ts";
import { color, lemtone, palette, palettes, white, type Color } from "./color.ts";
import { field, gradient, isField, kaleid, move, noise, osc, rings, rotate, solid, voronoi } from "./field.ts";
import { Here, roomOf } from "./here.ts";
import { clock } from "./signal.ts";

// A room 20 m wide and 8 deep, centered at (12, 5).
const dark = { a: 0, b: 0, brightness: 0, fidelity: 1 };
const prev: Prev = {
  initial_time: 0,
  lights: [
    { id: 1, channels: dark, coords: { mm_x: 2000, mm_y: 1000, floor: 4 } },
    { id: 2, channels: dark, coords: { mm_x: 22000, mm_y: 9000, floor: 4 } },
    { id: 3, channels: { on: 0 }, coords: { mm_x: 6000, mm_y: 3000, floor: 4 }, rail: { id: "r", mm_along: 0 } },
  ],
};
const room = roomOf(prev);
const at = (x: number, y: number, t = 0, light = room.lights[0]!) => new Here(x, y, t, 0, 0, light, room);

/** Every half meter across the room, and a bit beyond. */
const everywhere = (t = 0) => {
  const spots: Here[] = [];
  for (let x = 0; x <= 24; x += 0.5) for (let y = 0; y <= 10; y += 0.5) spots.push(at(x, y, t));
  return spots;
};

describe("sources", () => {
  it("make numbers from 0 to 1 everywhere", () => {
    for (const f of [osc(), osc(7, 2, 0.3), noise(), noise(9, 1), rings(), gradient(), gradient(37), voronoi(), voronoi(9)]) {
      for (const here of everywhere(12.3)) {
        const v = f(here);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("count across the room's width", () => {
    // Three bands wall to wall: the same a third of the room apart.
    const o = osc(3, 0);
    expect(o(at(4, 5))).toBeCloseTo(o(at(4 + 20 / 3, 5)), 9);
    expect(gradient()(at(2, 5))).toBeCloseTo(0, 9);
    expect(gradient()(at(22, 5))).toBeCloseTo(1, 9);
    expect(gradient(90)(at(12, 9))).toBeCloseTo(1, 9);
    expect(rings(3, 0)(at(12, 5))).toBeCloseTo(0, 9);
  });

  it("move with time, at the speed asked", () => {
    const o = osc(3, 0.5);
    expect(o(at(7, 5, 0))).toBeCloseTo(o(at(7, 5, 2)), 9);
    expect(o(at(7, 5, 0))).not.toBeCloseTo(o(at(7, 5, 0.5)), 3);
  });

  it("take functions of here for any number", () => {
    const o = osc(({ u }) => 3 + u, 0);
    expect(o(at(7, 5))).toBeCloseTo(osc(3 + at(7, 5).u, 0)(at(7, 5)), 12);
    expect(solid(0.25)(at(1, 1))).toBe(0.25);
    expect(solid(white(2700, 5))(at(1, 1))).toEqual(white(2700, 5));
  });
});

describe("transforms", () => {
  it("are the plain functions, chained", () => {
    const f = noise(4, 0.3);
    const here = at(5, 7, 3);
    expect(f.rotate(30)(here)).toBe(f(rotate(here, 30)));
    expect(f.kaleid(5)(here)).toBe(f(kaleid(here, 5)));
    expect(f.move(1.5, -2)(here)).toBe(f(move(here, 1.5, -2)));
  });

  it("turn clockwise around the room's center", () => {
    const f = osc(3, 0);
    // Turned a quarter, what was 3 m right of center is 3 m below it.
    expect(f.rotate(90)(at(12, 8))).toBeCloseTo(f(at(15, 5)), 9);
    for (const here of everywhere()) expect(f.rotate(360)(here)).toBeCloseTo(f(here), 9);
  });

  it("scale and move the pattern", () => {
    const f = noise(5, 0);
    expect(f.scale(2)(at(16, 5))).toBeCloseTo(f(at(14, 5)), 9);
    expect(f.move(2, 1)(at(9, 6))).toBeCloseTo(f(at(7, 5)), 9);
  });

  it("fold into mirrored slices", () => {
    const f = noise(6, 0).kaleid(4);
    for (const d of [1, 2.5, 4]) {
      for (const deg of [10, 30, 70, 130]) {
        const r = (deg * Math.PI) / 180;
        const one = at(12 + d * Math.cos(r), 5 + d * Math.sin(r));
        const mirrored = at(12 + d * Math.cos(-r), 5 + d * Math.sin(-r));
        const quarter = at(12 + d * Math.cos(r + Math.PI / 2), 5 + d * Math.sin(r + Math.PI / 2));
        expect(f(one)).toBeCloseTo(f(mirrored), 9);
        expect(f(one)).toBeCloseTo(f(quarter), 9);
      }
    }
  });

  it("move time, by place too", () => {
    const f = osc(3, 0.4);
    expect(f.delay(1)(at(8, 5, 3))).toBeCloseTo(f(at(8, 5, 2)), 9);
    expect(f.speed(2)(at(8, 5, 3))).toBeCloseTo(f(at(8, 5, 6)), 9);
    const late = f.delay(({ u }) => 2 * u);
    expect(late(at(22, 5, 5))).toBeCloseTo(f(at(22, 5, 3)), 9);
  });

  it("warp by another field, not at all where it's 0.5", () => {
    const f = noise(5, 0);
    const here = at(9, 4);
    expect(f.warp(solid(0.5))(here)).toBe(f(here));
    expect(f.warp(solid(1), 2)(here)).toBeCloseTo(f(at(11, 6)), 9);
  });

  it("never change which light it is", () => {
    const seen: number[] = [];
    const f = field((here) => (seen.push(here.light.id), 0)).rotate(40).kaleid(3).move(2).delay(1);
    f(at(3, 3, 0, room.lights[2]));
    expect(seen).toEqual([3]);
  });
});

describe("values", () => {
  it("shape numbers", () => {
    const half = solid(0.5);
    const here = at(1, 1);
    expect(half.pow(2)(here)).toBe(0.25);
    expect(half.thresh()(here)).toBe(1);
    expect(solid(0.49).thresh()(here)).toBe(0);
    expect(half.invert()(here)).toBe(0.5);
    expect(half.mul(3)(here)).toBe(1.5);
    expect(half.add(solid(0.25))(here)).toBe(0.75);
    expect(half.mix(1, 0.5)(here)).toBe(0.75);
    expect(solid(0.6).steps(3)(here)).toBe(0.5);
    expect(solid(1).steps(3)(here)).toBe(1);
    expect(half.map((v, { light }) => v + light.id)(here)).toBe(1.5);
  });

  it("color numbers by a palette, or by palettes that change", () => {
    const here = at(1, 1);
    expect(solid(0).color(palettes.dusk)(here)).toEqual(palettes.dusk.stops[0]);
    const look = clock(60).every(1).seq([palettes.sea, palettes.ember]);
    expect(solid(1).color(look)(at(1, 1, 0.5))).toEqual(palettes.sea(1));
    expect(solid(1).color(look)(at(1, 1, 1.5))).toEqual(palettes.ember(1));
    expect(solid(0.5).color((v) => white(2700, v * 100))(here).lm).toBe(50);
  });

  it("change colors", () => {
    const here = at(1, 1);
    const c = solid<Color>(lemtone(100, 0.2, 40));
    expect(c.dim(0.5)(here).lm).toBe(20);
    expect(c.fade(0.5)(here).lm).toBe(5);
    expect(c.at(7)(here).lm).toBe(7);
    expect(c.boost(1, 0.5)(here).lm).toBe(60);
    expect(c.add(lemtone(100, 0.2, 40))(here).lm).toBeCloseTo(80, 9);
    expect(c.mix(white(2700, 40), 1)(here)).toEqual(white(2700, 40));
    expect(c.mix(white(2700, 40), 0.5)(here).lm).toBeCloseTo(40, 9);
    expect(c.mix(white(2700, 40))(here).lm).toBeCloseTo(40, 9);
    expect(solid<Color>(lemtone(265, 0.4, 900)).vivid()(here).lm).toBeLessThan(200);
    expect(c.shiftHue(20)(here).hue).toBeCloseTo(120, 9);
  });

  it("take anything that says a color, wherever a color goes", () => {
    const here = at(1, 1);
    const orange = color("#ff8800");
    expect(solid("#ff8800").dim(0.5)(here).lm).toBeCloseTo(orange.lm / 2, 9);
    expect(solid("orange").at(30)(here).lm).toBe(30);
    expect(solid({ r: 1, g: 0.5, b: 0 }).add("#000")(here).lm).toBeCloseTo(color([1, 0.5, 0]).lm, 9);
    // One color: from dark at 0 to it at 1, evenly as it looks.
    expect(solid(0.5).color("#ff8800")(here).lm).toBeCloseTo(orange.fade(0.5).lm, 6);
    expect(solid(1).color(["black", "#ff8800"])(here).hex).toBe("#ff8800");
    expect(solid(0.5).color([[0, "black"], [0.5, "white"], [1, "black"]])(here).hex).toBe("#ffffff");
    expect(solid(1).color((v) => `rgb(${v * 255} 0 0)`)(here).hex).toBe("#ff0000");
    expect(field(() => "2700K").mix(6500)(here).nearestKelvin).toBeGreaterThan(3500);
  });

  it("only touch the lights asked for", () => {
    let asked = 0;
    const f = field(() => (asked++, white(2700, 10))).only((light) => light.rail);
    expect(f(at(1, 1, 0, room.lights[0]))).toBeNull();
    expect(asked).toBe(0);
    expect(f(at(1, 1, 0, room.lights[2]))).toEqual(white(2700, 10));
  });
});

describe("fields", () => {
  it("are functions of here, and know themselves", () => {
    const plain = (here: Here) => here.u;
    const f = field(plain);
    expect(isField(f)).toBe(true);
    expect(isField(osc().kaleid(3))).toBe(true);
    expect(isField(plain)).toBe(false);
    expect(isField(palette(white(2700, 1)))).toBe(false);
    expect(Object.getPrototypeOf(plain)).toBe(Function.prototype);
    expect(field(f)).toBe(f);
    expect(f(at(12, 5))).toBe(0.5);
  });
});
