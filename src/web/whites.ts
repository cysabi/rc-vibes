// The color editor's strip of whites' plane (ColorEditor.tsx), and its
// backdrop's table's (cutoffs.ts): temperature going across, warm to cool,
// and a little tint up (pinker) and down (greener) of the black-body line.

import { whiteAB } from "../shared/lemtone.ts";

// The strip of whites' ends.
export const K_MIN = 2000;
export const K_MAX = 6500;
// The strip of whites' tint, up (pinker) and down (greener) of the
// black-body line: this much (in OKLab a, b) at its edges, growing as the
// exponential of the height (this steeply). Most of the strip is all but on
// the line, so a cursor drifting a little still gives a white.
export const TINT = 0.05;
export const TINT_CURVE = 4;

/** The tint at a height on the strip of whites, from -1 (bottom) through 0 (the line) to 1 (top). */
export function tintAt(h: number): number {
  const m = Math.min(1, Math.abs(h));
  return (Math.sign(h) * TINT * (Math.exp(TINT_CURVE * m) - 1)) / (Math.exp(TINT_CURVE) - 1);
}

/** The height on the strip for a tint (the other way from tintAt). */
export function heightOf(tint: number): number {
  return (Math.sign(tint) * Math.log(1 + Math.min(1, Math.abs(tint) / TINT) * (Math.exp(TINT_CURVE) - 1))) / TINT_CURVE;
}

/** The direction across the black-body line at `kelvin`, toward pinker, in OKLab a, b. */
export function across(kelvin: number): [number, number] {
  const [a0, b0] = whiteAB(kelvin - 20);
  const [a1, b1] = whiteAB(kelvin + 20);
  const len = Math.hypot(a1 - a0, b1 - b0) || 1;
  return [-(b1 - b0) / len, (a1 - a0) / len];
}

/** The white at `kelvin`, `tint` off the line. */
export function whiteAt(kelvin: number, tint: number): [number, number] {
  const [a, b] = whiteAB(kelvin);
  if (tint === 0) return [a, b];
  const [na, nb] = across(kelvin);
  return [a + na * tint, b + nb * tint];
}

/** The color at a place on the strip (fractions across and down), unrounded. */
export const whitesColor = (x: number, y: number): [number, number] => whiteAt(K_MIN + x * (K_MAX - K_MIN), tintAt(1 - 2 * y));
