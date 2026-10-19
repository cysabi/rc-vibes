// Lemtone: device-independent light, as arclamp's color channels carry it.
// Walter's rc-bulb-firmware lemtone/ is canonical.
//
// A lemtone is a color as OKLab a and b at L = 1 (so color doesn't depend on
// brightness), a brightness where 1.0 is 1000 lm (a fixed unit, not any
// light's maximum), and a fidelity: 0 builds pale colors and whites from the
// RGB LEDs, 1 from the white ones. Each bulb solves this into its own PWM.
//
// This is the color-space core: OKLab, whites by color temperature, and hue
// and chroma. Sketches use it through color.ts; vibes uses it too
// (src/shared/lemtone.ts), so a sketch, the picker and the map agree.

export type Vec3 = [number, number, number];
export type XY = [number, number];

/** What brightness 1.0 means (rclamp sink.LumensPerBrightness). */
export const LUMENS_PER_BRIGHTNESS = 1000;

export const mul3 = (m: number[][], v: Vec3): Vec3 => [
  m[0]![0]! * v[0] + m[0]![1]! * v[1] + m[0]![2]! * v[2],
  m[1]![0]! * v[0] + m[1]![1]! * v[1] + m[1]![2]! * v[2],
  m[2]![0]! * v[0] + m[2]![1]! * v[1] + m[2]![2]! * v[2],
];

// XYZ -> LMS and the LMS' -> OKLab step, as in Walter's Lemtone tool page
// (Björn Ottosson's OKLab).
const XYZ_LMS = [
  [0.8189330101, 0.3618667424, -0.1288597137],
  [0.0329845436, 0.9293118715, 0.0361456387],
  [0.0482003018, 0.2643662691, 0.633851707],
];

export function xyzToOklab(X: Vec3): Vec3 {
  return lmsToOklab(xyzToLms(X));
}

/** XYZ as OKLab's LMS (before the cube root). */
export const xyzToLms = (X: Vec3): Vec3 => mul3(XYZ_LMS, X);

function lmsToOklab(lms: Vec3): Vec3 {
  const [l, m, s] = lms.map(Math.cbrt) as Vec3;
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

// OKLab -> LMS' and LMS -> XYZ (Ottosson's inverses).
const LAB_LMS = [
  [1.0, 0.3963377774, 0.2158037573],
  [1.0, -0.1055613458, -0.0638541728],
  [1.0, -0.0894841775, -1.291485548],
];
const LMS_XYZ = [
  [1.2270138511, -0.5577999807, 0.281256149],
  [-0.0405801784, 1.1122568696, -0.0716766787],
  [-0.0763812845, -0.4214819784, 1.5861632204],
];

/** OKLab's LMS (before the cube root) as XYZ. */
export const lmsToXyz = (lms: Vec3): Vec3 => mul3(LMS_XYZ, lms);

/** An OKLab color (L, a, b) as XYZ. */
export function oklabToXyz(lab: Vec3): Vec3 {
  const [l, m, s] = mul3(LAB_LMS, lab);
  return lmsToXyz([l * l * l, m * m * m, s * s * s]);
}

/** A lemtone color's light as XYZ with Y = 1 (one lumen's worth, to add up), or null where there's no real color. */
export function abToXyz(a: number, b: number): Vec3 | null {
  const X = oklabToXyz([1, a, b]);
  if (!(X[1] > 1e-6)) return null;
  return [X[0] / X[1], 1, X[2] / X[1]];
}

/** Light's color as a lemtone's a and b (its brightness doesn't matter). */
export function xyzToAb(X: Vec3): [number, number] {
  const [L, a, b] = xyzToOklab(X);
  return L > 0 ? [a / L, b / L] : [0, 0];
}

const xyToXyz = ([x, y]: XY): Vec3 => [x / y, 1, (1 - x - y) / y];

/** A chromaticity's OKLab a, b at L = 1 (OKLab scales with XYZ's cube root, so each chromaticity is one direction). */
export function abOfXy(xy: XY): [number, number] {
  const [L, a, b] = xyzToOklab(xyToXyz(xy));
  return [a / L, b / L];
}

/** The Planckian locus (Kim et al. cubic spline, 1667–25000 K), as the tool page has it. */
export function cctToXy(kelvin: number): XY {
  const t = 1e3 / kelvin;
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    kelvin <= 4000
      ? -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t + 0.17991
      : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  const y =
    kelvin <= 2222
      ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
      : kelvin <= 4000
        ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

/** A white of this color temperature, as a and b. */
export const whiteAB = (kelvin: number): [number, number] => abOfXy(cctToXy(kelvin));

export const WHITE_K_MIN = 1700;
export const WHITE_K_MAX = 10000;
// How far from the Planckian locus (in a/b) a color still counts as a white.
const WHITE_TOLERANCE = 0.005;

/**
 * The color temperature of a white, or null for a color more than
 * `tolerance` (in a/b) from the Planckian locus. Infinity finds the nearest
 * white to any color.
 */
export function kelvinOf(a: number, b: number, tolerance = WHITE_TOLERANCE): number | null {
  const { mired, off } = nearestWhite(a, b);
  return off <= tolerance ? 1e6 / mired : null;
}

// The coarse pass's whites, every 2 mired across the range, worked out once.
let coarse: { m: number; a: number; b: number }[] | null = null;
// Nearest whites found already: the same few colors are named over and over as things render.
const nearest = new Map<string, { mired: number; off: number }>();

/** The nearest white to a color (in mired) and how far off it the color is (in a/b). */
function nearestWhite(a: number, b: number): { mired: number; off: number } {
  const key = `${a} ${b}`;
  const known = nearest.get(key);
  if (known) return known;
  if (nearest.size > 4096) nearest.clear();
  if (!coarse) {
    coarse = [];
    for (let m = 1e6 / WHITE_K_MAX; m <= 1e6 / WHITE_K_MIN; m += 2) {
      const [wa, wb] = whiteAB(1e6 / m);
      coarse.push({ m, a: wa, b: wb });
    }
  }
  // Coarse to fine, in mired: even steps in mired are even steps in look.
  let best = 0;
  let bestD = Infinity;
  for (const w of coarse) {
    const d = Math.hypot(w.a - a, w.b - b);
    if (d < bestD) {
      bestD = d;
      best = w.m;
    }
  }
  for (let m = best - 2; m <= best + 2; m += 0.02) {
    const [wa, wb] = whiteAB(1e6 / m);
    const d = Math.hypot(wa - a, wb - b);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  const found = { mired: best, off: bestD };
  nearest.set(key, found);
  return found;
}

/** Hue (degrees, 0–360) and chroma of a color: OKLCh at L = 1. */
export function hueChroma(a: number, b: number): { hue: number; chroma: number } {
  let hue = (Math.atan2(b, a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return { hue, chroma: Math.hypot(a, b) };
}

export function abOf(hue: number, chroma: number): [number, number] {
  const r = (hue * Math.PI) / 180;
  return [chroma * Math.cos(r), chroma * Math.sin(r)];
}
