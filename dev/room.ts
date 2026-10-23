// A room to run sketches on without arclamp: the real one, from a saved copy
// of vibes' /api/lights (or arclamp's /v1/lights, the same shape) at
// dev/lights.json (ignored by git; save it there while logged in to vibes);
// else a made-up floor 4. For the preview page outside VS Code
// (vite.config.ts), and anything else standing in for arclamp.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Light {
  id: number;
  type: string;
  tags: string[];
  coords: { mm_x: number; mm_y: number; floor: number } | null;
  rail: { id: string; mm_along: number } | null;
  channels: string[];
}

export interface Rail {
  id: string;
  floor: number;
  from: { mm_x: number; mm_y: number };
  to: { mm_x: number; mm_y: number };
}

export interface Room {
  id_width: 1 | 2;
  rails: Rail[];
  lights: Light[];
}

export const LIGHTS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "lights.json");
const COLOR = ["a", "b", "brightness", "fidelity"];

/** The room: the real one if it's been saved here, else a made-up one. Says which. */
export function loadRoom(): Room {
  if (existsSync(LIGHTS_FILE)) {
    const saved = JSON.parse(readFileSync(LIGHTS_FILE, "utf8")) as { lights?: Partial<Light>[]; rails?: Rail[] };
    if (Array.isArray(saved.lights)) {
      const lights = saved.lights
        .filter((l) => typeof l.id === "number" && typeof l.type === "string")
        .map((l) => ({
          id: l.id!,
          type: l.type!,
          tags: Array.isArray(l.tags) ? l.tags : [],
          coords: l.coords && typeof l.coords === "object" ? l.coords : null,
          rail: l.rail && typeof l.rail === "object" ? l.rail : null,
          channels: Array.isArray(l.channels) && l.channels.length > 0 ? l.channels : l.type === "relay" ? ["on"] : COLOR,
        }));
      const rails = Array.isArray(saved.rails) ? saved.rails : [];
      console.log(`the room from ${path.relative(process.cwd(), LIGHTS_FILE)}: ${lights.length} lights, ${rails.length} rails`);
      return { id_width: lights.some((l) => l.id > 255) ? 2 : 1, rails, lights };
    }
  }
  console.log(`a made-up room (save https://vibes.recurse.com/api/lights as ${path.relative(process.cwd(), LIGHTS_FILE)} for the real one)`);
  return madeUpRoom();
}

/** A made-up floor 4: three rows of color bulbs (the middle one on a rail), four panels, four old bulbs. */
export function madeUpRoom(): Room {
  const lights: Light[] = [];
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 8; i++) {
      lights.push({
        id: 1 + row * 8 + i,
        type: "br30",
        tags: [`row-${row + 1}`, ...(i < 4 ? ["west"] : ["east"])],
        coords: { mm_x: 3000 + i * 3600, mm_y: 2500 + row * 4000, floor: 4 },
        rail: row === 1 ? { id: "rail-1", mm_along: i * 3600 } : null,
        channels: COLOR,
      });
    }
  }
  for (let i = 0; i < 4; i++) lights.push({ id: 56 + i, type: "4x1", tags: ["panel"], coords: { mm_x: 6000 + i * 6000, mm_y: 13000, floor: 4 }, rail: null, channels: COLOR });
  for (let i = 0; i < 4; i++) lights.push({ id: 64 + i, type: "relay", tags: ["old"], coords: { mm_x: i % 2 ? 29000 : 1000, mm_y: i < 2 ? 1000 : 12000, floor: 4 }, rail: null, channels: ["on"] });
  return { id_width: 1, rails: [{ id: "rail-1", floor: 4, from: { mm_x: 3000, mm_y: 6500 }, to: { mm_x: 28200, mm_y: 6500 } }], lights };
}
