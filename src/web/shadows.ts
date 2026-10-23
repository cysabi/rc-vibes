// What stops light on the plan, seen from above: the walls (read from the
// floor plans), and the part of the floor each light can see past them.

import type { Point } from "../shared/rails.ts";

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// The plan groups that stand floor to ceiling and stop light. Doors are left
// out, as if open; so are fixtures well below the lights (the kitchenette's
// counters, and the toilets and sinks drawn as symbols in groups of their own).
const WALL_GROUPS = new Set([
  "Exterior walls and glazing",
  "Core partitions",
  "Office partitions",
  "Structural columns",
  "Elevators and main stair",
  "Exit stair and landing",
  "Bathroom fixtures and partitions",
]);
const SYMBOL = "\0symbol";

const attr = (attrs: string, name: string) => attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1];
const num = (attrs: string, name: string) => Number(attr(attrs, name) ?? 0);
const numbers = (s: string) => s.trim().split(/[\s,]+/).map(Number);

/**
 * Every wall on a floor plan as line segments, in the plan's millimeters.
 * Walls are drawn as lines, rects, polygons and polylines inside the root
 * group's transform (drawing units to millimeters). White strokes are only
 * breaks drawn over other lines, dashed ones aren't solid (thresholds,
 * clearances, the crosses marking elevator shafts), and the stairs' steps
 * (marked data-step; see floors.ts) are drawn on the floor, so all three
 * are skipped.
 * Where walls meet they overlap, so they're split where they cross (see
 * splitAtCrossings).
 */
export function wallsOf(svg: string): Segment[] {
  const root = svg.match(/<g transform="matrix\(([^)]+)\)"/);
  const [a, b, c, d, e, f] = root ? numbers(root[1]!) : [1, 0, 0, 1, 0, 0];
  const at = (x: number, y: number): Point => ({ x: a! * x + c! * y + e!, y: b! * x + d! * y + f! });
  const out: Segment[] = [];
  const outline = (pts: Point[], closed: boolean) => {
    for (let i = 0; i + 1 < pts.length; i++) out.push(segment(pts[i]!, pts[i + 1]!));
    if (closed && pts.length > 2) out.push(segment(pts[pts.length - 1]!, pts[0]!));
  };

  // Each open group's label, or SYMBOL for a transformed group inside the root.
  const groups: string[] = [];
  for (const m of svg.matchAll(/<(\/?)(g|line|rect|polygon|polyline)\b([^>]*?)\/?>/g)) {
    const [, close, tag, attrs = ""] = m;
    if (tag === "g") {
      if (close) groups.pop();
      else groups.push(attr(attrs, "inkscape:label") ?? (groups.length > 0 && /\btransform=/.test(attrs) ? SYMBOL : ""));
      continue;
    }
    if (close || groups.includes(SYMBOL) || !groups.some((g) => WALL_GROUPS.has(g))) continue;
    if (attr(attrs, "stroke") === "white" || attr(attrs, "stroke-dasharray") || attr(attrs, "data-step") !== undefined) continue;
    if (tag === "line") outline([at(num(attrs, "x1"), num(attrs, "y1")), at(num(attrs, "x2"), num(attrs, "y2"))], false);
    else if (tag === "rect") {
      const [x, y, w, h] = [num(attrs, "x"), num(attrs, "y"), num(attrs, "width"), num(attrs, "height")];
      outline([at(x, y), at(x + w, y), at(x + w, y + h), at(x, y + h)], true);
    } else {
      const p = numbers(attr(attrs, "points") ?? "");
      const pts: Point[] = [];
      for (let i = 0; i + 1 < p.length; i += 2) pts.push(at(p[i]!, p[i + 1]!));
      outline(pts, tag === "polygon");
    }
  }
  return splitAtCrossings(out.filter((s) => s.x1 !== s.x2 || s.y1 !== s.y2));
}

const segment = (p: Point, q: Point): Segment => ({ x1: p.x, y1: p.y, x2: q.x, y2: q.y });

/**
 * Walls split wherever another crosses them. The plans draw walls as rects
 * that overlap where they meet, so the corner of a room is often where two
 * wall faces cross partway along, not where either ends; visibility() only
 * looks at ends, so without this it would cut those corners off.
 */
