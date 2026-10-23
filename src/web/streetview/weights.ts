// How strongly each photographed bulb channel is on in a frame: each color
// bulb's lemtone through its solve (the firmware's, on its calibration) to
// duties for r, g, b, warm and cool white, as a share of the duty each map was
// photographed at. The room with every bulb off is always there underneath.

import type { Frame } from "../../shared/arclamp.ts";
import { SOLVERS } from "../../shared/devices.ts";
import { deviceOf, lemtoneOf } from "../../shared/fixtures.ts";
import { LUMENS_PER_BRIGHTNESS } from "../../shared/lemtone.ts";

// The solve's duties, in its order, and the maps they light.
const SOLVE_ORDER = ["R", "G", "B", "WW", "CW"];
// Each map was photographed with one channel driven full, which the
// firmware caps at the model's duty cap.
const PHOTOGRAPHED_DUTY = SOLVERS.bulb.model.dutyMax;
const AMBIENT = "amb";

// A room shows the same few lemtones frame after frame.
const duties = new Map<string, number[]>();
function dutyOf(a: number, b: number, brightness: number, fidelity: number): number[] {
  const key = `${a} ${b} ${brightness} ${fidelity}`;
  let d = duties.get(key);
  if (!d) {
    if (duties.size > 4096) duties.clear();
    d = SOLVERS.bulb.solve(a, b, brightness * LUMENS_PER_BRIGHTNESS, fidelity).duty;
    duties.set(key, d);
  }
  return d;
}

/** The bulb ids a basis has maps of ("b07-WW" is bulb 7). */
export function bulbsOf(maps: Iterable<string>): number[] {
  const ids = new Set<number>();
  for (const m of maps) {
    const id = /^b(\d+)-/.exec(m)?.[1];
    if (id) ids.add(Number(id));
  }
  return [...ids].sort((a, b) => a - b);
}

const mapName = (id: number, channel: string) => `b${String(id).padStart(2, "0")}-${channel}`;

/** Each map's weight for this frame; a bulb missing from the frame, or of another kind now, is off. */
export function weightsOf(frame: Frame | null, bulbs: readonly number[], types: ReadonlyMap<number, string>): Map<string, number> {
  const w = new Map<string, number>([[AMBIENT, 1]]);
  for (const id of bulbs) {
    const type = types.get(id) ?? "br30";
    const t = deviceOf(type) === "bulb" ? lemtoneOf(frame?.lights.get(id), type) : null;
    const d = t ? dutyOf(t.a, t.b, t.brightness, t.fidelity) : null;
    SOLVE_ORDER.forEach((c, i) => w.set(mapName(id, c), d ? d[i]! / PHOTOGRAPHED_DUTY : 0));
  }
  return w;
}

/** Whether two frames' weights are the same (to tell when the lights have settled). */
export function sameWeights(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (Math.abs((b.get(k) ?? -1) - v) > 1e-4) return false;
  return true;
}
