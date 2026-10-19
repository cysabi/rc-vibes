// Colors: lemtones, the light itself, with brightness in lumens.
//
// A Color is a hue and chroma (OKLab's a and b at full lightness: 0, 0 is
// white) and an amount of light in lumens. Lumens are absolute, the same on
// every light: 800 lm is a bright bulb, 20 lm a glow, whichever light it's
// on. Colors never change: read them with properties (c.lm, c.hue, c.hex),
// and change them with methods, each giving a new color (c.at(400),
// c.mix(other, 0.5)).
//
// Anywhere a color goes, anything that says one will do (a ColorInput): a
// Color; text (any CSS color, "2700K", "265° C0.30 · 40 lm"); a number, as a
// color temperature in kelvin; [r, g, b]; or an object ({ a, b, lm },
// { r, g, b }, { h, s, l }, { l, c, h }, { hue, chroma }, { kelvin },
// { x, y }, or arclamp's own channels). Screens' spaces count their white as
// 1000 lm (spaces.ts), so #0000ff is about 72 lm and rgb(1, 1, 1) 1000.

import { edgeOf, maxLmOf } from "./gamut.ts";
import {
  abOf,
  abOfXy,
  abToXyz,
  hueChroma,
  kelvinOf as kelvinOfAb,
  LUMENS_PER_BRIGHTNESS,
  oklabToXyz,
  whiteAB,
  xyzToAb,
  xyzToOklab,
  type Vec3,
} from "./lemtone.ts";
import { parseColor, type Spec } from "./parse.ts";
import { clamp, lerp } from "./shape.ts";
import {
  decode,
  encode,
  hslToSrgb,
  hwbToSrgb,
  labToXyz,
  linearP3ToXyz,
  linearSrgbToXyz,
  SCREEN_WHITE_LM,
  srgbToHsl,
  xyzD50ToXyz,
  xyzToLinearSrgb,
} from "./spaces.ts";

/** Anything that says a color: see the top of color.ts. */
export type ColorInput = Color | string | number | readonly number[] | { readonly [key: string]: unknown };

/** A color, given anywhere but as a number (which in a field is a number, not a color temperature). */
export type ColorLike = Exclude<ColorInput, number>;

/** What Color.with() changes: any of these, the rest kept. */
export interface ColorChanges {
  a?: number;
  b?: number;
  hue?: number;
  chroma?: number;
  kelvin?: number;
  lm?: number;
  lumens?: number;
  /** In arclamp's units: 1.0 is 1000 lm. */
  brightness?: number;
  fidelity?: number;
}

export class Color {
  /** OKLab's a at full lightness: green (−) to red (+). */
  readonly a: number;
  /** OKLab's b at full lightness: blue (−) to yellow (+). */
  readonly b: number;
  /** How much light, in lumens. */
  readonly lm: number;
  /** 0 builds pale colors and whites from the RGB LEDs, 1 from the white ones. */
  readonly fidelity: number;

  constructor(a: number, b: number, lm: number, fidelity = 1) {
    this.a = a;
    this.b = b;
    this.lm = lm;
    this.fidelity = fidelity;
  }

  /** Reads anything that says a color, as color() does. */
  static from(input: ColorInput, lm?: number): Color {
    return color(input, lm);
  }

  // ---- reading ----

  /** Its hue in degrees, 0–360 (OKLab's: about 30 red, 110 yellow, 145 green, 265 blue, 330 magenta). */
  get hue(): number {
    return hueChroma(this.a, this.b).hue;
  }

  /** How saturated: 0 is white, 0.1 pale, 0.3 strong. */
  get chroma(): number {
    return Math.hypot(this.a, this.b);
  }

  /** Its color temperature, if it's a white; null if it isn't. */
  get kelvin(): number | null {
    return kelvinOfAb(this.a, this.b);
  }

  /** The color temperature of the white nearest it, white or not. */
  get nearestKelvin(): number {
    return kelvinOfAb(this.a, this.b, Infinity)!;
  }

  /** How bright it looks, 0–1 (the cube root of its light; 1000 lm and up is 1). */
  get looks(): number {
    return Math.min(1, Math.cbrt(Math.max(0, this.lm) / SCREEN_WHITE_LM));
  }

  /** Its brightness in arclamp's units: 1.0 is 1000 lm. */
  get brightness(): number {
    return this.lm / LUMENS_PER_BRIGHTNESS;
  }