export function splitAtCrossings(walls: Segment[]): Segment[] {
  const cuts = walls.map(() => [0, 1]);
  for (let i = 0; i < walls.length; i++) {
    const a = walls[i]!;
    for (let j = i + 1; j < walls.length; j++) {
      const b = walls[j]!;
      if (
        Math.max(a.x1, a.x2) < Math.min(b.x1, b.x2) ||
        Math.max(b.x1, b.x2) < Math.min(a.x1, a.x2) ||
        Math.max(a.y1, a.y2) < Math.min(b.y1, b.y2) ||
        Math.max(b.y1, b.y2) < Math.min(a.y1, a.y2)
      ) {
        continue;
      }
      const [ax, ay, bx, by] = [a.x2 - a.x1, a.y2 - a.y1, b.x2 - b.x1, b.y2 - b.y1];
      const denom = ax * by - ay * bx;
      if (Math.abs(denom) < 1e-9) continue;
      const t = ((b.x1 - a.x1) * by - (b.y1 - a.y1) * bx) / denom;
      const u = ((b.x1 - a.x1) * ay - (b.y1 - a.y1) * ax) / denom;
      if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) continue;
      if (t > 1e-6 && t < 1 - 1e-6) cuts[i]!.push(t);
      if (u > 1e-6 && u < 1 - 1e-6) cuts[j]!.push(u);
    }
  }
  const out: Segment[] = [];
  walls.forEach((s, i) => {
    const ts = cuts[i]!.sort((p, q) => p - q);
    const at = (t: number): Point => ({ x: s.x1 + (s.x2 - s.x1) * t, y: s.y1 + (s.y2 - s.y1) * t });
    for (let k = 0; k + 1 < ts.length; k++) {
      const [p, q] = [at(ts[k]!), at(ts[k + 1]!)];
      if (Math.hypot(q.x - p.x, q.y - p.y) > 0.5) out.push(segment(p, q));
    }
  });
  return out;
}

/**
 * The walls sorted into the cells of `grid` that they come within `reach` of,
 * so whatever's looking for the walls near a point (the GPU, every pixel)
 * only has a few to check: for each cell, row by row, where its walls start
 * in `list` and how many there are (as pairs in `cells`). Cells run from
 * (x, y), `cell` mm square.
 */
export function bucketsOf(walls: Segment[], grid: Grid, reach: number): { cells: Int32Array; list: Int32Array } {
  const { x, y, cell, width: w, height: h } = grid;
  const buckets: number[][] = Array.from({ length: w * h }, () => []);
  const index = (v: number, origin: number, count: number) => Math.min(count - 1, Math.max(0, Math.floor((v - origin) / cell)));
  walls.forEach((s, n) => {
    const [i0, i1] = [index(Math.min(s.x1, s.x2) - reach, x, w), index(Math.max(s.x1, s.x2) + reach, x, w)];
    const [j0, j1] = [index(Math.min(s.y1, s.y2) - reach, y, h), index(Math.max(s.y1, s.y2) + reach, y, h)];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const [bx, by] = [x + i * cell, y + j * cell];
        if (crossesBox(s, bx - reach, by - reach, bx + cell + reach, by + cell + reach)) buckets[j * w + i]!.push(n);
      }
    }
  });
  const cells = new Int32Array(w * h * 2);
  const list: number[] = [];
  buckets.forEach((b, k) => {
    cells[k * 2] = list.length;
    cells[k * 2 + 1] = b.length;
    list.push(...b);
  });
  return { cells, list: Int32Array.from(list) };
}

/** Whether any of `s` is inside the box (Liang–Barsky clipping). */
export function crossesBox(s: Segment, x0: number, y0: number, x1: number, y1: number): boolean {
  let [lo, hi] = [0, 1];
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  for (const [p, q] of [
    [-dx, s.x1 - x0],
    [dx, x1 - s.x1],
    [-dy, s.y1 - y0],
    [dy, y1 - s.y1],
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
    } else if (p < 0) lo = Math.max(lo, q / p);
    else hi = Math.min(hi, q / p);
    if (lo > hi) return false;
  }
  return true;
}

/**
 * The closed-off pockets between walls too thin to be any part of a room,
 * as polygons in millimeters: the insides of walls drawn as parallel lines
 * rather than filled shapes (windows, stall partitions), which should be as
 * solid as the rest. Found exactly: the walls, split where they cross, are a
 * planar graph, and each pocket is one of its faces, thinner than `thin`
 * (twice its area over its perimeter: a strip's width).
 */
