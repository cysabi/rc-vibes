// Which lights reach each part of the floor, and exactly where each one's
// shadows fall, so the GPU can work out the light a pixel at a time
// (lighting-exact.ts) rather than drawing it light by light.
//
// A light's fan (the part of the floor it can see past the walls, from
// shadows.ts) is a polygon around it, its edges in order round it. A point
// is lit by it if it's on the light's side of the edge in the point's
// direction. To find that edge quickly, each fan's edges are filed by
// direction into BINS slices of the circle.
//
// The floor is cut into BUCKET_MM squares, and each square lists the lights
// that reach any of it: as wholly lit, or, where an edge of the light's fan
// crosses the square, as needing that test at each pixel. Shadows stay as
// sharp as the walls at any zoom, as nothing here is an image.
//
// Worked out once for each place a light hangs (cached on its fan, which
// RoomMap keeps for each spot), so moving one light only redoes that one.

import { REACH_MM, type Source } from "./lighting.ts";
import { crossesBox, type Grid } from "./shadows.ts";

/** The floor's squares, in millimeters. */
export const BUCKET_MM = 500;
/** How many slices of the circle each fan's edges are filed in. */
export const BINS = 256;
// An edge this close to a square (mm) counts as crossing it, so a pixel the
// GPU puts in the square next door, rounding, is never wrongly wholly lit.
const MARGIN_MM = 2;

/**
 * A direction as a number from 0 up to 4, growing with its angle (from +x
 * toward +y, as atan2's does): cheaper than the angle, which every pixel
 * would otherwise work out for every light. The bins are even slices of it.
 */
export function diamond(x: number, y: number): number {
  if (y >= 0) return x >= 0 ? (x + y > 0 ? y / (x + y) : 0) : 1 - x / (y - x);
  return x < 0 ? 2 - y / (-x - y) : 3 + x / (x - y);
}

const binOf = (d: number) => Math.min(BINS - 1, Math.max(0, Math.floor((d * BINS) / 4)));

/** One light's fan, filed for looking up by direction, and the squares it reaches. */
interface Filed {
  /** Each edge of the fan as x1, y1, x2, y2 from the light (mm), in order round it. */
  edges: Float32Array;
  /** For each bin: where its edges start in `list`, and how many. */
  bins: Int32Array;
  /** Edges (their index in `edges`), bin by bin. */
  list: Int32Array;
  /** The squares it lights (by floor(mm / BUCKET_MM) from the plan's origin), as column, row, and 1 if it lights only some of it. */
  squares: Int32Array;
}

const filed = new WeakMap<Float32Array, Filed>();

/**
 * Whether a light sees the point (dx, dy) mm from it: whether the point
 * is on the light's side of the fan's edge in its direction. The GPU does
 * the same (lighting-exact.ts).
 */
export function sees(f: Pick<Filed, "edges" | "bins" | "list">, dx: number, dy: number): boolean {
  const bin = binOf(diamond(dx, dy));
  const [first, count] = [f.bins[bin * 2]!, f.bins[bin * 2 + 1]!];
  for (let j = 0; j < count; j++) {
    const k = f.list[first + j]! * 4;
    const [ax, ay, bx, by] = [f.edges[k]!, f.edges[k + 1]!, f.edges[k + 2]!, f.edges[k + 3]!];
    if (ax * dy - ay * dx >= 0 && dx * by - dy * bx >= 0) {
      // On the same side of the edge as the light (which is at 0, 0).
      return ((bx - ax) * (dy - ay) - (by - ay) * (dx - ax)) * (ax * by - ay * bx) >= 0;
    }
  }
  return true;
}

