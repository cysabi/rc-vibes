// The color spaces people know, to and from the light they stand for.
//
// They're all screens' spaces, so their brightness is relative to a screen's
// white. Here that white is a fixed amount of light, 1000 lm (lemtone's
// brightness 1.0), the same on every light: rgb(1, 1, 1) asks for 1000 lm,
// and a screen's full blue, #0000ff, for about 72, as dim next to white as on
// a screen. Everything goes through XYZ (D65, Y = 1 for that white), with the
// matrices CSS Color 4 uses.

import { lmsToXyz, mul3, xyzToLms, type Vec3 } from "./lemtone.ts";

/** The light a screen's white stands for, in lumens. */
export const SCREEN_WHITE_LM = 1000;

// Linear sRGB <-> OKLab's LMS (Björn Ottosson's), so sRGB and OKLab agree exactly.
const SRGB_LMS = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];
const LMS_SRGB = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];

export const linearSrgbToXyz = (rgb: Vec3): Vec3 => lmsToXyz(mul3(SRGB_LMS, rgb));
export const xyzToLinearSrgb = (X: Vec3): Vec3 => mul3(LMS_SRGB, xyzToLms(X));

/** sRGB's gamma, undone (extended past 0 and 1 the same way both sides, as CSS does). */
export function decode(v: number): number {
  const x = Math.abs(v);
  return Math.sign(v) * (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
}

/** sRGB's gamma. */
export function encode(v: number): number {
  const x = Math.abs(v);
  return Math.sign(v) * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
}

// Linear Display P3 -> XYZ (CSS Color 4).
const P3_XYZ = [
  [0.48657094864821626, 0.26566769316909294, 0.1982172852343625],
  [0.22897456406974884, 0.6917385218365062, 0.079286914093745],
  [0, 0.045113381858902575, 1.0439443689009757],
];
export const linearP3ToXyz = (rgb: Vec3): Vec3 => mul3(P3_XYZ, rgb);

// CIE Lab and LCh are relative to D50; back to D65 by Bradford (CSS Color 4).
const D50: Vec3 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
const D50_D65 = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];
export const xyzD50ToXyz = (X: Vec3): Vec3 => mul3(D50_D65, X);

/** CIE Lab (L 0–100) as XYZ (D65). */
export function labToXyz(L: number, a: number, b: number): Vec3 {
  const k = 24389 / 27;
  const e = 216 / 24389;
  const f1 = (L + 16) / 116;
  const f0 = a / 500 + f1;
  const f2 = f1 - b / 200;
  const x = f0 ** 3 > e ? f0 ** 3 : (116 * f0 - 16) / k;
  const y = L > k * e ? f1 ** 3 : L / k;
  const z = f2 ** 3 > e ? f2 ** 3 : (116 * f2 - 16) / k;
  return xyzD50ToXyz([x * D50[0], y, z * D50[2]]);
}

/** HSL (hue in degrees, saturation and lightness 0–1) as gamma-encoded sRGB (CSS Color 4). */
export function hslToSrgb(h: number, s: number, l: number): Vec3 {
  const hue = ((h % 360) + 360) % 360;
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** HWB (hue in degrees, whiteness and blackness 0–1) as gamma-encoded sRGB (CSS Color 4). */
export function hwbToSrgb(h: number, w: number, b: number): Vec3 {
  if (w + b >= 1) {
    const gray = w / (w + b);
    return [gray, gray, gray];
  }
  return hslToSrgb(h, 1, 0.5).map((v) => v * (1 - w - b) + w) as Vec3;
}

/** Gamma-encoded sRGB as HSL (CSS Color 4): hue in degrees (0 for grays), saturation and lightness 0–1. */
export function srgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l === 0 || l === 1 ? 0 : (max - l) / Math.min(l, 1 - l);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return { h, s, l };
}
