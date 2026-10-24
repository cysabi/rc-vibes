// The map's layout as vibes changes it: where lights are (free on a floor, or
// on a rail), the rails, which way lights face (another arclamp type), and
// their tags. Kept in vibes' database until exported into arclamp's
// lights.json; the routes (api.ts) and the live state's updates (updates.ts)
// both change it here, by the same rules. Each change refuses (Refused) what
// it won't make, before making any of it.

import { orientationsOf } from "../shared/fixtures.ts";
import { clampAlong, hangsOnRails, railLength, type RailShape } from "../shared/rails.ts";
import type { Lights, Me, Placement, Spot } from "../shared/vibes.ts";
import type { LightsResponse } from "../shared/arclamp.ts";
import type { Db } from "./db.ts";
import { Refused } from "./shaders.ts";

// Changes from one person within this window log as one entry.
const LOG_WINDOW_MS = 15_000;

export interface LayoutDeps {
  db: Db;
  /** arclamp's lights, as it has them. */
  arclampLights: () => Promise<LightsResponse>;
  /** The lights with vibes' changes made. */
  currentLights: () => Promise<Lights>;
  /** Told after each change is made (the live state shows it). */
  changed?: () => Promise<void> | void;
}

export function createLayout({ db, arclampLights, currentLights, changed = () => {} }: LayoutDeps) {
  return {
    /** Lights put somewhere: free (coords null takes one off the map), or on a rail, a whole millimeter along it. */
    async place(placements: Placement[], user: Me) {
      const now = await currentLights();
      const lights = new Map(now.lights.map((l) => [l.id, l]));
      const rails = new Map(now.rails.map((r) => [r.id, r]));
      const spots: { id: number; spot: Spot | null }[] = [];
      for (const p of placements) {
        const light = lights.get(p.id);
        if (!light) throw new Refused(404, "not_found", `no light ${p.id}`);
        if ("rail" in p) {
          const rail = rails.get(p.rail.id);
          if (!rail) throw new Refused(404, "not_found", `no rail ${p.rail.id}`);
          if (!hangsOnRails(light.type)) throw new Refused(400, "bad_rail", `light ${p.id} (${light.type}) doesn't hang on rails`);
          spots.push({ id: p.id, spot: { rail: { id: rail.id, mm_along: Math.round(clampAlong(rail, p.rail.mm_along)) } } });
        } else {
          const at = p.coords && { mm_x: Math.round(p.coords.mm_x), mm_y: Math.round(p.coords.mm_y), floor: p.coords.floor };
          spots.push({ id: p.id, spot: at && { coords: at } });
        }
      }
      db.setPlacements(spots, user);
      db.logCoalesced({ user, action: "lights.move", detail: { lights: placements.length } }, LOG_WINDOW_MS);
      await changed();
    },

    /** Rails drawn or moved, or (null) taken away: lights on one taken away stay where they are. */
    async setRails(rails: { id: string; rail: RailShape | null }[], user: Me) {
      const round = (p: { mm_x: number; mm_y: number }) => ({ mm_x: Math.round(p.mm_x), mm_y: Math.round(p.mm_y) });
      const shaped = rails.map(({ id, rail }) => ({ id, rail: rail && { floor: rail.floor, from: round(rail.from), to: round(rail.to) } }));
      const short = shaped.find((r) => r.rail && railLength(r.rail) < 1);
      if (short) throw new Refused(400, "bad_rail", `rail ${short.id} has no length`);
      const gone = new Set(shaped.filter((r) => !r.rail).map((r) => r.id));
      const stranded = (await currentLights()).lights.filter((l) => l.rail && gone.has(l.rail.id)).map((l) => ({ id: l.id, spot: l.coords && { coords: l.coords } }));
      db.setRails(shaped, stranded, user);
      db.logCoalesced({ user, action: "rails.change", detail: { rails: shaped.length } }, LOG_WINDOW_MS);
      await changed();
    },

    /** Lights turned to another orientation (another of arclamp's types for them). */
    async turn(lights: { id: number; type: string }[], user: Me) {
      const byId = new Map((await arclampLights()).lights.map((l) => [l.id, l]));
      for (const { id, type } of lights) {
        const light = byId.get(id);
        if (!light) throw new Refused(404, "not_found", `no light ${id}`);
        if (!orientationsOf(light.type).includes(type)) throw new Refused(400, "bad_type", `light ${id} (${light.type}) can't be turned to ${type}`);
      }
      db.setTypes(lights, user);
      db.logCoalesced({ user, action: "lights.turn", detail: { lights: lights.length } }, LOG_WINDOW_MS);
      await changed();
    },

    /** Each light's whole set of tags. The log says which tags went on and off. */
    async tag(given: { id: number; tags: string[] }[], user: Me) {
      const lights = given.map(({ id, tags }) => ({ id, tags: [...new Set(tags)].sort() }));
      const byId = new Map((await currentLights()).lights.map((l) => [l.id, l]));
      const added = new Set<string>();
      const removed = new Set<string>();
      for (const { id, tags } of lights) {
        const light = byId.get(id);
        if (!light) throw new Refused(404, "not_found", `no light ${id}`);
        const before = new Set(light.tags ?? []);
        for (const t of tags) if (!before.has(t)) added.add(t);
        for (const t of before) if (!tags.includes(t)) removed.add(t);
      }
      db.setTags(lights, user);
      db.log({ user, action: "lights.tag", detail: { lights: lights.length, added: [...added], removed: [...removed] } });
      await changed();
    },
  };
}

export type LayoutEdits = ReturnType<typeof createLayout>;