  /** As arclamp's channels for a color light. */
  get channels(): { a: number; b: number; brightness: number; fidelity: number } {
    return { a: this.a, b: this.b, brightness: this.brightness, fidelity: this.fidelity };
  }

  /** As CIE XYZ (D65), with Y = 1 for 1000 lm. */
  get xyz(): Vec3 {
    const unit = abToXyz(this.a, this.b);
    const k = Math.max(0, this.lm) / SCREEN_WHITE_LM;
    return unit ? [unit[0] * k, unit[1] * k, unit[2] * k] : [0, 0, 0];
  }

  /** Its CIE 1931 chromaticity. */
  get xy(): { x: number; y: number } {
    const [X, Y, Z] = abToXyz(this.a, this.b) ?? [0.9505, 1, 1.089];
    return { x: X / (X + Y + Z), y: Y / (X + Y + Z) };
  }

  /**
   * As sRGB, 0–1 per channel at 1000 lm of white (past 1 when brighter). What
   * a screen can't show of it (the bulbs' deepest blues, say) is left out.
   */
  get rgb(): { r: number; g: number; b: number } {
    const [r, g, b] = xyzToLinearSrgb(this.xyz).map((v) => encode(Math.max(0, v)));
    return { r: r!, g: g!, b: b! };
  }

  /** As a CSS hex code, "#rrggbb", clipped to what a screen shows. */
  get hex(): string {
    const { r, g, b } = this.rgb;
    return `#${[r, g, b].map((v) => Math.round(clamp(v) * 255).toString(16).padStart(2, "0")).join("")}`;
  }

  /** As HSL: hue in degrees, saturation and lightness 0–1 (clipped to what a screen shows). */
  get hsl(): { h: number; s: number; l: number } {
    const { r, g, b } = this.rgb;
    return srgbToHsl(clamp(r), clamp(g), clamp(b));
  }

  /** As OKLab (CSS's: L 0–1, at 1000 lm of white). */
  get oklab(): { l: number; a: number; b: number } {
    const [l, a, b] = xyzToOklab(this.xyz);
    return { l, a, b };
  }

  /** As OKLCh (CSS's: L 0–1 at 1000 lm of white, chroma, hue in degrees). */
  get oklch(): { l: number; c: number; h: number } {
    const { l, a, b } = this.oklab;
    return { l, c: Math.hypot(a, b), h: hueChroma(a, b).hue };
  }

  // ---- changing (each gives a new color) ----

  /** The same color at `lm` lumens. */
  at(lm: number): Color {
    return new Color(this.a, this.b, lm, this.fidelity);
  }

  /** k times the light: dim(0.5) is half the lumens, dim(2) twice. */
  dim(k: number): Color {
    return this.at(this.lm * k);
  }

  /** Looks k times as bright: fade(0.5) looks half as bright (an eighth of the lumens). */
  fade(k: number): Color {
    return this.at(this.lm * Math.max(0, k) ** 3);
  }

  /** With some of it changed: with({ fidelity: 0 }), with({ hue: 200 }), with({ kelvin: 3000 }). */
  with(changes: ColorChanges): Color {
    let { a, b } = this;
    if (changes.kelvin !== undefined) [a, b] = whiteAB(kelvinIn(changes.kelvin));
    if (changes.hue !== undefined || changes.chroma !== undefined) {
      const now = hueChroma(a, b);
      [a, b] = abOf(changes.hue ?? now.hue, changes.chroma ?? now.chroma);
    }
    a = changes.a ?? a;
    b = changes.b ?? b;
    const lm = changes.lm ?? changes.lumens ?? (changes.brightness !== undefined ? changes.brightness * LUMENS_PER_BRIGHTNESS : this.lm);
    return new Color(a, b, lm, changes.fidelity ?? this.fidelity);
  }

  /**
   * Toward `other` by t (0 is this, 1 is other; 0.5 if not given), evenly as
   * it looks: the color in a straight line through OKLab, brightness by its
   * cube root. To or from dark, only the brightness changes.
   */
  mix(other: ColorInput, t = 0.5): Color {
    const y = color(other);
    const k = clamp(t);
    if (k === 0) return this;
    if (k === 1) return y;
    const lm = lerp(Math.cbrt(this.lm), Math.cbrt(y.lm), k) ** 3;
    if (!(this.lm > 0)) return y.at(lm);
    if (!(y.lm > 0)) return this.at(lm);
    return new Color(lerp(this.a, y.a, k), lerp(this.b, y.b, k), lm, lerp(this.fidelity, y.fidelity, k));
  }