export function pocketsOf(walls: Segment[], thin: number): Point[][] {
  // One vertex for each place walls meet (crossings were worked out once
  // for each wall, so they can differ in the last digits).
  const points: Point[] = [];
  const near = new Map<string, number[]>();
  const vertex = (x: number, y: number): number => {
    const [cx, cy] = [Math.floor(x), Math.floor(y)];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const k of near.get(`${cx + dx} ${cy + dy}`) ?? []) {
          if (Math.hypot(points[k]!.x - x, points[k]!.y - y) < 0.5) return k;
        }
      }
    }
    points.push({ x, y });
    const key = `${cx} ${cy}`;
    near.set(key, [...(near.get(key) ?? []), points.length - 1]);
    return points.length - 1;
  };
  const around: number[][] = [];
  const edges = new Set<string>();
  for (const s of walls) {
    const [a, b] = [vertex(s.x1, s.y1), vertex(s.x2, s.y2)];
    const key = a < b ? `${a} ${b}` : `${b} ${a}`;
    if (a === b || edges.has(key)) continue;
    edges.add(key);
    (around[a] ??= []).push(b);
    (around[b] ??= []).push(a);
  }
  const angle = (from: number, to: number) => Math.atan2(points[to]!.y - points[from]!.y, points[to]!.x - points[from]!.x);
  around.forEach((list, v) => list.sort((p, q) => angle(v, p) - angle(v, q)));

  // Walk each face with it on the left, taking the sharpest turn at every
  // corner; faces come out with positive area, the outsides of things negative.
  const walked = new Set<string>();
  const pockets: Point[][] = [];
  around.forEach((list, start) => {
    for (const first of list) {
      if (walked.has(`${start} ${first}`)) continue;
      const face: number[] = [];
      let [u, v] = [start, first];
      while (!walked.has(`${u} ${v}`)) {
        walked.add(`${u} ${v}`);
        face.push(u);
        const out = around[v]!;
        [u, v] = [v, out[(out.indexOf(u) - 1 + out.length) % out.length]!];
      }
      let [area, perimeter] = [0, 0];
      face.forEach((k, n) => {
        const [p, q] = [points[k]!, points[face[(n + 1) % face.length]!]!];
        area += (p.x * q.y - q.x * p.y) / 2;
        perimeter += Math.hypot(q.x - p.x, q.y - p.y);
      });
      if (area > 0 && (2 * area) / perimeter < thin) pockets.push(face.map((k) => points[k]!));
    }
  });
  return pockets;
}

/** A grid laid over the plan: `width` × `height` cells of `cell` mm, the first centered `cell` / 2 in from (x, y). */
export interface Grid {
  x: number;
  y: number;
  cell: number;
  width: number;
  height: number;
}

/**
 * How far light can spread across `grid` before a wall stops it: for each
 * cell (row by row, from the top), how many cells it can step right, left,
 * down and up (capped at 255) without crossing a wall, as RGBA bytes.
 */
export function reachOf(walls: Segment[], grid: Grid): Uint8Array {
  const { width: w, height: h } = grid;
  const { blockedX, blockedY } = blockedSteps(walls, grid);
  const out = new Uint8Array(w * h * 4);
  const run = (prev: number, blocked: boolean) => (blocked ? 0 : Math.min(255, prev + 1));
  for (let j = 0; j < h; j++) {
    for (let i = w - 1, r = 0; i >= 0; i--) out[(j * w + i) * 4] = r = i === w - 1 ? 0 : run(r, blockedX[j * w + i] === 1);
    for (let i = 0, r = 0; i < w; i++) out[(j * w + i) * 4 + 1] = r = i === 0 ? 0 : run(r, blockedX[j * w + i - 1] === 1);
  }
  for (let i = 0; i < w; i++) {
    for (let j = h - 1, r = 0; j >= 0; j--) out[(j * w + i) * 4 + 2] = r = j === h - 1 ? 0 : run(r, blockedY[j * w + i] === 1);
    for (let j = 0, r = 0; j < h; j++) out[(j * w + i) * 4 + 3] = r = j === 0 ? 0 : run(r, blockedY[(j - 1) * w + i] === 1);
  }
  return out;
}

// Rays go just either side of each wall end, so they slip past corners.
const EPS = 1e-4;
// A wall closer than this (mm) to a light doesn't shadow it: the light hangs
// on its face rather than behind it.
const TOUCHING = 1;

/**
 * The part of the floor a light at `o` can see, out to `reach` in every
 * direction (a square around it): a polygon around `o`, in order round it,
 * so it can be drawn as a fan from `o`. Found by casting a ray past each
 * end of every wall within reach.
 */
