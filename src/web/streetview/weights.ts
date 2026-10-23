// How strongly each photographed bulb channel is on in a frame. Each map is
// one channel of one bulb, photographed alone at duty 1. A color bulb's
// lemtone goes through its solve (the firmware's, on its calibration) to
// duties for r, g, b, warm and cool white, and the calibration says what light
// each channel then gives: not in proportion to its duty (a channel's light
// per unit duty shifts with duty, in color as well as amount), and less when
// the others draw too (the supply sags). A map's weight is that light over the
// light it was photographed in, color by color in the maps' own space (linear
// ProPhoto), so it's three numbers. The room with every bulb off is always
// there underneath.

import type { Frame } from "../../shared/arclamp.ts";
import { SOLVERS } from "../../shared/devices.ts";
import { deviceOf, lemtoneOf } from "../../shared/fixtures.ts";
import { LUMENS_PER_BRIGHTNESS, type Vec3 } from "../../shared/lemtone.ts";

/** A map's weight, per color of the maps' space. */
export type Weight = readonly [number, number, number];

// The solve's duties, in its order, and the maps they light.
const SOLVE_ORDER = ["R", "G", "B", "WW", "CW"];
// Each map's channel was driven full when it was photographed. The
// calibration was measured to 0.8; past its last knot a channel keeps that
// knot's light per unit duty.
const PHOTOGRAPHED_DUTY = 1;
const AMBIENT = "amb";
const FULL: Weight = [1, 1, 1];
const OFF: Weight = [0, 0, 0];
// A color a map has under this share of its strongest is too faint in it for
// its own ratio to mean anything (red's blue, green's red, blue's green): it
// takes the strongest's.
const FAINT = 0.1;

// XYZ to linear ProPhoto (ROMM RGB), the maps' space.
const XYZ_TO_PP = [
  [1.3459434, -0.2556075, -0.0511118],
  [-0.5445988, 1.5081673, 0.0205351],
  [0, 0, 1.2118128],
];
const ppOf = (xyz: Vec3): Vec3 => [0, 1, 2].map((r) => XYZ_TO_PP[r]![0]! * xyz[0] + XYZ_TO_PP[r]![1]! * xyz[1] + XYZ_TO_PP[r]![2]! * xyz[2]) as Vec3;

// Each channel's light as photographed: alone, at full duty.
const PHOTOGRAPHED = SOLVE_ORDER.map((_, i) => ppOf(SOLVERS.bulb.forwardEach(SOLVE_ORDER.map((_, j) => (j === i ? PHOTOGRAPHED_DUTY : 0)))[i]!));

/** Each channel's weight (r, g, b, ww, cw) at duties d: its light now over its light as photographed. */
export function channelWeights(d: readonly number[]): Weight[] {
  return SOLVERS.bulb.forwardEach([...d]).map((xyz, i): Weight => {
    if (!(d[i]! > 0)) return OFF;
    const now = ppOf(xyz);
    const then = PHOTOGRAPHED[i]!;
    const k = then.indexOf(Math.max(...then));
    const strongest = now[k]! / then[k]!;
    const at = (c: number) => (then[c]! >= FAINT * then[k]! ? Math.max(0, now[c]! / then[c]!) : strongest);
    return [at(0), at(1), at(2)];
  });
}

// A room shows the same few lemtones frame after frame.
const solved = new Map<string, Weight[]>();
function weightsOfLemtone(a: number, b: number, brightness: number, fidelity: number): Weight[] {
  const key = `${a} ${b} ${brightness} ${fidelity}`;
  let w = solved.get(key);
  if (!w) {
    if (solved.size > 4096) solved.clear();
    w = channelWeights(SOLVERS.bulb.solve(a, b, brightness * LUMENS_PER_BRIGHTNESS, fidelity).duty);
    solved.set(key, w);
  }
  return w;
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
export function weightsOf(frame: Frame | null, bulbs: readonly number[], types: ReadonlyMap<number, string>): Map<string, Weight> {
  const w = new Map<string, Weight>([[AMBIENT, FULL]]);
  for (const id of bulbs) {
    const type = types.get(id) ?? "br30";
    const t = deviceOf(type) === "bulb" ? lemtoneOf(frame?.lights.get(id), type) : null;
    const cw = t ? weightsOfLemtone(t.a, t.b, t.brightness, t.fidelity) : null;
    SOLVE_ORDER.forEach((c, i) => w.set(mapName(id, c), cw ? cw[i]! : OFF));
  }
  return w;
}

/** Whether two frames' weights are the same (to tell when the lights have settled). */
export function sameWeights(a: Map<string, Weight>, b: Map<string, Weight>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const u = b.get(k);
    if (!u || v.some((x, c) => Math.abs(u[c]! - x) > 1e-4)) return false;
  }
  return true;
}
