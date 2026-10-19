// Lemtone: device-independent light, as arclamp's color channels carry it.
// Walter's rc-bulb-firmware lemtone/ is canonical.
//
// A lemtone is a color as OKLab a and b at L = 1 (so color doesn't depend on
// brightness), a brightness where 1.0 is 1000 lm (a fixed unit, not any
// light's maximum), and a fidelity: 0 builds pale colors and whites from the
// RGB LEDs, 1 from the white ones. Each bulb solves this into its own PWM;
// this converts it for picking and display, and bulb.ts says what light a
// bulb actually makes of it. The color-space core (OKLab, whites, hue and
// chroma) is the sketch library's (packages/vibes), so sketches and vibes
// agree on every color.

import { hueChroma, kelvinOf, LUMENS_PER_BRIGHTNESS, mul3, xyzToLms, type Vec3 } from "../../packages/vibes/src/lemtone.ts";
import { decode, encode, linearSrgbToXyz } from "../../packages/vibes/src/spaces.ts";

export {
  abOf,
  abOfXy,
  cctToXy,
  hueChroma,
  kelvinOf,
  LUMENS_PER_BRIGHTNESS,
  whiteAB,
  WHITE_K_MAX,
  WHITE_K_MIN,
  xyzToOklab,
  type Vec3,
  type XY,
} from "../../packages/vibes/src/lemtone.ts";

export interface Lemtone {
  a: number;
  b: number;
  brightness: number;
  fidelity: number;
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

/** Gamma-encoded sRGB (0–1) as the same color, gamma-encoded, in `gamut`. */
export function fromSrgb(rgb: Vec3, gamut: Gamut): Vec3 {
  if (gamut === "srgb") return rgb;
  const lms = xyzToLms(linearSrgbToXyz(rgb.map(decode) as Vec3));
  return mul3(LMS_RGB[gamut], lms).map(encode) as Vec3;
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
