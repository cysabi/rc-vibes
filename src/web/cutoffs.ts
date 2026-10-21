// What each kind of light (the color bulbs, the 4×1 panels: devices.ts)
// makes of the colors on the color editor's pickers, worked out ahead, for
// painting their backdrops (backdrop.ts). Each color on the wheel and the
// strip of whites has a cutoff for each: the brightest it makes it as asked,
// as the brightness slider has it (its cube root: 1 is 1000 lm), or 0 if it
// never does. Dimmer than that it makes it; brighter, it can't. Fidelity
// barely moves it (a step or two of the slider, at most), so the tables are
// at fidelity 0.5. From them, what the lights make of any color at any
// brightness is a few lookups: whether a color's made as asked is whether
// its cutoff is at least the brightness, and one that isn't pales toward the
// light's white line until one that is, as the solve's desat does (solver.ts).
//
// They're worked out from the solves as vibes is built (vite.config.ts), a
// point per device pixel at 2×, and packed: each value as a share of the
// light's brightest (a panel goes to 4000 lm) in 16 bits, less a guess from
// the ones before it (LOCO-I's median predictor: a smooth table is mostly
// small numbers then), zigzagged, the high bytes and then the low, then
// gzipped (by the build). The page fetches them as it loads.

import { DEVICES, SOLVERS, type Device } from "../shared/devices.ts";
import { LUMENS_PER_BRIGHTNESS } from "../shared/lemtone.ts";
import { wheelColor } from "./wheel.ts";
import { whitesColor } from "./whites.ts";

/** One picker's cutoffs, a row at a time from the top left: point (i, j) is i / (width - 1) across and j / (height - 1) down. */
export interface Table {
  width: number;
  height: number;
  cutoffs: Float32Array<ArrayBuffer>;
}

/** One kind of light's tables. */
export interface Tables {
  wheel: Table;
  strip: Table;
}

/** Each kind of light's. */
export type Cutoffs = Record<Device, Tables>;

type Sizes = Record<keyof Tables, readonly [number, number]>;

/** Points across and down: a point per device pixel at 2×, for the wheel (224 CSS px) and the strip at its usual size (320 × 96). */
export const SIZES: Sizes = { wheel: [449, 449], strip: [641, 193] };

// The slider's first step: a color the bulbs don't make as asked there, they never do.
const LOOK_MIN = 0.005;
const FIDELITY = 0.5;
// Halvings a cutoff is found to: 1/16,000 of the slider, well past what shows (12 bits would do), short of
// what 16 bits keep, as finding it finer only adds noise to their low bits, which then don't pack as small.
const STEPS = 14;
const TOP = 0xffff;

/** Where each picker's colors are (fractions across and down), and how far it's worked out: the wheel, to a little past its rim, as backdrop.ts works it out. */
const PICKERS: Record<keyof Tables, { colorAt: (x: number, y: number) => [number, number]; worked: (x: number, y: number) => boolean }> = {
  wheel: { colorAt: (x, y) => wheelColor(x * 2 - 1, 1 - y * 2), worked: (x, y) => Math.hypot(x * 2 - 1, 1 - y * 2) <= 1.08 },
  strip: { colorAt: whitesColor, worked: () => true },
};

/** The top of a kind of light's brightness slider (its rated output), as the slider has it: a cutoff can't be past it. */
export const lookTopOf = (device: Device) => Math.cbrt(SOLVERS[device].model.ratedLm / LUMENS_PER_BRIGHTNESS);

/** Whether a kind of light makes (a, b) as asked at this place on the brightness slider. */
const makes = (device: Device, a: number, b: number, look: number) =>
  SOLVERS[device].makesExactly(a, b, look ** 3 * LUMENS_PER_BRIGHTNESS, FIDELITY);

/** The tables, from each kind of light's solve: a second or two's work each at their full size. */
export function makeCutoffs(sizes: Sizes = SIZES): Cutoffs {
  const tablesOf = (device: Device): Tables => ({ wheel: tableOf(device, "wheel", sizes.wheel), strip: tableOf(device, "strip", sizes.strip) });
  return { bulb: tablesOf("bulb"), panel: tablesOf("panel") };
}

