// The screen, as the map and the pickers paint for it: its gamut (Display P3
// where the screen shows it, most Macs and iPhones and many recent phones,
// so saturated lemtones aren't cut down to sRGB; sRGB elsewhere), and
// whether the light on the map may go past white (HDR, where the screen and
// the browser both show it). Both follow the window from screen to screen,
// unless this browser's chosen otherwise (in the user menu).

import { useSyncExternalStore } from "react";
import type { Gamut } from "../shared/lemtone.ts";

/** A gamut, or whatever the screen shows. */
export type GamutChoice = "auto" | Gamut;

export interface Display {
  /** What to paint in. */
  gamut: Gamut;
  /** Whether the map's light goes past white. */
  hdr: boolean;
  /** What's chosen: a gamut, and HDR where it can be (or never). */
  gamutChoice: GamutChoice;
  hdrChoice: boolean;
  /** What the screen shows. */
  screen: { p3: boolean; hdr: boolean };
  /** Whether this browser draws past white on a canvas: null until the map's tried. */
  hdrCanvas: boolean | null;
}

const GAMUT_KEY = "vibes.gamut";
const HDR_KEY = "vibes.hdr";

const media = (query: string) => (typeof matchMedia === "function" ? matchMedia(query) : null);
const p3 = media("(color-gamut: p3)");
const high = media("(dynamic-range: high)");

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private window): the choice just won't persist.
  }
}

const saved = load(GAMUT_KEY);
let gamutChoice: GamutChoice = saved === "srgb" || saved === "display-p3" ? saved : "auto";
let hdrChoice = load(HDR_KEY) !== "off";
// Browsers draw past white only with WebGPU; without it, there's no trying.
let hdrCanvas: boolean | null = typeof navigator !== "undefined" && "gpu" in navigator ? null : false;

function compute(): Display {
  const screen = { p3: !!p3?.matches, hdr: !!high?.matches };
  return {
    gamut: gamutChoice === "auto" ? (screen.p3 ? "display-p3" : "srgb") : gamutChoice,
    hdr: hdrChoice && screen.hdr && hdrCanvas !== false,
    gamutChoice,
    hdrChoice,
    screen,
    hdrCanvas,
  };
}

let current = compute();
const listeners = new Set<() => void>();

function update() {
  current = compute();
  for (const l of listeners) l();
}

p3?.addEventListener("change", update);
high?.addEventListener("change", update);

/** Hear about changes; returns a function that stops. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The display as it is now, for code outside React. */
export const display = (): Display => current;
/** The gamut to paint in, for code outside React. */
export const screenGamut = (): Gamut => current.gamut;

export const useDisplay = (): Display => useSyncExternalStore(subscribe, display);
/** Just the gamut: what most painting needs, without re-rendering for the rest. */
export const useGamut = (): Gamut => useSyncExternalStore(subscribe, screenGamut);

export function setGamutChoice(choice: GamutChoice) {
  gamutChoice = choice;
  store(GAMUT_KEY, choice === "auto" ? null : choice);
  update();
}

export function setHdrChoice(on: boolean) {
  hdrChoice = on;
  store(HDR_KEY, on ? null : "off");
  update();
}

/** What the map found when it tried to draw past white. */
export function setHdrCanvas(works: boolean) {
  if (hdrCanvas === works) return;
  hdrCanvas = works;
  update();
}
