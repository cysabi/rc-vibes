// The floor plans of 397 Bridge Street. Both floors share one frame in
// real-world millimeters, with the origin at the building's top-left wall
// corner, matching the lights' coords ({ mm_x, mm_y, floor }).

import floor4 from "./floors/397-bridge-floor-4.svg?raw";
import floor5 from "./floors/397-bridge-floor-5.svg?raw";
import type { Point } from "../shared/rails.ts";
import { pocketsOf, wallsOf, type Segment } from "./shadows.ts";

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Floor {
  id: number;
  name: string;
  /** The plan, cleaned up for drawing under the lights. */
  svg: string;
  viewBox: { x: number; y: number; width: number; height: number };
  /** What stops light, in millimeters. */
  walls: Segment[];
}

// The accessible stalls' markings: a wheelchair figure (a group holding a
// head circle and one body path that starts like this), and the dashed 5 ft
// turning circle around it, the plans' only dashed circles.
const WHEELCHAIR_FIGURE = /<g transform="translate\([^)]*\)"><circle [^>]*\/><path d="M2 -7L0 1H-6L-12 10H-15[^"]*"[^>]*\/><\/g>/g;
const TURNING_CIRCLE = /<circle [^>]*stroke-dasharray="[^"]*"[^>]*\/>/g;
// Keep-clear markings: a circled cross (a circle and two lines, + or ×),
// after the dashed outline of the space it marks if there is one: the exit
// stair's landing, and outside the main stair's door. Markings, not rooms.
const KEEP_CLEAR = /(?:<polyline [^>]*stroke-dasharray="[^"]*"[^>]*\/>\s*)?<circle [^>]*\/>\s*<line [^>]*\/>\s*<line [^>]*\/>/g;
// The drinking fountain's clearance: a dashed rect drawn just before the
// fountain itself (its basin, then its drain).
const FOUNTAIN_CLEARANCE = /<rect [^>]*stroke-dasharray="[^"]*"[^>]*\/>(?=\s*<path [^>]*\/>\s*<circle [^>]*fill="#777")/g;
// The toilets: each a group of a bowl (a path that starts like this), its seat, tank and flush.
const TOILET = /<g transform="translate\([^)]*\)(?: scale\([^)]*\))?"><path d="M-2 -3 L-9 -5[^"]*"[^>]*\/>[\s\S]*?<\/g>/g;

// The stairs are drawn in the wall layers, but their steps, rails and arrows
// are only drawn on the floor: light crosses them. Everything inside these
// boxes (in drawing units: the main stair within its enclosure, the exit
// stair within its outline) is marked as a step (data-step), for shadows.ts
// to let light through and styles.css to leave unfilled.
const STAIRS = [
  { x0: 853.5, y0: 122.5, x1: 1016.5, y1: 192.5 },
  { x0: 1579.5, y0: 438.5, x1: 1636.5, y1: 549.5 },
];

// Screen pixels per unit of the drawing's own stroke widths (0.35 for glazing
// and fixtures up to 0.9 for walls), once lines are drawn the same weight at
// every zoom (vector-effect: non-scaling-stroke, in styles.css). The thinnest
// come out about one device pixel on a Retina screen.
const LINE_PX = 1.5;

/**
 * Drop what clutters a dim map (the reference grid, dimension lines, room
 * labels, the accessible stalls', keep-clear and fountain clearance markings, the toilets, and metadata), mark the stairs' steps, and drop the fixed print
 * size, so CSS can size the drawing, and give lines their widths in screen
 * pixels, keeping the drawing's heavier walls and lighter fixtures.
 */