  /** This and others shining together: their light added up, as it would be on a wall. */
  add(...others: ColorInput[]): Color {
    const sum: Vec3 = [0, 0, 0];
    let fidelity = 0;
    for (const c of [this, ...others.map((o) => color(o))]) {
      if (!(c.lm > 0)) continue;
      const xyz = abToXyz(c.a, c.b);
      if (!xyz) continue;
      for (let i = 0; i < 3; i++) sum[i] += xyz[i]! * c.lm;
      fidelity += c.fidelity * c.lm;
    }
    if (!(sum[1] > 0)) return off;
    const [a, b] = xyzToAb(sum);
    return new Color(a, b, sum[1], fidelity / sum[1]);
  }

  /** The hue turned by `degrees`. */
  shiftHue(degrees: number): Color {
    return this.with({ hue: this.hue + degrees });
  }

  /** k times the chroma: 0 is white, 1 unchanged, 2 twice as saturated. */
  saturate(k: number): Color {
    return new Color(this.a * k, this.b * k, this.lm, this.fidelity);
  }

  /** Dimmed, if need be, to what a bulb makes of it (a color bulb, br30, unless told), so it isn't paled. */
  vivid(bulb: Bulb = br30): Color {
    return bulb.vivid(this);
  }

  /** Like "2700 K · 400 lm" or "265° C0.300 · 40 lm"; color() reads it back. */
  toString(): string {
    if (!(this.lm > 0)) return "off";
    const k = this.kelvin;
    const name = k !== null ? `${Math.round(k)} K` : `${+this.hue.toFixed(1)}° C${this.chroma.toFixed(3)}`;
    const f = this.fidelity !== 1 ? ` · F${this.fidelity.toFixed(2)}` : "";
    return `${name} · ${+this.lm.toFixed(2)} lm${f}`;
  }

  toJSON(): { a: number; b: number; lm: number; fidelity: number } {
    return { a: this.a, b: this.b, lm: this.lm, fidelity: this.fidelity };
  }
}

/** No light. */
export const off: Color = Object.freeze(new Color(0, 0, 0));

// An old bulb that's on, as a color: a 2700 K incandescent of about 800 lm.
const OLD_BULB = (() => {
  const [a, b] = whiteAB(2700);
  return Object.freeze(new Color(a, b, 800));
})();

// ---- making colors ----------------------------------------------------------------

/**
 * Anything that says a color, as a Color (see the top of color.ts), at `lm`
 * lumens if given. Throws, saying why, if it can't tell what color it is.
 */
export function color(input: ColorInput, lm?: number): Color {
  const c = read(input);
  return lm === undefined ? c : c.at(lm);
}

/**
 * A white of this color temperature (2700 K is a warm bulb, 4000 K neutral,
 * 6500 K daylight; the bulbs go as warm as about 1800 K, dimly), at `lm`
 * lumens (1000 if not given). With no temperature, OKLab's own white.
 */
export function white(kelvin?: number | string, lm = SCREEN_WHITE_LM): Color {
  if (kelvin === undefined) return new Color(0, 0, lm);
  const [a, b] = whiteAB(kelvinIn(typeof kelvin === "string" ? parseFloat(kelvin) : kelvin));
  return new Color(a, b, lm);
}

/**
 * A color in the lights' own terms: hue in degrees (OKLab's: about 30 red,
 * 110 yellow, 145 green, 265 blue, 330 magenta), chroma at full lightness (0
 * white, 0.1 pale, 0.3 strong, up to about 0.8 for the bulbs' violet), and
 * lumens (1000 if not given).
 */
export function lemtone(hue: number, chroma: number, lm = SCREEN_WHITE_LM, fidelity = 1): Color {
  const [a, b] = abOf(hue, chroma);
  return new Color(a, b, lm, fidelity);
}

/** CSS's oklch(): lightness 0–1 (past 1, a percentage), chroma, hue in degrees; L = 1 is 1000 lm of white. */
export function oklch(l: number, c: number, h: number, alpha = 1): Color {
  const r = (h * Math.PI) / 180;
  return fromXyz(oklabToXyz([unitOrPercent(l), c * Math.cos(r), c * Math.sin(r)])).dim(alpha);
}

