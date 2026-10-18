// The color wheel's plane, for the editor's and the preview's: OKLCh at
// L = 1, hue going round and chroma going out from white, out to the most
// saturated color the bulbs make (their blue LED; at low brightness their
// colors reach well past the primaries' usual chroma). Chroma grows as the
// distance out to a power, so the pale colors near white, where most choices
// are, keep their room.

import { hueChroma } from "../shared/lemtone.ts";

/** The rim's chroma: just past the bulbs' blue LED (C0.947), the most saturated color they make. */
export const WHEEL_CHROMA = 0.96;
/** Chroma goes as the distance out (the rim at 1) to this power. */
export const CURVE = 1.6;

/** The chroma at a distance out (the rim at 1). */
export const chromaAt = (r: number) => WHEEL_CHROMA * Math.pow(Math.max(0, r), CURVE);

/** The distance out (the rim at 1) of a chroma; past the rim, more than 1. */
export const radiusOf = (chroma: number) => Math.pow(Math.max(0, chroma) / WHEEL_CHROMA, 1 / CURVE);

/** The color (a, b) at a place on the wheel: dx to the right, dy up, the rim at 1 (past it, more saturated still). */
export function wheelColor(dx: number, dy: number): [number, number] {
  const r = Math.hypot(dx, dy);
  if (r === 0) return [0, 0];
  const c = chromaAt(r);
  return [(dx / r) * c, (dy / r) * c];
}

/** Where a color is on the wheel (dx to the right, dy up), kept inside the rim. */
export function wheelSpot(a: number, b: number): { dx: number; dy: number } {
  const { hue, chroma } = hueChroma(a, b);
  const r = Math.min(1, radiusOf(chroma));
  const rad = (hue * Math.PI) / 180;
  return { dx: r * Math.cos(rad), dy: r * Math.sin(rad) };
}
