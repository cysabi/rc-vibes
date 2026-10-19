// What a color bulb (br30) can make, from a table of vibes' model of it
// (gamut.table.ts), read between its points: within a few percent of the
// model, less sure right at the edge of what it makes, but never a color it
// can't make at all. color.ts gives this to sketches as `br30`.

import { hueChroma } from "./lemtone.ts";
import { EDGES, HUE_STEP, MOST_TENTHS, STEPS } from "./gamut.table.ts";

/** Where hue `hue` falls between the table's rows: the two rows, and how far from the first to the second. */
function rowsAt(hue: number): [number, number, number] {
  const x = (((hue % 360) + 360) % 360) / HUE_STEP;
  const i = Math.floor(x) % EDGES.length;
  return [i, (i + 1) % EDGES.length, x - Math.floor(x)];
}

/** The most chroma the bulb makes of this hue (degrees). */
export function edgeOf(hue: number): number {
  const [i, j, w] = rowsAt(hue);
  return EDGES[i]! + (EDGES[j]! - EDGES[i]!) * w;
}

/** The most lumens the bulb makes of the color a, b before it starts to pale it; 0 past its most saturated. */
export function maxLmOf(a: number, b: number): number {
  const { hue, chroma } = hueChroma(a, b);
  const [i, j, w] = rowsAt(hue);
  const f = (chroma / edgeOf(hue)) * STEPS;
  if (!(f <= STEPS)) return 0;
  const k = Math.min(Math.floor(f), STEPS - 1);
  const along = (row: readonly number[]) => row[k]! + (row[k + 1]! - row[k]!) * (f - k);
  const lo = along(MOST_TENTHS[i]!);
  return (lo + (along(MOST_TENTHS[j]!) - lo) * w) / 10;
}