/** CSS's oklab(): lightness 0–1 (past 1, a percentage), a, b; L = 1 is 1000 lm of white. */
export function oklab(l: number, a: number, b: number, alpha = 1): Color {
  return fromXyz(oklabToXyz([unitOrPercent(l), a, b])).dim(alpha);
}

/** sRGB, 0–1 per channel (0–255 if any is past 1), white at 1000 lm. */
export function rgb(r: number, g: number, b: number, alpha = 1): Color {
  const k = r > 1 || g > 1 || b > 1 ? 255 : 1;
  return fromSrgb([r / k, g / k, b / k]).dim(alpha);
}

/** HSL: hue in degrees, saturation and lightness 0–1 (past 1, percentages), white at 1000 lm. */
export function hsl(h: number, s: number, l: number, alpha = 1): Color {
  return fromSrgb(hslToSrgb(h, unitOrPercent(s), unitOrPercent(l))).dim(alpha);
}

/** A CSS hex code ("#f80", "#ff8800", "ff8800cc"), or anything else color() reads. */
export const hex = (code: string): Color => color(code);

/** A CIE 1931 chromaticity, at `lm` lumens (1000 if not given). */
export function xy(x: number, y: number, lm = SCREEN_WHITE_LM): Color {
  const [a, b] = abOfXy([x, y]);
  return new Color(a, b, lm);
}

// The Planckian spline's range (Kim et al.): warmer or cooler is held at its ends.
const kelvinIn = (k: number) => Math.min(25000, Math.max(1667, k));

const unitOrPercent = (v: number) => (Math.abs(v) > 1 ? v / 100 : v);

/** Light as XYZ (Y = 1 for 1000 lm), as a Color. */
function fromXyz(X: Vec3): Color {
  if (!(X[1] > 0)) return off;
  const [a, b] = xyzToAb(X);
  return new Color(a, b, X[1] * SCREEN_WHITE_LM);
}

const fromSrgb = (rgb: Vec3) => fromXyz(linearSrgbToXyz(rgb.map(decode) as Vec3));

function read(input: unknown): Color {
  if (input instanceof Color) return input;
  if (input === null || input === undefined || input === false) return off;
  if (typeof input === "string") {
    const spec = parseColor(input);
    if (!spec) {
      throw new Error(
        `"${input}" isn't a color I can read: try a CSS color ("#ff8800", "orange", "oklch(0.7 0.2 265)"), a color temperature ("2700K"), or "265° C0.3 · 40 lm"`,
      );
    }
    return fromSpec(spec);
  }
  if (typeof input === "number") return fromKelvin(input);
  if (Array.isArray(input)) return fromArray(input);
  if (typeof input === "object") return fromObject(input as Record<string, unknown>);
  throw new Error(`${String(input)} isn't a color`);
}

function fromKelvin(k: number): Color {
  if (!(k >= 500 && k <= 100000)) {
    throw new Error(`${k} isn't a color: a number is read as a color temperature in kelvin, like 2700 (a warm bulb) or 6500 (daylight)`);
  }
  return white(k);
}

function fromArray(list: readonly unknown[]): Color {
  if (list.length >= 3 && list.length <= 4 && list.every((v) => typeof v === "number")) {
    const [r, g, b, alpha = 1] = list as number[];
    return rgb(r!, g!, b!, alpha > 1 ? alpha / 255 : alpha);
  }
  throw new Error(`[${list.join(", ")}] isn't a color: as a list, give [r, g, b] (0–1, or 0–255)`);
}

function fromSpec(spec: Spec): Color {
  let c: Color;
  switch (spec.space) {
    case "off":
      c = off;
      break;
    case "srgb":
      c = fromSrgb(spec.rgb);
      break;
    case "srgb-linear":
      c = fromXyz(linearSrgbToXyz(spec.rgb));
      break;
    case "display-p3":
      c = fromXyz(linearP3ToXyz(spec.rgb.map(decode) as Vec3));
      break;
    case "xyz":
      c = fromXyz(spec.xyz);
      break;
    case "xyz-d50":
      c = fromXyz(xyzD50ToXyz(spec.xyz));
      break;
    case "hsl":
      c = fromSrgb(hslToSrgb(spec.h, spec.s, spec.l));
      break;
    case "hwb":
      c = fromSrgb(hwbToSrgb(spec.h, spec.w, spec.b));
      break;
    case "oklab":
      c = fromXyz(oklabToXyz(spec.lab));
      break;
    case "oklch": {
      const r = (spec.h * Math.PI) / 180;
      c = fromXyz(oklabToXyz([spec.l, spec.c * Math.cos(r), spec.c * Math.sin(r)]));
      break;
    }
    case "lab":
      c = fromXyz(labToXyz(...spec.lab));
      break;
    case "lch": {
      const r = (spec.h * Math.PI) / 180;
      c = fromXyz(labToXyz(spec.l, spec.c * Math.cos(r), spec.c * Math.sin(r)));
      break;
    }
    case "kelvin":
      c = white(spec.kelvin);
      break;
    case "lemtone":
      c = lemtone(spec.hue, spec.chroma);
      break;
  }
  if (spec.alpha !== undefined) c = c.dim(clamp(spec.alpha));
  if (spec.lm !== undefined) c = c.at(spec.lm);
  if (spec.fidelity !== undefined) c = c.with({ fidelity: spec.fidelity });
  return c;
}

