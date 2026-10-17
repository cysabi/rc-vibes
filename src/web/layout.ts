// Where each light sits on the map: free lights at their coords, lights on
// rails wherever along their rail they hang, in millimeters on their floor's
// plan. Lights that are neither aren't on the map; they wait in the drawer.

import type { LightInfo, Rail, RailSpot } from "../shared/arclamp.ts";
import { footprintOf } from "../shared/fixtures.ts";
import { clampAlong, hangsOnRails, railPoint, type RailShape } from "../shared/rails.ts";
import type { Spot } from "../shared/vibes.ts";
import { FLOORS, union, type Bounds, type Floor } from "./floors.ts";

export interface PlacedLight {
  id: number;
  type: string;
  floor: number;
  x: number;
  y: number;
  /** The rail it hangs on, with mm_along kept within the rail. */
  rail: RailSpot | null;
}

/** Changes made on the map that the server hasn't caught up with yet. */
export interface Pending {
  spots: ReadonlyMap<number, Spot | null>;
  types: ReadonlyMap<number, string>;
}

export interface MapLayout {
  lights: PlacedLight[];
  rails: Rail[];
  /** What "fit" shows: every floor's plan, light and rail, so it's the same on every floor. */
  fit: Bounds;
  /** Typical distance between neighboring lights on this floor, in millimeters. */
  spacing: number;
  plan: Floor | null;
}

// Glow size on a floor with fewer than two lights, in millimeters.
const DEFAULT_SPACING = 1500;

/** Rails as they are now: the server's, with pending changes (null: taken away) applied. */
export function currentRails(rails: Rail[], pending: ReadonlyMap<string, RailShape | null>): Map<string, Rail> {
  const out = new Map(rails.map((r) => [r.id, r]));
  for (const [id, shape] of pending) {
    if (shape) out.set(id, { id, ...shape });
    else out.delete(id);
  }
  return out;
}

/** Every light that's on the map, on any floor, wherever it is now. */
export function placeLights(lights: LightInfo[], rails: ReadonlyMap<string, Rail>, pending: Pending): PlacedLight[] {
  const out: PlacedLight[] = [];
  for (const l of lights) {
    const type = pending.types.get(l.id) ?? l.type;
    const spot = pending.spots.has(l.id) ? pending.spots.get(l.id)! : l.rail ? { rail: l.rail } : l.coords && { coords: l.coords };
    if (!spot) continue;
    if ("coords" in spot) {
      out.push({ id: l.id, type, floor: spot.coords.floor, x: spot.coords.mm_x, y: spot.coords.mm_y, rail: null });
      continue;
    }
    const r = rails.get(spot.rail.id);
    if (r && hangsOnRails(type)) {
      const along = clampAlong(r, spot.rail.mm_along);
      out.push({ id: l.id, type, floor: r.floor, ...railPoint(r, along), rail: { id: r.id, mm_along: along } });
    } else if (l.coords) {
      // Its rail is gone: it stays where the server last had it.
      out.push({ id: l.id, type, floor: l.coords.floor, x: l.coords.mm_x, y: l.coords.mm_y, rail: null });
    }
  }
  return out;
}

/** Lay out one floor. `frame` is the extent of every floor's plan (see planExtent). */
export function layoutLights(placed: PlacedLight[], rails: Iterable<Rail>, floor: number, frame: Bounds): MapLayout {
  const plan = FLOORS.find((f) => f.id === floor) ?? null;
  let fit = frame;
  for (const l of placed) {
    const size = footprintOf(l.type);
    const w = (size?.width ?? 0) / 2;
    const h = (size?.height ?? 0) / 2;
    fit = union(fit, { minX: l.x - w, minY: l.y - h, maxX: l.x + w, maxY: l.y + h });
  }
  const railsHere: Rail[] = [];
  for (const r of rails) {
    fit = union(fit, {
      minX: Math.min(r.from.mm_x, r.to.mm_x),
      minY: Math.min(r.from.mm_y, r.to.mm_y),
      maxX: Math.max(r.from.mm_x, r.to.mm_x),
      maxY: Math.max(r.from.mm_y, r.to.mm_y),
    });
    if (r.floor === floor) railsHere.push(r);
  }
  const here = placed.filter((l) => l.floor === floor);
  const spacing = here.length > 1 ? medianNeighborDistance(here) : DEFAULT_SPACING;
  return { lights: here, rails: railsHere, fit, spacing, plan };
}

function medianNeighborDistance(lights: { x: number; y: number }[]): number {
  const nearest = lights.map((a, i) => {
    let best = Infinity;
    lights.forEach((b, j) => {
      if (i !== j) best = Math.min(best, Math.hypot(a.x - b.x, a.y - b.y));
    });
    return best;
  });
  nearest.sort((a, b) => a - b);
  return nearest[Math.floor(nearest.length / 2)] || DEFAULT_SPACING;
}
