// The map's viewport: how millimeters on the plan land on screen pixels
// (screen = offset + mm × scale), how it moves (pinches, flicks, flights),
// plus the scale bar and grid that follow it.

import type { Bounds } from "./floors.ts";

export interface View {
  /** Screen pixels per millimeter. */
  scale: number;
  ox: number;
  oy: number;
}

/** Closest zoom: a 4 ft panel is about a meter across on screen. */
export const MAX_SCALE = 0.8;

/** Room to leave on each side, in screen pixels. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Fit bounds inside the space left once `pad` is taken off (the same on every side, or per side), centered in it. */
export function fitView(b: Bounds, width: number, height: number, pad: number | Insets): View {
  const p = typeof pad === "number" ? { top: pad, right: pad, bottom: pad, left: pad } : pad;
  const w = Math.max(b.maxX - b.minX, 1);
  const h = Math.max(b.maxY - b.minY, 1);
  const free = { width: Math.max(1, width - p.left - p.right), height: Math.max(1, height - p.top - p.bottom) };
  const scale = Math.min(free.width / w, free.height / h);
  return {
    scale,
    ox: p.left + (free.width - w * scale) / 2 - b.minX * scale,
    oy: p.top + (free.height - h * scale) / 2 - b.minY * scale,
  };
}

/** Zoom by `factor`, keeping the point under (px, py) fixed on screen. */
export function zoomAt(v: View, px: number, py: number, factor: number, min: number, max: number): View {
  const scale = Math.min(max, Math.max(min, v.scale * factor));
  const k = scale / v.scale;
  return { scale, ox: px - (px - v.ox) * k, oy: py - (py - v.oy) * k };
}

export const toPlan = (v: View, px: number, py: number) => ({ x: (px - v.ox) / v.scale, y: (py - v.oy) / v.scale });

/**
 * Past a zoom limit a pinch gives way less and less, like a rubber band:
 * only the cube root of the overshoot shows. It springs back on release.
 */
export function rubberBand(scale: number, min: number, max: number): number {
  if (scale > max) return max * Math.cbrt(scale / max);
  if (scale < min) return min * Math.cbrt(scale / min);
  return scale;
}

interface Spot {
  x: number;
  y: number;
}

/**
 * Two fingers that started `d0` apart around `c0` and are now `d1` apart
 * around `c1`: the plan under their midpoint stays under it, and the zoom
 * follows their spread.
 */
export function pinchView(start: View, c0: Spot, d0: number, c1: Spot, d1: number, min: number, max: number): View {
  const scale = rubberBand((start.scale * d1) / Math.max(d0, 1), min, max);
  const p = toPlan(start, c0.x, c0.y);
  return { scale, ox: c1.x - p.x * scale, oy: c1.y - p.y * scale };
}

/**
 * The view `t` (0–1) of the way from a to b. If the zoom changes, it zooms
 * around the one screen point both views agree on, so the move reads as a
 * single zoom rather than a pan and a zoom fighting; if not, it pans.
 */
export function between(a: View, b: View, t: number): View {
  const k = b.scale / a.scale;
  if (Math.abs(k - 1) < 1e-6) return { scale: b.scale, ox: a.ox + (b.ox - a.ox) * t, oy: a.oy + (b.oy - a.oy) * t };
  const px = (a.ox * k - b.ox) / (k - 1);
  const py = (a.oy * k - b.oy) / (k - 1);
  const s = Math.pow(k, t);
  return { scale: a.scale * s, ox: px - (px - a.ox) * s, oy: py - (py - a.oy) * s };
}

/** The view moving on its own: gliding after a flick, or flying to another view. */
export type Motion =
  | { kind: "glide"; from: View; vx: number; vy: number; start: number }
  | { kind: "fly"; from: View; to: View; start: number; ms: number };

// A glide slows like a flicked scroll view on iOS: its speed falls by a
// factor of e every GLIDE_MS, so it travels its starting speed × GLIDE_MS.
const GLIDE_MS = 325;
// Slower than this (pixels per millisecond) it's stopped.
const GLIDE_STOP = 0.01;

/** Where a motion has the view at `now` (ms, as performance.now()), and whether it's over. */
export function motionAt(m: Motion, now: number): { view: View; done: boolean } {
  const t = Math.max(0, now - m.start);
  if (m.kind === "fly") {
    const f = Math.min(1, t / m.ms);
    // Ease out: quick to answer, gentle to land.
    return { view: between(m.from, m.to, 1 - (1 - f) ** 3), done: f >= 1 };
  }
  const decay = Math.exp(-t / GLIDE_MS);
  const travel = GLIDE_MS * (1 - decay);
  return {
    view: { ...m.from, ox: m.from.ox + m.vx * travel, oy: m.from.oy + m.vy * travel },
    done: Math.hypot(m.vx, m.vy) * decay < GLIDE_STOP,
  };
}

export interface Sample {
  t: number;
  x: number;
  y: number;
}

// A flick is measured over its last FLICK_MS; a finger that rested longer
// than REST_MS before letting go wasn't flicking. Speeds in px/ms.
const FLICK_MS = 100;
const REST_MS = 50;
const MIN_FLICK = 0.2;
const MAX_FLICK = 8;

/** How fast a pan was going as it let go at `now`, in px/ms, or null if it wasn't really flicked. */
export function flickOf(trail: Sample[], now: number): { vx: number; vy: number } | null {
  const last = trail[trail.length - 1];
  if (!last || now - last.t > REST_MS) return null;
  const first = trail.find((s) => last.t - s.t <= FLICK_MS) ?? last;
  const dt = last.t - first.t;
  if (dt <= 0) return null;
  let vx = (last.x - first.x) / dt;
  let vy = (last.y - first.y) / dt;
  const speed = Math.hypot(vx, vy);
  if (speed < MIN_FLICK) return null;
  if (speed > MAX_FLICK) {
    vx *= MAX_FLICK / speed;
    vy *= MAX_FLICK / speed;
  }
  return { vx, vy };
}

/** What a wheel event carries that tells a trackpad from a mouse wheel. */
export interface WheelLike {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  shiftKey: boolean;
  /** Chrome's and Safari's legacy delta. */
  wheelDeltaY?: number;
}

/**
 * Whether a wheel event looks like a trackpad's two-finger scroll (which
 * pans the map, as on a Mac) rather than a mouse wheel's notches (which
 * zoom). There's no flag for it, so this reads the signs: a mouse wheel
 * scrolls by lines or in one direction only, and in Chrome and Safari only
 * a trackpad's legacy delta is exactly -3 × its delta.
 */
export function looksLikeTrackpad(e: WheelLike): boolean {
  if (e.deltaMode !== 0) return false;
  if (e.deltaX !== 0 && !e.shiftKey) return true;
  if (e.wheelDeltaY) return e.wheelDeltaY === -3 * e.deltaY;
  return Math.abs(e.deltaY) < 40;
}

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