function tableOf(device: Device, picker: keyof Tables, [width, height]: readonly [number, number]): Table {
  const { colorAt, worked } = PICKERS[picker];
  const top = lookTopOf(device);
  const cutoffs = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const [x, y] = [i / (width - 1), j / (height - 1)];
      if (!worked(x, y)) continue;
      const [a, b] = colorAt(x, y);
      if (!makes(device, a, b, LOOK_MIN)) continue;
      let [lo, hi] = [LOOK_MIN, top];
      if (makes(device, a, b, hi)) lo = hi;
      else {
        for (let s = 0; s < STEPS; s++) {
          const mid = (lo + hi) / 2;
          if (makes(device, a, b, mid)) lo = mid;
          else hi = mid;
        }
      }
      cutoffs[j * width + i] = lo;
    }
  }
  return { width, height, cutoffs };
}

/** The tables packed (not yet gzipped): each kind of light's (in DEVICES' order), each table in turn, its values as 16 bits of its top, less their guesses, zigzagged, the high bytes then the low. */
export function pack(cutoffs: Cutoffs): Uint8Array<ArrayBuffer> {
  const tables = DEVICES.flatMap((d) => [cutoffs[d].wheel, cutoffs[d].strip].map((t) => ({ t, top: lookTopOf(d) })));
  const out = new Uint8Array(2 * tables.reduce((n, { t }) => n + t.cutoffs.length, 0));
  let at = 0;
  for (const { t, top } of tables) {
    const q = Uint16Array.from(t.cutoffs, (v) => Math.round(Math.min(1, Math.max(0, v / top)) * TOP));
    const n = q.length;
    for (let k = 0; k < n; k++) {
      // Less its guess, wrapped to 16 bits (unpacking wraps it back), then zigzagged: small either way, small.
      const d = ((q[k]! - guess(q, k, t.width) + 0x8000) & TOP) - 0x8000;
      const z = d >= 0 ? 2 * d : -2 * d - 1;
      out[at + k] = z >> 8;
      out[at + n + k] = z & 0xff;
    }
    at += 2 * n;
  }
  return out;
}

/** The tables, from what pack() made (unzipped); null if it isn't that. */
export function unpack(bytes: Uint8Array, sizes: Sizes = SIZES): Cutoffs | null {
  const [wn, sn] = [sizes.wheel[0] * sizes.wheel[1], sizes.strip[0] * sizes.strip[1]];
  if (bytes.length !== 2 * (wn + sn) * DEVICES.length) return null;
  const tableAt = (at: number, [width, height]: readonly [number, number], top: number): Table => {
    const n = width * height;
    const q = new Uint16Array(n);
    for (let k = 0; k < n; k++) {
      const z = (bytes[at + k]! << 8) | bytes[at + n + k]!;
      // Wrapping, as packing did.
      q[k] = guess(q, k, width) + (z & 1 ? -((z + 1) >> 1) : z >> 1);
    }
    return { width, height, cutoffs: Float32Array.from(q, (v) => (v / TOP) * top) };
  };
  const out = {} as Cutoffs;
  DEVICES.forEach((d, i) => {
    const at = 2 * (wn + sn) * i;
    out[d] = { wheel: tableAt(at, sizes.wheel, lookTopOf(d)), strip: tableAt(at + 2 * wn, sizes.strip, lookTopOf(d)) };
  });
  return out;
}

/** Value k's guess, from the ones before it: the median predictor, of the one to its left, the one above, and the one above that to the left. */
function guess(q: Uint16Array, k: number, width: number): number {
  const first = k % width === 0;
  const left = !first ? q[k - 1]! : k >= width ? q[k - width]! : 0;
  const up = k >= width ? q[k - width]! : left;
  const corner = !first && k >= width ? q[k - width - 1]! : left;
  if (corner >= Math.max(left, up)) return Math.min(left, up);
  if (corner <= Math.min(left, up)) return Math.max(left, up);
  return left + up - corner;
}

/** Gzipped bytes, unzipped. */
export async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
