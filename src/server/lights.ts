// The map as vibes has it: arclamp's lights with the positions, rails and
// orientations set in vibes applied, and the lights.json that would deploy it.

import type { Coords, LightsResponse, Rail, RailSpot } from "../shared/arclamp.ts";
import { sameCoords, sameRailSpot } from "../shared/arclamp.ts";
import { orientationsOf } from "../shared/fixtures.ts";
import { clampAlong, hangsOnRails, railCoords, sameRail, type RailShape } from "../shared/rails.ts";
import type { Lights, Spot } from "../shared/vibes.ts";

export interface Edits {
  /** Rails drawn or moved in vibes; null for ones taken away. */
  rails: Map<string, RailShape | null>;
  /** Where lights were put; null for ones taken off the map. */
  placements: Map<number, Spot | null>;
  /** Orientations, as arclamp types (e.g. "4x1-horizontal"). */
  types: Map<number, string>;
}

export function applyEdits(raw: LightsResponse, edits: Edits): Lights {
  const theirs = new Map(raw.rails.map((r) => [r.id, r]));
  const rails: Rail[] = [];
  for (const r of raw.rails) {
    const edit = edits.rails.get(r.id);
    if (edit !== null) rails.push(edit ? { id: r.id, ...edit } : r);
  }
  for (const [id, edit] of edits.rails) if (edit && !theirs.has(id)) rails.push({ id, ...edit });
  const railById = new Map(rails.map((r) => [r.id, r]));

  let changed = rails.filter((r) => !sameRail(r, theirs.get(r.id))).length;
  changed += raw.rails.filter((r) => !railById.has(r.id)).length;

  const lights = raw.lights.map((l) => {
    // Only an orientation of the same hardware ever applies.
    const turned = edits.types.get(l.id);
    const type = turned && orientationsOf(l.type).includes(turned) ? turned : l.type;
    const spot: Spot | null = edits.placements.has(l.id)
      ? edits.placements.get(l.id)!
      : l.rail
        ? { rail: l.rail }
        : l.coords && { coords: l.coords };

    let coords: Coords | null = null;
    let rail: RailSpot | null = null;
    if (spot && "rail" in spot) {
      const r = railById.get(spot.rail.id);
      if (r && hangsOnRails(type)) {
        rail = { id: r.id, mm_along: clampAlong(r, spot.rail.mm_along) };
        // Untouched since arclamp placed it: keep arclamp's coords exactly.
        const untouched = l.coords && sameRailSpot(rail, l.rail) && sameRail(r, theirs.get(r.id));
        coords = untouched ? l.coords : railCoords(r, rail.mm_along);
      } else {
        // Its rail is gone: it stays where arclamp has it.
        coords = l.coords;
      }
    } else if (spot) {
      coords = spot.coords;
    }

    if (!sameCoords(coords, l.coords) || !sameRailSpot(rail, l.rail) || type !== l.type) changed++;
    return { ...l, type, coords, rail };
  });
  return { id_width: raw.id_width, rails, lights, changed };
}

/**
 * arclamp's lights.json for this map, to commit to rclamp's
 * deploy/lights.json and deploy. Each orientation is its own light type with
 * the same channels. Lights on rails keep their coords too, so anything that
 * ignores rails still knows where they are.
 */
export function lightsFile({ id_width, rails, lights }: Lights) {
  const types = new Map<string, string[]>();
  for (const l of lights) {
    if (!types.has(l.type)) types.set(l.type, l.channels);
  }
  const point = (p: { mm_x: number; mm_y: number }) => ({ mm_x: p.mm_x, mm_y: p.mm_y });
  return {
    id_width,
    light_types: [...types].map(([name, channels]) => ({ name, channels })),
    ...(rails.length > 0 && { rails: rails.map((r) => ({ id: r.id, floor: r.floor, from: point(r.from), to: point(r.to) })) }),
    lights: lights.map((l) => ({
      id: l.id,
      type: l.type,
      tags: l.tags ?? [],
      ...(l.rail && { rail: { id: l.rail.id, mm_along: l.rail.mm_along } }),
      ...(l.coords && { coords: l.coords }),
    })),
  };
}
