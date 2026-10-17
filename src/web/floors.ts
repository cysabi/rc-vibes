// The floor plans of 397 Bridge Street. Both floors share one frame in
// real-world millimeters, with the origin at the building's top-left wall
// corner, matching the lights' coords ({ mm_x, mm_y, floor }).

import floor4 from "./floors/397-bridge-floor-4.svg?raw";
import floor5 from "./floors/397-bridge-floor-5.svg?raw";

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
}

// The accessible stalls' markings: a wheelchair figure (a group holding a
// head circle and one body path that starts like this), and the dashed 5 ft
// turning circle around it, the plans' only dashed circles.
const WHEELCHAIR_FIGURE = /<g transform="translate\([^)]*\)"><circle [^>]*\/><path d="M2 -7L0 1H-6L-12 10H-15[^"]*"[^>]*\/><\/g>/g;
const TURNING_CIRCLE = /<circle [^>]*stroke-dasharray="[^"]*"[^>]*\/>/g;

/**
 * Drop what clutters a dim map (the reference grid, dimension lines, room
 * labels, the accessible stalls' markings and metadata) and the fixed print
 * size, so CSS can size the drawing.
 */
export function preparePlan(svg: string): string {
  return svg
    .replace(/<metadata>[\s\S]*?<\/metadata>/, "")
    .replace(/<g[^>]*inkscape:label="(?:Reference grid|Dimensions|Room names and leaders)"[^>]*>[\s\S]*?<\/g>/g, "")
    .replace(WHEELCHAIR_FIGURE, "")
    .replace(TURNING_CIRCLE, "")
    .replace(/<svg\b[^>]*>/, (tag) => tag.replace(/\s(?:width|height)="[^"]*"/g, ""));
}

export function viewBoxOf(svg: string): Floor["viewBox"] {
  const m = svg.match(/viewBox="([^"]+)"/);
  if (!m) throw new Error("floor plan has no viewBox");
  const [x, y, width, height] = m[1]!.trim().split(/[\s,]+/).map(Number) as [number, number, number, number];
  return { x, y, width, height };
}

const floor = (id: number, raw: string): Floor => ({ id, name: `Floor ${id}`, svg: preparePlan(raw), viewBox: viewBoxOf(raw) });

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