export function preparePlan(svg: string): string {
  return svg
    .replace(/<metadata>[\s\S]*?<\/metadata>/, "")
    .replace(/<g[^>]*inkscape:label="(?:Reference grid|Dimensions|Room names and leaders)"[^>]*>[\s\S]*?<\/g>/g, "")
    .replace(WHEELCHAIR_FIGURE, "")
    .replace(TURNING_CIRCLE, "")
    .replace(KEEP_CLEAR, "")
    .replace(FOUNTAIN_CLEARANCE, "")
    .replace(TOILET, "")
    .replace(/<(line|rect|polygon|polyline)\b([^>]*?)(\/?)>/g, (tag, name: string, attrs: string, close: string) =>
      onStairs(name, attrs) ? `<${name} data-step=""${attrs}${close}>` : tag,
    )
    .replace(/<svg\b[^>]*>/, (tag) => tag.replace(/\s(?:width|height)="[^"]*"/g, ""))
    .replace(/stroke-width="([\d.]+)"/g, (_, w: string) => `stroke-width="${+(Number(w) * LINE_PX).toFixed(3)}"`);
}

/** Whether a drawn line or shape lies within one of the STAIRS. */
function onStairs(name: string, attrs: string): boolean {
  const num = (key: string) => Number(attrs.match(new RegExp(`\\s${key}="([^"]*)"`))?.[1] ?? NaN);
  let xs: number[];
  let ys: number[];
  if (name === "line") [xs, ys] = [[num("x1"), num("x2")], [num("y1"), num("y2")]];
  else if (name === "rect") [xs, ys] = [[num("x"), num("x") + num("width")], [num("y"), num("y") + num("height")]];
  else {
    const p = (attrs.match(/\spoints="([^"]*)"/)?.[1] ?? "").trim().split(/[\s,]+/).map(Number);
    [xs, ys] = [p.filter((_, i) => i % 2 === 0), p.filter((_, i) => i % 2 === 1)];
  }
  if (xs.length === 0 || [...xs, ...ys].some(Number.isNaN)) return false;
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return STAIRS.some((s) => x0 >= s.x0 - 0.5 && x1 <= s.x1 + 0.5 && y0 >= s.y0 - 0.5 && y1 <= s.y1 + 0.5);
}

export function viewBoxOf(svg: string): Floor["viewBox"] {
  const m = svg.match(/viewBox="([^"]+)"/);
  if (!m) throw new Error("floor plan has no viewBox");
  const [x, y, width, height] = m[1]!.trim().split(/[\s,]+/).map(Number) as [number, number, number, number];
  return { x, y, width, height };
}

// Closed-off strips between wall lines thinner than this are inside a wall.
const THIN_MM = 250;

const floor = (id: number, raw: string): Floor => {
  const svg = preparePlan(raw);
  const walls = wallsOf(svg);
  return { id, name: `Floor ${id}`, svg: withPockets(svg, pocketsOf(walls, THIN_MM)), viewBox: viewBoxOf(raw), walls };
};

/**
 * The insides of walls drawn as parallel lines (windows, partitions) filled
 * like the walls drawn as filled shapes, so they're as solid: one path, in
 * the plan's millimeters, under everything the plan draws.
 */
function withPockets(svg: string, pockets: Point[][]): string {
  if (pockets.length === 0) return svg;
  const d = pockets.map((p) => `M${p.map((q) => `${+q.x.toFixed(1)} ${+q.y.toFixed(1)}`).join("L")}Z`).join("");
  return svg.replace(/<g transform="matrix\(/, `<path d="${d}" fill="white" stroke-width="0"/>$&`);
}

/** Lowest floor first. */
export const FLOORS: Floor[] = [floor(4, floor4), floor(5, floor5)];

export function union(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

let extent: Bounds | null = null;

/**
 * Everything any floor's plan draws, in millimeters: measured once in the
 * page, then shared by every floor so switching floors never moves the
 * building on screen.
 */
export function planExtent(): Bounds {
  if (extent) return extent;
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden";
  document.body.appendChild(host);
  try {
    for (const f of FLOORS) {
      host.innerHTML = f.svg;
      const b = host.querySelector("svg")!.getBBox();
      const box = { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height };
      extent = extent ? union(extent, box) : box;
    }
  } finally {
    host.remove();
  }
  return extent!;
}
