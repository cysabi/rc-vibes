// Rails: the straight tracks lights hang on. A light on a rail sits mm_along
// millimeters from the rail's `from` end and its coords follow from that, so
// correcting a rail moves its lights with it. Shared by the server and the
// browser.

import type { Coords, Rail } from "./arclamp.ts";
import { footprintOf } from "./fixtures.ts";

/** A rail without its id. */
export type RailShape = Omit<Rail, "id">;

export interface Point {
  x: number;
  y: number;
}

export const RAIL_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** A fresh rail id, e.g. "r-k3x9qa". */
export function newRailId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `r-${[...bytes].map((b) => (b % 36).toString(36)).join("")}`;
}

/** 4×1 panels sit in the ceiling grid; everything else can hang on a rail. */
export const hangsOnRails = (type: string) => !footprintOf(type);

export const railLength = (r: RailShape) => Math.hypot(r.to.mm_x - r.from.mm_x, r.to.mm_y - r.from.mm_y);

export const clampAlong = (r: RailShape, along: number) => Math.min(Math.max(along, 0), railLength(r));

/** The point `along` millimeters from the rail's `from` end. */
export function railPoint(r: RailShape, along: number): Point {
  const length = railLength(r);
  const t = length > 0 ? along / length : 0;
  return { x: r.from.mm_x + (r.to.mm_x - r.from.mm_x) * t, y: r.from.mm_y + (r.to.mm_y - r.from.mm_y) * t };
}

/** A light's coords on a rail, to the whole millimeter (as lights.json has them). */
export function railCoords(r: RailShape, along: number): Coords {
  const p = railPoint(r, clampAlong(r, along));
  return { mm_x: Math.round(p.x), mm_y: Math.round(p.y), floor: r.floor };
}

/** The nearest point on a rail to (x, y): how far along it is, and how far away. */
export function nearestOnRail(r: RailShape, x: number, y: number): Point & { along: number; distance: number } {
  const dx = r.to.mm_x - r.from.mm_x;
  const dy = r.to.mm_y - r.from.mm_y;
  const length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.min(Math.max(((x - r.from.mm_x) * dx + (y - r.from.mm_y) * dy) / length2, 0), 1) : 0;
  const px = r.from.mm_x + dx * t;
  const py = r.from.mm_y + dy * t;
  return { x: px, y: py, along: t * Math.sqrt(length2), distance: Math.hypot(x - px, y - py) };
}

/**
 * Where a light ends up along a rail after one of its ends moves: it keeps
 * its distance from the end that stayed put. (A light's place is measured
 * from `from`, so moving `from` changes it.)
 */
export function alongAfterEndMove(before: RailShape, after: RailShape, end: "from" | "to", along: number): number {
  return end === "to" ? along : railLength(after) - (railLength(before) - along);
}

export const sameRail = (a: RailShape | null | undefined, b: RailShape | null | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.floor === b.floor &&
    a.from.mm_x === b.from.mm_x &&
    a.from.mm_y === b.from.mm_y &&
    a.to.mm_x === b.to.mm_x &&
    a.to.mm_y === b.to.mm_y);

const LEVEL_SNAP = (2.5 * Math.PI) / 180;

/**
 * Settle the angle of a rail being drawn from `anchor` to `p`: to 45° steps
 * when `steps` is set, otherwise to exactly level or plumb when it's within a
 * couple of degrees of it. Keeps the length.
 */
export function settleAngle(anchor: Point, p: Point, steps: boolean): Point {
  const dx = p.x - anchor.x;
  const dy = p.y - anchor.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return p;
  const angle = Math.atan2(dy, dx);
  const step = steps ? Math.PI / 4 : Math.PI / 2;
  const snapped = Math.round(angle / step) * step;
  if (!steps && Math.abs(snapped - angle) > LEVEL_SNAP) return p;
  return { x: anchor.x + length * Math.cos(snapped), y: anchor.y + length * Math.sin(snapped) };
}
