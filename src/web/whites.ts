// The color editor's strip of whites' plane (ColorField.tsx), and its
// backdrop's table's (cutoffs.ts): temperature going across, warm to cool,
// and a little tint up (pinker) and down (greener) of the black-body line.

import { hueChroma, kelvinOf, whiteAB } from "../shared/lemtone.ts";

// The strip of whites' ends.
export const K_MIN = 2000;
export const K_MAX = 6500;
// The strip of whites' tint, up (pinker) and down (greener) of the
// black-body line: this much (in OKLab a, b) at its edges, growing as the
// exponential of the height (this steeply). Most of the strip is all but on
// the line, so a cursor drifting a little still gives a white; the tint
// comes on fast toward the top and bottom, so the edges read as plainly
// pink and green (about Duv ±0.05, as far as a white goes: ColorPreview's
// TINT_MAX).
export const TINT = 0.1;
export const TINT_CURVE = 6;

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

// Tint's steps each way, from the line to the strip's edge: an arrow key's
// press each on the strip (ColorField's WhiteStrip moves 1 / TINT_STEPS of
// the way), and how tint is said ("+3 tint").
export const TINT_STEPS = 20;

const clampK = (k: number) => Math.min(K_MAX, Math.max(K_MIN, k));

/** Where a color is among the whites: the nearest temperature on the strip, and how far off the line. */
export function whiteSpot(a: number, b: number): { k: number; tint: number } {
  const k = clampK(kelvinOf(a, b, Infinity) ?? 3000);
  const [wa, wb] = whiteAB(k);
  const [na, nb] = across(k);
  return { k, tint: (a - wa) * na + (b - wb) * nb };
}

/** Whether a color is on the strip of whites: in its temperatures, its tint within it. */
export function isWhite(a: number, b: number): boolean {
  const k = kelvinOf(a, b, Infinity);
  if (k === null || k < K_MIN - 50 || k > K_MAX + 50) return false;
  return Math.abs(whiteSpot(a, b).tint) <= TINT + 1e-6;
}

/**
 * A color, said one way everywhere it's said: a white (on the strip of
 * whites) by its temperature, and any tint in steps up (pinker) or down
 * (greener) of the line ("3000K", "3000K (+2 tint)"); anything else by
 * its hue and chroma ("29° C0.25").
 */
export function toneText(a: number, b: number): string {
  if (!isWhite(a, b)) {
    const { hue, chroma } = hueChroma(a, b);
    return `${Math.round(hue) % 360}° C${chroma.toFixed(2)}`;
  }
  const { k, tint } = whiteSpot(a, b);
  const steps = Math.round(heightOf(tint) * TINT_STEPS);
  const t = steps === 0 ? "" : ` (${steps > 0 ? "+" : "-"}${Math.abs(steps)} tint)`;
  return `${Math.round(k / 50) * 50}K${t}`;
}
