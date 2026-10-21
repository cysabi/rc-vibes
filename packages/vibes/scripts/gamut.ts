// Makes src/gamut.table.ts: what a color bulb (br30) makes of each color
// without paling it, from vibes' port of Walter's solve (src/shared/solver.ts)
// on the bulbs' calibration.
// Run it again if the bulb model changes:
//   node packages/vibes/scripts/gamut.ts
//
// Past the most saturated color a bulb makes of a hue (its edge), the most it
// makes drops from tens of lumens to nothing at once, so a plain grid read
// between its points blurs that cliff. So for every 2.5° of hue this keeps
// where the edge is, and the most lumens at even steps out to it.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SOLVERS } from "../../../src/shared/devices.ts";
import { abOf } from "../src/lemtone.ts";

const HUE_STEP = 2.5;
const STEPS = 20;
// A color the bulb can only make dimmer than this doesn't count as one it makes.
const LEAST_LM = 1;

const exact = (h: number, c: number, lm: number) => {
  const [a, b] = abOf(h, c);
  return SOLVERS.bulb.solve(a, b, lm, 1).mode === "exact";
};

/** The most lumens of hue h and chroma c the bulb makes exactly, by bisection (it's exact below that, not above). */
function maxLm(h: number, c: number): number {
  if (!exact(h, c, LEAST_LM)) return 0;
  let lo = LEAST_LM;
  let hi = 5000;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (exact(h, c, mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The most chroma of hue h the bulb makes. */
function edgeOf(h: number): number {
  let lo = 0;
  let hi = 1.5;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (exact(h, mid, LEAST_LM)) lo = mid;
    else hi = mid;
  }
  return lo;
}

const edges: number[] = [];
const rows: number[][] = [];
for (let i = 0; i * HUE_STEP < 360; i++) {
  const h = i * HUE_STEP;
  const edge = edgeOf(h);
  edges.push(Math.floor(edge * 1e5) / 1e5);
  // In tenths of a lumen, rounded down so it never promises more than the bulb makes.
  rows.push(Array.from({ length: STEPS + 1 }, (_, k) => Math.floor(maxLm(h, edge * Math.min(k / STEPS, 1 - 1e-6)) * 10)));
}

const out = `// Made by scripts/gamut.ts from vibes' bulb model (Walter's lemtone solve): don't edit.
// What a color bulb makes without paling a color: for every ${HUE_STEP}° of hue from 0,
// the most chroma it makes (EDGES), and the most lumens, in tenths, at ${STEPS}
// even steps from white out to that (MOST_TENTHS).

export const HUE_STEP = ${HUE_STEP};
export const STEPS = ${STEPS};

export const EDGES: readonly number[] = [${edges.join(", ")}];

export const MOST_TENTHS: readonly (readonly number[])[] = [
${rows.map((r) => `  [${r.join(", ")}],`).join("\n")}
];
`;

writeFileSync(fileURLToPath(new URL("../src/gamut.table.ts", import.meta.url)), out);
console.log(`wrote ${edges.length} hues`);
