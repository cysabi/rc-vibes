// Lemtone: device-independent light, as arclamp's color channels carry it.
// Walter's rc-bulb-firmware lemtone/ is canonical.
//
// A lemtone is a color as OKLab a and b at L = 1 (so color doesn't depend on
// brightness), a brightness where 1.0 is 1000 lm (a fixed unit, not any
// light's maximum), and a fidelity: 0 builds pale colors and whites from the
// RGB LEDs, 1 from the white ones. Each bulb solves this into its own PWM;
// this converts it for picking and display, and bulb.ts says what light a
// bulb actually makes of it.

export type Vec3 = [number, number, number];
export type XY = [number, number];

export interface Lemtone {
  a: number;
  b: number;
  brightness: number;
  fidelity: number;
}

/** What brightness 1.0 means (rclamp sink.LumensPerBrightness). */
export const LUMENS_PER_BRIGHTNESS = 1000;

const mul3 = (m: number[][], v: Vec3): Vec3 => [
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
  const [l, m, s] = mul3(XYZ_LMS, X).map(Math.cbrt) as Vec3;
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
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

const gamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** The RGB spaces swatches come in: sRGB, or Display P3 for screens that show it. Both use sRGB's gamma. */
export type Gamut = "srgb" | "display-p3";

// OKLab's LMS (cubed) -> linear RGB. sRGB's is Björn Ottosson's; P3's is that
// composed with sRGB -> XYZ -> Display P3 (CSS Color 4's matrices).
export const LMS_RGB: Record<Gamut, number[][]> = {
  srgb: [
    [4.0767416621, -3.3077115913, 0.2309699292],
    [-1.2684380046, 2.6097574011, -0.3413193965],
    [-0.0041960863, -0.7034186147, 1.707614701],
  ],
  "display-p3": [
    [3.1277689872, -2.2571357962, 0.129366809],
    [-1.0910090478, 2.4133317587, -0.3223227108],
    [-0.026010813, -0.5080413259, 1.5340521389],
  ],
};

/**
 * The brightest color (0–1 per channel, gamma-encoded, in `gamut`) with this
 * color's hue and chroma: what a light of this color looks like, ignoring
 * how bright it is. Colors beyond the gamut lose the part the screen can't
 * show; Display P3 keeps more of the saturated ones.
 */
export function swatch(a: number, b: number, gamut: Gamut = "srgb"): Vec3 {
  const rgb = linearOf(a, b, gamut);
  const top = Math.max(...rgb) || 1;
  return rgb.map((v) => gamma(v / top)) as Vec3;
}

/** OKLab (L = 1) -> LMS -> linear RGB, without what the gamut can't show. */
function linearOf(a: number, b: number, gamut: Gamut): Vec3 {
  const l = Math.pow(1 + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(1 - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(1 - 0.0894841775 * a - 1.291485548 * b, 3);
  return mul3(LMS_RGB[gamut], [l, m, s]).map((v) => Math.max(0, v)) as Vec3;
}

// How much each primary adds to luminance (Y).
const LUMA: Record<Gamut, Vec3> = {
  srgb: [0.2126729, 0.7151522, 0.072175],
  "display-p3": [0.2289746, 0.6917385, 0.0792869],
};

/**
 * Light of this color as linear RGB (in `gamut`) with a luminance of 1: one
 * lumen's worth of it, to add up with other light and scale by lumens.
 */
export function lightRgb(a: number, b: number, gamut: Gamut = "srgb"): Vec3 {
  const rgb = linearOf(a, b, gamut);
  const y = rgb[0] * LUMA[gamut][0] + rgb[1] * LUMA[gamut][1] + rgb[2] * LUMA[gamut][2] || 1;
  return rgb.map((v) => v / y) as Vec3;
}

/** A CSS color for gamma-encoded RGB (0–1) in `gamut`, optionally translucent. */
export function cssColor([r, g, b]: Vec3, gamut: Gamut = "srgb", alpha = 1): string {
  const a = alpha < 1 ? ` / ${+alpha.toFixed(3)}` : "";
  if (gamut === "display-p3") return `color(display-p3 ${+r.toFixed(4)} ${+g.toFixed(4)} ${+b.toFixed(4)}${a})`;
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)}${a})`;
}

/** How bright a light looks, 0–1: roughly perceptual (cube root of light output), with 1000 lm and up as full. */
export const lookOf = (brightness: number) => Math.min(1, Math.cbrt(Math.max(0, brightness)));

/** A CSS color for a lemtone as it looks: its swatch, dimmed by how bright it is. */
export function lemtoneCss(t: Lemtone | null, gamut: Gamut = "srgb"): string {
  if (!t) return "rgb(0 0 0)";
  const k = lookOf(t.brightness);
  return cssColor(swatch(t.a, t.b, gamut).map((v) => v * k) as Vec3, gamut);
}

/** Brightness in lumens, as people read it: "800 lm", "25 lm", "2.5 lm". */
export function lumensText(brightness: number): string {
  const lm = brightness * LUMENS_PER_BRIGHTNESS;
  return `${lm >= 9.95 || lm === 0 ? Math.round(lm) : lm.toFixed(1)} lm`;
}

/** The lemtone's name: a white by its color temperature, else its hue and chroma. */
export function colorName(a: number, b: number): string {
  const k = kelvinOf(a, b);
  if (k !== null) return `${Math.round(k / 50) * 50} K`;
  const { hue, chroma } = hueChroma(a, b);
  return `${Math.round(hue)}° C${chroma.toFixed(2)}`;
}

/** A short code for a lemtone, e.g. "2800 K · 800 lm · F1.00" or "29° C0.25 · 48 lm · F0.00". */
export function lemtoneCode(t: Lemtone): string {
  return `${colorName(t.a, t.b)} · ${lumensText(t.brightness)} · F${t.fidelity.toFixed(2)}`;
}