/** The first of these an object has as a number (numbers given as text too). */
function numberIn(o: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const v = o[key];
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "boolean" ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function fromObject(o: Record<string, unknown>): Color {
  const n = (...keys: string[]) => numberIn(o, ...keys);
  const has = (...keys: string[]) => keys.every((k) => n(k) !== undefined);
  const alpha = (...keys: string[]) => {
    const v = n(...keys);
    return v === undefined ? 1 : v > 1 ? v / 255 : v;
  };

  let c: Color;
  if (has("on") && !has("a") && !has("r")) c = n("on")! >= 0.5 ? OLD_BULB : off;
  else if (has("r", "g", "b")) c = rgb(n("r")!, n("g")!, n("b")!, alpha("alpha", "a", "opacity"));
  else if (has("h", "s", "l")) c = hsl(n("h")!, n("s")!, n("l")!, alpha("alpha", "a", "opacity"));
  else if (has("h", "w", "b") && !has("a")) c = fromSrgb(hwbToSrgb(n("h")!, unitOrPercent(n("w")!), unitOrPercent(n("b")!)));
  else if (has("l", "c", "h")) c = oklch(n("l")!, n("c")!, n("h")!);
  else if (has("L", "C", "H")) c = oklch(n("L")!, n("C")!, n("H")!);
  else if (has("l", "a", "b")) c = oklab(n("l")!, n("a")!, n("b")!);
  else if (has("L", "a", "b")) c = oklab(n("L")!, n("a")!, n("b")!);
  else if (n("hue", "chroma") !== undefined) c = lemtone(n("hue") ?? 0, n("chroma") ?? 0);
  else if (n("kelvin", "k", "K", "cct") !== undefined) c = white(n("kelvin", "k", "K", "cct")!);
  else if (has("x", "y")) c = xy(n("x")!, n("y")!, n("Y") !== undefined ? n("Y")! * SCREEN_WHITE_LM : SCREEN_WHITE_LM);
  else if (has("a", "b") || n("lm", "lumens", "brightness") !== undefined) c = new Color(n("a") ?? 0, n("b") ?? 0, SCREEN_WHITE_LM);
  else throw new Error(`${JSON.stringify(o)} isn't a color I can read: give it { a, b, lm }, { r, g, b }, { h, s, l }, { l, c, h }, { hue, chroma }, { kelvin }, or { x, y }`);

  const lm = n("lm", "lumens", "lumen");
  const brightness = n("brightness");
  if (lm !== undefined) c = c.at(lm);
  else if (brightness !== undefined) c = c.at(brightness * LUMENS_PER_BRIGHTNESS);
  const fidelity = n("fidelity");
  if (fidelity !== undefined) c = c.with({ fidelity });
  return c;
}

// ---- palettes ---------------------------------------------------------------------

/** Colors along a line from 0 to 1: palette(x) is the color at x. */
export interface Palette {
  (x: number): Color;
  readonly stops: readonly Color[];
  /** Where each stop is, 0 to 1. */
  readonly positions: readonly number[];
}

/** A palette's stop: a color, or a color at a place, [0.3, "#f80"]. */
export type Stop = ColorInput | readonly [number, ColorInput];

const isPositioned = (s: unknown): s is readonly [number, ColorInput] => Array.isArray(s) && s.length === 2 && typeof s[0] === "number";
const isRgbList = (s: unknown) => Array.isArray(s) && s.length >= 3 && s.every((v) => typeof v === "number");

/** Whether v is a palette. */
export const isPalette = (v: unknown): v is Palette => typeof v === "function" && Array.isArray((v as Partial<Palette>).stops);

/**
 * A palette through these colors (evenly spaced from 0 to 1 unless placed,
 * [0.3, "#f80"]), mixed between them; outside 0–1 it holds the ends.
 * palette(a, b, c) and palette([a, b, c]) are the same.
 */
export function palette(...given: Stop[] | [readonly Stop[]]): Palette {
  const list: readonly Stop[] =
    given.length === 1 && Array.isArray(given[0]) && !isPositioned(given[0]) && !isRgbList(given[0]) ? (given[0] as readonly Stop[]) : (given as Stop[]);
  if (list.length === 0) throw new Error("palette(): give it at least one color");
  const placed = list
    .map((s, i) => (isPositioned(s) ? { at: clamp(s[0]), c: color(s[1]) } : { at: list.length > 1 ? i / (list.length - 1) : 0, c: color(s as ColorInput) }))
    .sort((x, y) => x.at - y.at);
  const stops = Object.freeze(placed.map((p) => Object.freeze(p.c)));
  const positions = Object.freeze(placed.map((p) => p.at));
  const at = (x: number): Color => {
    const v = Number.isFinite(x) ? x : 0;
    if (v <= positions[0]!) return stops[0]!;
    for (let i = 1; i < stops.length; i++) {
      if (v <= positions[i]!) {
        const span = positions[i]! - positions[i - 1]!;
        return span > 0 ? stops[i - 1]!.mix(stops[i]!, (v - positions[i - 1]!) / span) : stops[i]!;
      }
    }
    return stops[stops.length - 1]!;
  };
  return Object.assign(at, { stops, positions });
}

/** A palette from anything that says one: a palette, a list of stops, or one color (from dark at 0 to it at 1). */
export function toPalette(v: unknown): Palette {
  if (isPalette(v)) return v;
  if (Array.isArray(v) && !isRgbList(v)) return palette(v as Stop[]);
  return palette(off, v as ColorInput);
}

/** Palettes to start from, each dark to bright, within what the color bulbs make. */
export const palettes = {
  /** Deep violet, magenta, orange, warm white. */
  dusk: palette(lemtone(285, 0.3, 6), lemtone(330, 0.28, 30), lemtone(45, 0.2, 150), white(2700, 400)),
  /** Deep blue, teal, pale cyan, cool white. */
  sea: palette(lemtone(265, 0.35, 6), lemtone(220, 0.2, 40), lemtone(195, 0.12, 160), white(6500, 400)),
  /** Ember red, orange, firelight, warm white. */
  ember: palette(lemtone(30, 0.32, 4), lemtone(45, 0.28, 30), white(2000, 80), white(2700, 400)),
  /** Green, teal, violet: northern lights. */
  aurora: palette(lemtone(150, 0.25, 8), lemtone(165, 0.22, 60), lemtone(200, 0.15, 90), lemtone(300, 0.2, 40)),
};

// ---- what bulbs make ----------------------------------------------------------------

/** What a kind of light can make of each color. */
export interface Bulb {
  /** arclamp's name for it. */
  readonly type: string;
  /** The most lumens it makes of this color before it starts to pale it; 0 past its most saturated. */
  maxLm(c: ColorInput): number;
  /** The most chroma it makes of this hue. */
  edgeOf(hue: number): number;
  /** The color, dimmed if need be to what it makes, so it isn't paled; one more saturated than it makes at all, brought in to the most it does. */
  vivid(c: ColorInput): Color;
}

// vivid() keeps this far inside what the table says, for the few percent it can be over.
const MARGIN = 0.97;

/**
 * The color bulbs (br30), from vibes' model of Walter's solve: asked for more
 * than they can make of a color, they keep the lumens and pale it toward
 * white. A strong blue tops out near 30 lm; whites near 950 at 4000 K, 500 at
 * 2700 K.
 */
export const br30: Bulb = {
  type: "br30",
  maxLm: (c) => {
    const k = color(c);
    return maxLmOf(k.a, k.b);
  },
  edgeOf,
  vivid(input) {
    const c = color(input);
    const { hue, chroma } = hueChroma(c.a, c.b);
    const edge = edgeOf(hue) * 0.999;
    const made = chroma > edge ? c.with({ chroma: edge }) : c;
    const most = maxLmOf(made.a, made.b) * MARGIN;
    return made.lm > most ? made.at(most) : made;
  },
};
