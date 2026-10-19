// Colors from text, read as generously as can be: anything CSS takes (hex
// codes with or without #, names, rgb(), hsl(), hwb(), oklch(), oklab(),
// lab(), lch(), color()), color temperatures ("2700K", "candlelight"), the
// lights' own ("lemtone(265 0.3 40)", or "265° C0.30 · 40 lm" as a color
// prints itself), and any of those with lumens or a fidelity alongside
// ("#f80 · 120 lm", "2700K @ 400lm").
//
// This only reads the text: what it says comes back as a Spec, and color.ts
// makes the color.

import type { Vec3 } from "./lemtone.ts";
import { cssNamed, LIGHT_NAMES } from "./names.ts";

/** What some text says a color is. */
export type Spec = { alpha?: number; lm?: number; fidelity?: number } & (
  | { space: "off" }
  | { space: "srgb" | "srgb-linear" | "display-p3"; rgb: Vec3 }
  | { space: "xyz" | "xyz-d50"; xyz: Vec3 }
  | { space: "hsl"; h: number; s: number; l: number }
  | { space: "hwb"; h: number; w: number; b: number }
  | { space: "oklab" | "lab"; lab: Vec3 }
  | { space: "oklch" | "lch"; l: number; c: number; h: number }
  | { space: "kelvin"; kelvin: number }
  | { space: "lemtone"; hue: number; chroma: number }
);

type Unit = "" | "%" | "deg" | "rad" | "grad" | "turn";
interface Token {
  value: number;
  unit: Unit;
}

const NUMBER = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(%|deg|rad|grad|turn)?$/;

function token(text: string): Token | null {
  if (text === "none") return { value: 0, unit: "" };
  const m = NUMBER.exec(text);
  return m ? { value: Number(m[1]), unit: (m[2] ?? "") as Unit } : null;
}

/** An angle in degrees. */
function angle(t: Token): number {
  if (t.unit === "rad") return (t.value * 180) / Math.PI;
  if (t.unit === "grad") return t.value * 0.9;
  if (t.unit === "turn") return t.value * 360;
  return t.value;
}

/** A number, with 100% as `hundred`. */
const scaled = (t: Token, hundred: number) => (t.unit === "%" ? (t.value / 100) * hundred : t.value);

/** A fraction 0–1, from a percentage, or a number: 0–1 as it is, past 1 read as a percentage (hsl(240, 100, 50)). */
const fraction = (t: Token) => (t.unit === "%" || Math.abs(t.value) > 1 ? t.value / 100 : t.value);

/** Lightness 0–1, from a percentage, or a number: 0–1 as it is, past 1 read as a percentage (oklch(70 0.2 265)). */
const lightness = fraction;

/** What `text` says a color is, or null if it can't be read. */
export function parseColor(text: string): Spec | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  const whole = one(s);
  if (whole) return whole;
  // A color, its lumens and its fidelity, in any order: "#f80 · 120 lm", "2700k @ 400lm", "2700k 400lm".
  const found: Found = {};
  for (const part of s.split(/\s*[·@]\s*/)) {
    if (!part || read(part, found)) continue;
    if (part.includes("(")) return null;
    // Word by word, a number with the unit after it first ("50 lumens", "fidelity 0.5").
    const words = part.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      if (i + 1 < words.length && read(`${words[i]} ${words[i + 1]}`, found)) i++;
      else if (!read(words[i]!, found)) return null;
    }
  }
  if (!found.spec) return null;
  if (found.lm !== undefined) found.spec.lm = found.lm;
  if (found.fidelity !== undefined) found.spec.fidelity = found.fidelity;
  return found.spec;
}

interface Found {
  spec?: Spec;
  lm?: number;
  fidelity?: number;
}

/** One part of a longer text, into `found`: lumens ("400 lm"), a fidelity ("F0.50"), or the color. */
function read(part: string, found: Found): boolean {
  let m: RegExpExecArray | null;
  if ((m = /^([-+]?(?:\d+\.?\d*|\.\d+))\s*(?:lm|lumens?)$/.exec(part))) {
    found.lm = Number(m[1]);
    return true;
  }
  // "f0.5" needs its point, so it isn't taken for a hex code like "f80".
  if ((m = /^(?:f(\d*\.\d+)|fidelity\s*[:=]?\s*(\d*\.?\d+))$/.exec(part))) {
    found.fidelity = Number(m[1] ?? m[2]);
    return true;
  }
  const c = one(part);
  if (!c || found.spec) return false;
  found.spec = c;
  return true;
}