/** A fan (as lighting.ts has them: the light, then its polygon, closed back on its first corner) filed by direction, and the squares it reaches. */
function file(fan: Float32Array): Filed {
  const cached = filed.get(fan);
  if (cached) return cached;
  const [ox, oy] = [fan[0]!, fan[1]!];
  const n = fan.length / 2 - 2;
  const edges = new Float32Array(Math.max(0, n) * 4);
  for (let k = 0; k < n; k++) {
    const [a, b] = [2 + k * 2, 2 + ((k + 1) % n) * 2];
    edges.set([fan[a]! - ox, fan[a + 1]! - oy, fan[b]! - ox, fan[b + 1]! - oy], k * 4);
  }

  // Each edge in every bin its directions fall in, and one either side,
  // for the GPU's rounding. The fan goes round counterclockwise, so an edge
  // whose end comes before its start crosses the +x axis, unless only by
  // rounding (an edge pointing straight out from the light).
  const perBin: number[][] = Array.from({ length: BINS }, () => []);
  for (let k = 0; k < n; k++) {
    const [s0, s1] = [diamond(edges[k * 4]!, edges[k * 4 + 1]!), diamond(edges[k * 4 + 2]!, edges[k * 4 + 3]!)];
    const wraps = s1 < s0 && s0 - s1 > 2;
    const [from, to] = s1 < s0 && !wraps ? [s1, s0] : [s0, s1];
    const last = binOf(to) + 1 + (wraps ? BINS : 0);
    for (let b = binOf(from) - 1; b <= last; b++) perBin[(b + BINS) % BINS]!.push(k);
  }
  const bins = new Int32Array(BINS * 2);
  const list: number[] = [];
  perBin.forEach((ks, b) => {
    bins[b * 2] = list.length;
    bins[b * 2 + 1] = ks.length;
    list.push(...ks);
  });
  const f = { edges, bins, list: Int32Array.from(list) };

  // The squares within reach of the light that its fan covers any of: those
  // an edge crosses need testing at each pixel; the rest are wholly lit, or
  // not at all, as their middle is.
  let [minX, minY, maxX, maxY] = [ox, oy, ox, oy];
  for (let i = 2; i < fan.length; i += 2) {
    [minX, maxX] = [Math.min(minX, fan[i]!), Math.max(maxX, fan[i]!)];
    [minY, maxY] = [Math.min(minY, fan[i + 1]!), Math.max(maxY, fan[i + 1]!)];
  }
  const sq = (v: number) => Math.floor(v / BUCKET_MM);
  const [i0, j0, i1, j1] = [sq(minX - MARGIN_MM), sq(minY - MARGIN_MM), sq(maxX + MARGIN_MM), sq(maxY + MARGIN_MM)];
  const w = i1 - i0 + 1;
  const crossed = new Uint8Array(w * (j1 - j0 + 1));
  for (let k = 0; k < n; k++) {
    const s = { x1: ox + edges[k * 4]!, y1: oy + edges[k * 4 + 1]!, x2: ox + edges[k * 4 + 2]!, y2: oy + edges[k * 4 + 3]! };
    for (let j = sq(Math.min(s.y1, s.y2) - MARGIN_MM); j <= sq(Math.max(s.y1, s.y2) + MARGIN_MM); j++) {
      for (let i = sq(Math.min(s.x1, s.x2) - MARGIN_MM); i <= sq(Math.max(s.x1, s.x2) + MARGIN_MM); i++) {
        const [x, y] = [i * BUCKET_MM, j * BUCKET_MM];
        if (crossesBox(s, x - MARGIN_MM, y - MARGIN_MM, x + BUCKET_MM + MARGIN_MM, y + BUCKET_MM + MARGIN_MM)) crossed[(j - j0) * w + (i - i0)] = 1;
      }
    }
  }
  const squares: number[] = [];
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const [x, y] = [i * BUCKET_MM, j * BUCKET_MM];
      const nx = Math.max(x, Math.min(ox, x + BUCKET_MM)) - ox;
      const ny = Math.max(y, Math.min(oy, y + BUCKET_MM)) - oy;
      if (nx * nx + ny * ny >= REACH_MM * REACH_MM) continue;
      if (crossed[(j - j0) * w + (i - i0)]) squares.push(i, j, 1);
      else if (sees(f, x + BUCKET_MM / 2 - ox, y + BUCKET_MM / 2 - oy)) squares.push(i, j, 0);
    }
  }
  const out = { ...f, squares: Int32Array.from(squares) };
  filed.set(fan, out);
  return out;
}

/** Every light's fan filed, and the squares, as lighting-exact.ts hands them to the GPU. */
export interface Pools {
  /** The squares, `width` × `height` of them from (x, y). */
  grid: Grid;
  /** Each square (row by row): where its lights start in `list`, and how many. */
  cells: Int32Array;
  /** Each light (its index in the sources) × 2, plus 1 if it lights only some of the square. */
  list: Int32Array;
  /** Every light's fan's edges, one after another, as x1, y1, x2, y2 from its light (mm). */
  edges: Float32Array;
  /** BINS for each light, light after light: where each bin's edges start in `binList`, and how many. */
  bins: Int32Array;
  /** Edges (their index in `edges`), bin by bin. */
  binList: Int32Array;
}

/** The lists for these lights, in the order given (each light's index is its place in `sources`). */
export function poolsOf(sources: Source[]): Pools {
  const all = sources.map((s) => file(s.fan));
  let [i0, j0, i1, j1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of all) {
    for (let k = 0; k < f.squares.length; k += 3) {
      [i0, i1] = [Math.min(i0, f.squares[k]!), Math.max(i1, f.squares[k]!)];
      [j0, j1] = [Math.min(j0, f.squares[k + 1]!), Math.max(j1, f.squares[k + 1]!)];
    }
  }
  if (i0 > i1) [i0, j0, i1, j1] = [0, 0, 0, 0];
  const [width, height] = [i1 - i0 + 1, j1 - j0 + 1];
  const grid: Grid = { x: i0 * BUCKET_MM, y: j0 * BUCKET_MM, cell: BUCKET_MM, width, height };

  // Count each square's lights, then lay the lists out one after another.
  const cells = new Int32Array(width * height * 2);
  for (const f of all) for (let k = 0; k < f.squares.length; k += 3) cells[((f.squares[k + 1]! - j0) * width + f.squares[k]! - i0) * 2 + 1]!++;
  let at = 0;
  for (let c = 0; c < width * height; c++) {
    cells[c * 2] = at;
    at += cells[c * 2 + 1]!;
  }
  const list = new Int32Array(at);
  const filled = new Int32Array(width * height);
  all.forEach((f, n) => {
    for (let k = 0; k < f.squares.length; k += 3) {
      const c = (f.squares[k + 1]! - j0) * width + f.squares[k]! - i0;
      list[cells[c * 2]! + filled[c]!++] = n * 2 + f.squares[k + 2]!;
    }
  });

  const edges = new Float32Array(all.reduce((t, f) => t + f.edges.length, 0));
  const bins = new Int32Array(all.length * BINS * 2);
  const binList = new Int32Array(all.reduce((t, f) => t + f.list.length, 0));
  let [edgeAt, listAt] = [0, 0];
  all.forEach((f, n) => {
    edges.set(f.edges, edgeAt * 4);
    for (let b = 0; b < BINS; b++) {
      bins[(n * BINS + b) * 2] = f.bins[b * 2]! + listAt;
      bins[(n * BINS + b) * 2 + 1] = f.bins[b * 2 + 1]!;
    }
    for (let k = 0; k < f.list.length; k++) binList[listAt + k] = f.list[k]! + edgeAt;
    edgeAt += f.edges.length / 4;
    listAt += f.list.length;
  });
  return { grid, cells, list, edges, bins, binList };
}