export function visibility(o: Point, walls: Segment[], reach: number): Point[] {
  const [x0, y0, x1, y1] = [o.x - reach, o.y - reach, o.x + reach, o.y + reach];
  const near = walls.filter(
    (s) => Math.max(s.x1, s.x2) >= x0 && Math.min(s.x1, s.x2) <= x1 && Math.max(s.y1, s.y2) >= y0 && Math.min(s.y1, s.y2) <= y1,
  );
  const box: Segment[] = [
    { x1: x0, y1: y0, x2: x1, y2: y0 },
    { x1: x1, y1: y0, x2: x1, y2: y1 },
    { x1: x1, y1: y1, x2: x0, y2: y1 },
    { x1: x0, y1: y1, x2: x0, y2: y0 },
  ];
  // Nearest walls first, so a ray can stop looking once the rest are all
  // further away than what it's already hit.
  const all = [...near, ...box].map((s) => ({ s, d: distanceTo(o, s) })).sort((p, q) => p.d - q.d);
  // Each wall end once: walls share their corners.
  const ends = new Set<string>();
  const angles: number[] = [];
  for (const { s } of all) {
    for (const [x, y] of [
      [s.x1, s.y1],
      [s.x2, s.y2],
    ] as const) {
      const key = `${x},${y}`;
      if (ends.has(key)) continue;
      ends.add(key);
      const a = Math.atan2(y - o.y, x - o.x);
      angles.push(a - EPS, a + EPS);
    }
  }
  angles.sort((p, q) => p - q);
  const pts: Point[] = [];
  for (const a of angles) {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let best = Infinity;
    for (const { s, d } of all) {
      if (d >= best) break;
      const t = rayHit(o, dx, dy, s);
      if (t < best) best = t;
    }
    pts.push({ x: o.x + dx * best, y: o.y + dy * best });
  }
  return simplify(pts);
}

/** How close `s` comes to `o`. */
function distanceTo(o: Point, s: Segment): number {
  const sx = s.x2 - s.x1;
  const sy = s.y2 - s.y1;
  const k = Math.max(0, Math.min(1, ((o.x - s.x1) * sx + (o.y - s.y1) * sy) / (sx * sx + sy * sy || 1)));
  return Math.hypot(s.x1 + k * sx - o.x, s.y1 + k * sy - o.y);
}

/** How far along the ray from `o` in direction (dx, dy) it meets `s`, or Infinity. */
function rayHit(o: Point, dx: number, dy: number, s: Segment): number {
  const sx = s.x2 - s.x1;
  const sy = s.y2 - s.y1;
  const denom = dx * sy - dy * sx;
  if (Math.abs(denom) < 1e-12) return Infinity;
  const px = s.x1 - o.x;
  const py = s.y1 - o.y;
  const t = (px * sy - py * sx) / denom;
  const u = (px * dy - py * dx) / denom;
  return t >= TOUCHING && u >= 0 && u <= 1 ? t : Infinity;
}

/** Drop repeats, then points partway along a straight run (rays that hit the same wall). */
function simplify(pts: Point[]): Point[] {
  const prev = <T>(list: T[], i: number) => list[(i + list.length - 1) % list.length]!;
  const uniq = pts.filter((p, i) => Math.hypot(p.x - prev(pts, i).x, p.y - prev(pts, i).y) > 0.5);
  return uniq.filter((q, i) => {
    const p = prev(uniq, i);
    const r = uniq[(i + 1) % uniq.length]!;
    const [ax, ay, bx, by] = [q.x - p.x, q.y - p.y, r.x - q.x, r.y - q.y];
    // Keep it unless the run carries straight on through it.
    return ax * bx + ay * by <= 0 || Math.abs(ax * by - ay * bx) > 1e-4 * Math.hypot(ax, ay) * Math.hypot(bx, by);
  });
}

/** Steps between neighboring cell centers of `grid` that a wall crosses: from (i, j) to (i + 1, j), and to (i, j + 1). */
function blockedSteps(walls: Segment[], grid: Grid): { blockedX: Uint8Array; blockedY: Uint8Array } {
  const { x, y, cell, width: w, height: h } = grid;
  const blockedX = new Uint8Array(w * h);
  const blockedY = new Uint8Array(w * h);
  const crossings = (a1: number, a2: number, b1: number, b2: number, origin: number, across: number, count: number, steps: number, mark: (line: number, step: number) => void) => {
    if (a1 === a2) return;
    const [lo, hi] = a1 < a2 ? [a1, a2] : [a2, a1];
    for (let n = Math.max(0, Math.ceil((lo - origin) / cell - 0.5)); n < count; n++) {
      const c = origin + (n + 0.5) * cell;
      if (c >= hi) break;
      const at = b1 + ((c - a1) * (b2 - b1)) / (a2 - a1);
      const step = Math.floor((at - across) / cell - 0.5);
      if (step >= 0 && step < steps - 1) mark(n, step);
    }
  };
  for (const s of walls) {
    // Where it crosses each row's center line, it blocks the step along x there; each column's, along y.
    crossings(s.y1, s.y2, s.x1, s.x2, y, x, h, w, (j, i) => (blockedX[j * w + i] = 1));
    crossings(s.x1, s.x2, s.y1, s.y2, x, y, w, h, (i, j) => (blockedY[j * w + i] = 1));
  }
  return { blockedX, blockedY };
}