/** One color, alone. */
function one(s: string): Spec | null {
  if (s === "off" || s === "none" || s === "dark" || s === "transparent") return { space: "off" };
  const name = cssNamed(s.replace(/[\s_-]/g, ""));
  if (name) return hex(name);
  const kelvin = LIGHT_NAMES[s.replace(/[\s_-]/g, "")];
  if (kelvin) return { space: "kelvin", kelvin };

  let m: RegExpExecArray | null;
  if ((m = /^(\d+(?:\.\d+)?)\s*(?:k|kelvin)$/.exec(s))) return { space: "kelvin", kelvin: Number(m[1]) };
  // As a color prints itself: "265° c0.300".
  if ((m = /^([-+]?\d+(?:\.\d+)?)\s*(?:°|deg)\s*c\s*(\d*\.?\d+)$/.exec(s))) return { space: "lemtone", hue: Number(m[1]), chroma: Number(m[2]) };
  if (/^#?(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s)) return hex(s.replace("#", ""));
  if ((m = /^([a-z][a-z0-9-]*)\((.*)\)$/.exec(s))) return fn(m[1]!, m[2]!);
  return null;
}

/** Hex digits (3, 4, 6 or 8 of them, the last as alpha) as sRGB. */
function hex(digits: string): Spec {
  const full = digits.length <= 4 ? [...digits].map((d) => d + d).join("") : digits;
  const at = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  const spec: Spec = { space: "srgb", rgb: [at(0), at(2), at(4)] };
  if (full.length === 8) spec.alpha = at(6);
  return spec;
}

/** A function: rgb(…), oklch(…), color(display-p3 …), lemtone(…), … */
function fn(name: string, inside: string): Spec | null {
  const [main = "", alphaText] = inside.split("/");
  const words = main.trim().split(/[\s,]+/).filter(Boolean);
  let space: string | undefined;
  if (name === "color") space = words.shift();
  const t = words.map(token);
  if (t.some((x) => x === null)) return null;
  const v = t as Token[];
  // Old-style rgba(1, 2, 3, 0.5): a fourth number is alpha.
  let alpha: number | undefined;
  if (alphaText !== undefined) {
    const a = token(alphaText.trim());
    if (!a) return null;
    alpha = scaled(a, 1);
  } else if (v.length === 4 && name !== "lemtone") alpha = scaled(v.pop()!, 1);

  const spec = make(name, space, v);
  if (spec && alpha !== undefined) spec.alpha = alpha;
  return spec;
}

function make(name: string, space: string | undefined, v: Token[]): Spec | null {
  const need = (n: number) => v.length >= n;
  switch (name) {
    case "rgb":
    case "rgba":
      if (!need(3)) return null;
      return { space: "srgb", rgb: [scaled(v[0]!, 255) / 255, scaled(v[1]!, 255) / 255, scaled(v[2]!, 255) / 255] };
    case "hsl":
    case "hsla":
      if (!need(3)) return null;
      return { space: "hsl", h: angle(v[0]!), s: fraction(v[1]!), l: fraction(v[2]!) };
    case "hwb":
      if (!need(3)) return null;
      return { space: "hwb", h: angle(v[0]!), w: fraction(v[1]!), b: fraction(v[2]!) };
    case "oklab":
      if (!need(3)) return null;
      return { space: "oklab", lab: [lightness(v[0]!), scaled(v[1]!, 0.4), scaled(v[2]!, 0.4)] };
    case "oklch":
      if (!need(3)) return null;
      return { space: "oklch", l: lightness(v[0]!), c: scaled(v[1]!, 0.4), h: angle(v[2]!) };
    case "lab":
      if (!need(3)) return null;
      return { space: "lab", lab: [scaled(v[0]!, 100), scaled(v[1]!, 125), scaled(v[2]!, 125)] };
    case "lch":
      if (!need(3)) return null;
      return { space: "lch", l: scaled(v[0]!, 100), c: scaled(v[1]!, 150), h: angle(v[2]!) };
    case "color": {
      if (!need(3)) return null;
      const c: Vec3 = [scaled(v[0]!, 1), scaled(v[1]!, 1), scaled(v[2]!, 1)];
      if (space === "srgb" || space === "srgb-linear" || space === "display-p3") return { space, rgb: c };
      if (space === "xyz" || space === "xyz-d65") return { space: "xyz", xyz: c };
      if (space === "xyz-d50") return { space: "xyz-d50", xyz: c };
      return null;
    }
    case "lemtone": {
      if (!need(2)) return null;
      const spec: Spec = { space: "lemtone", hue: angle(v[0]!), chroma: v[1]!.value };
      if (v[2]) spec.lm = v[2].value;
      if (v[3]) spec.fidelity = v[3].value;
      return spec;
    }
    case "white":
    case "kelvin": {
      if (!need(1)) return null;
      const spec: Spec = { space: "kelvin", kelvin: v[0]!.value };
      if (v[1]) spec.lm = v[1].value;
      return spec;
    }
    default:
      return null;
  }
}
