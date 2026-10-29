// Who else is here: each page open on the room (each room socket, once it's
// known who's on it) says which floor it's looking at and which lights it has
// selected (RoomRequest's presence), and vibes tells every page everyone's, as
// they change (RoomMessage's presence). Not part of the live state: it's each
// page's own, gone with its socket, and nothing to catch up on.
//
// Each person has a color, the same everywhere and on every page: a hue worked
// out from their id. Their avatar is ringed with it. On the map a selected
// light has one ring, whoever selected it: the light of everyone's colors
// added together (ringOf), yours a warm white. Just yours, it's the white
// ring it always was; just someone else's, their color; theirs and yours,
// their color washed out toward white; two people's, their colors mixed. A
// ring's never faded: what it is to you is in its line (web/selection.ts).

import type { Person } from "./vibes.ts";

/** One page open on the room. */
export interface Presence {
  /** This page's (its socket's), for as long as it's open. */
  id: string;
  person: Person;
  /** The floor it's looking at; null until it's said. */
  floor: number | null;
  /** The lights it has selected. */
  selected: number[];
}

/** The most lights a page says it has selected. */
export const MAX_PRESENCE_SELECTED = 4000;

/** A person's hue, 0–360, from their id (FNV-1a, so it's spread well even for ids alike but for a digit). */
export function hueOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // A final mix, so the last characters move the hue as much as the first.
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) % 360;
}

/** A color in sRGB, each channel 0–255. */
export type Rgb = [r: number, g: number, b: number];

// Everyone's color is this light and (as far as sRGB goes at their hue) this strong, in OKLCH: alike whatever the hue.
const LIGHTNESS = 0.78;
const CHROMA = 0.15;

/** An OKLCH color in sRGB, its chroma brought in until it's in sRGB at all. */
export function oklchToRgb(l: number, c: number, hue: number): Rgb {
  const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  for (let chroma = c; ; chroma -= 0.005) {
    const a = chroma * Math.cos((hue * Math.PI) / 180);
    const b = chroma * Math.sin((hue * Math.PI) / 180);
    const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const linear = [
      4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
      -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
      -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
    ];
    if (chroma <= 0 || linear.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) {
      return linear.map((v) => Math.round(255 * encode(Math.min(1, Math.max(0, v))))) as Rgb;
    }
  }
}

/** A person's color. */
export const rgbOf = (id: string): Rgb => oklchToRgb(LIGHTNESS, CHROMA, hueOf(id));

export const cssRgb = ([r, g, b]: Rgb, alpha = 1) => `rgb(${r} ${g} ${b}${alpha < 1 ? ` / ${alpha}` : ""})`;

/** A person's color, as CSS, with an alpha if given. */
export const colorOf = (id: string, alpha = 1): string => cssRgb(rgbOf(id), alpha);

/** Your own selection's ring: a warm white. */
export const MINE: Rgb = [255, 250, 242];

/**
 * A selected light's one ring's color: everyone's colors added together as
 * light is (red and green make yellow; a color and white, that color washed
 * out), brought back down to what a screen can show by its brightest
 * channel, so the mix keeps its hue rather than clipping to white. More
 * people make a different color, not a stronger ring. Null with no one.
 */
export function ringOf(colors: readonly Rgb[]): Rgb | null {
  if (colors.length === 0) return null;
  const sum = [0, 1, 2].map((i) => colors.reduce((t, c) => t + c[i]!, 0));
  const scale = Math.min(1, 255 / Math.max(...sum, 1));
  return sum.map((v) => Math.round(v * scale)) as Rgb;
}
