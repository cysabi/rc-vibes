// The map's viewport: how millimeters on the plan land on screen pixels
// (screen = offset + mm × scale), plus the scale bar and grid that follow it.

import type { Bounds } from "./floors.ts";

export interface View {
  /** Screen pixels per millimeter. */
  scale: number;
  ox: number;
  oy: number;
}

/** Closest zoom: a 4 ft panel is about a meter across on screen. */
export const MAX_SCALE = 0.8;

export function fitView(b: Bounds, width: number, height: number, pad: number): View {
  const w = Math.max(b.maxX - b.minX, 1);
  const h = Math.max(b.maxY - b.minY, 1);
  const scale = Math.min((width - pad * 2) / w, (height - pad * 2) / h);
  return { scale, ox: (width - w * scale) / 2 - b.minX * scale, oy: (height - h * scale) / 2 - b.minY * scale };
}

/** Zoom by `factor`, keeping the point under (px, py) fixed on screen. */
export function zoomAt(v: View, px: number, py: number, factor: number, min: number, max: number): View {
  const scale = Math.min(max, Math.max(min, v.scale * factor));
  const k = scale / v.scale;
  return { scale, ox: px - (px - v.ox) * k, oy: py - (py - v.oy) * k };
}

export const toPlan = (v: View, px: number, py: number) => ({ x: (px - v.ox) / v.scale, y: (py - v.oy) / v.scale });

const METRIC_MM = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000];
const IMPERIAL_IN = [1, 2, 6, 12, 24, 60, 120, 240, 600, 1200];
const INCH = 25.4;

/** The longest round lengths (metric and imperial) that fit in `maxPx` at this scale. */
export function scaleBar(scale: number, maxPx: number) {
  const pick = <T>(list: T[], mm: (t: T) => number) => [...list].reverse().find((t) => mm(t) * scale <= maxPx) ?? list[0]!;
  const metric = pick(METRIC_MM, (mm) => mm);
  const inches = pick(IMPERIAL_IN, (n) => n * INCH);
  return {
    metric: { px: metric * scale, label: metric < 1000 ? `${metric / 10} cm` : `${metric / 1000} m` },
    imperial: { px: inches * INCH * scale, label: inches < 12 ? `${inches} in` : `${inches / 12} ft` },
  };
}

/** A measured length, both ways: "6.40 m · 21′ 0″". */
export function formatLength(mm: number): string {
  const metric = mm < 1000 ? `${Math.round(mm / 10)} cm` : `${(mm / 1000).toFixed(2)} m`;
  const inches = Math.round(mm / INCH);
  return `${metric} · ${Math.floor(inches / 12)}′ ${inches % 12}″`;
}

const GRID_MM = [100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000];
const MIN_GRID_PX = 14;

/**
 * Grid spacing for this zoom: minor lines at the finest round step at least
 * MIN_GRID_PX apart (fading in as they open up), major lines at five or ten
 * of them.
 */
export function gridFor(scale: number) {
  const minor = GRID_MM.find((mm) => mm * scale >= MIN_GRID_PX) ?? GRID_MM[GRID_MM.length - 1]!;
  const major = GRID_MM.find((mm) => mm >= minor * 5 && mm % minor === 0) ?? minor * 5;
  const minorAlpha = Math.min(1, Math.max(0, (minor * scale - MIN_GRID_PX) / 24));
  return { minor, major, minorAlpha };
}
