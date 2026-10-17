import { describe, expect, it } from "vitest";
import {
  alongAfterEndMove,
  clampAlong,
  hangsOnRails,
  nearestOnRail,
  newRailId,
  RAIL_ID,
  railCoords,
  railLength,
  railPoint,
  sameRail,
  settleAngle,
  type RailShape,
} from "./rails.ts";

const rail = (fx: number, fy: number, tx: number, ty: number, floor = 5): RailShape => ({
  floor,
  from: { mm_x: fx, mm_y: fy },
  to: { mm_x: tx, mm_y: ty },
});

describe("rail geometry", () => {
  const r = rail(1000, 2000, 4000, 6000); // 3-4-5: 5000 mm long

  it("measures and walks along a rail from its from end", () => {
    expect(railLength(r)).toBe(5000);
    expect(railPoint(r, 0)).toEqual({ x: 1000, y: 2000 });
    expect(railPoint(r, 2500)).toEqual({ x: 2500, y: 4000 });
    expect(railPoint(r, 5000)).toEqual({ x: 4000, y: 6000 });
  });

  it("gives whole-millimeter coords on the rail's floor, kept on the rail", () => {
    expect(railCoords(r, 1001)).toEqual({ mm_x: 1601, mm_y: 2801, floor: 5 });
    expect(railCoords(r, 9000)).toEqual({ mm_x: 4000, mm_y: 6000, floor: 5 });
    expect(railCoords(r, -10)).toEqual({ mm_x: 1000, mm_y: 2000, floor: 5 });
    expect(clampAlong(r, 7000)).toBe(5000);
  });

  it("finds the nearest point on a rail, stopping at its ends", () => {
    const flat = rail(0, 0, 1000, 0);
    expect(nearestOnRail(flat, 400, 30)).toEqual({ x: 400, y: 0, along: 400, distance: 30 });
    expect(nearestOnRail(flat, -300, 400)).toEqual({ x: 0, y: 0, along: 0, distance: 500 });
    expect(nearestOnRail(flat, 1300, -400)).toEqual({ x: 1000, y: 0, along: 1000, distance: 500 });
  });

  it("keeps lights measured from the end that stays put", () => {
    const before = rail(0, 0, 1000, 0);
    // Dragging `to` out: lights stay put from `from`.
    expect(alongAfterEndMove(before, rail(0, 0, 1500, 0), "to", 300)).toBe(300);
    // Dragging `from` back 500 mm: lights stay put, now 500 mm further along.
    expect(alongAfterEndMove(before, rail(-500, 0, 1000, 0), "from", 300)).toBe(800);
  });

  it("compares rails by shape", () => {
    expect(sameRail(rail(0, 0, 1, 1), rail(0, 0, 1, 1))).toBe(true);
    expect(sameRail(rail(0, 0, 1, 1), rail(0, 0, 1, 2))).toBe(false);
    expect(sameRail(rail(0, 0, 1, 1, 4), rail(0, 0, 1, 1, 5))).toBe(false);
    expect(sameRail(null, undefined)).toBe(false);
  });
});

describe("drawing rails", () => {
  it("settles nearly level or plumb rails exactly, and leaves others alone", () => {
    const a = { x: 0, y: 0 };
    const level = settleAngle(a, { x: 1000, y: 30 }, false); // ~1.7°
    expect(level.y).toBeCloseTo(0, 9);
    expect(level.x).toBeCloseTo(Math.hypot(1000, 30), 9);
    const plumb = settleAngle(a, { x: -20, y: -1000 }, false);
    expect(plumb.x).toBeCloseTo(0, 9);
    expect(plumb.y).toBeLessThan(0);
    expect(settleAngle(a, { x: 1000, y: 200 }, false)).toEqual({ x: 1000, y: 200 });
  });

  it("steps by 45° when asked", () => {
    const p = settleAngle({ x: 0, y: 0 }, { x: 1000, y: 800 }, true);
    expect(p.x).toBeCloseTo(p.y, 9);
  });

  it("makes short ids arclamp accepts", () => {
    const ids = new Set(Array.from({ length: 50 }, newRailId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(RAIL_ID);
  });

  it("keeps panels off rails", () => {
    expect(hangsOnRails("br30")).toBe(true);
    expect(hangsOnRails("relay")).toBe(true);
    expect(hangsOnRails("4x1")).toBe(false);
    expect(hangsOnRails("4x1-horizontal")).toBe(false);
  });
});
