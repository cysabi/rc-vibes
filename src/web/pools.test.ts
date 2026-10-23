import { describe, expect, it } from "vitest";
import type { Point } from "../shared/rails.ts";
import { FLOORS } from "./floors.ts";
import { REACH_MM, type Source } from "./lighting.ts";
import { BINS, diamond, poolsOf, sees, type Pools } from "./pools.ts";
import { visibility, type Segment } from "./shadows.ts";

/** A light's fan, as RoomMap makes them: the light, then what it can see, closed back on its first corner. */
function source(o: Point, walls: Segment[]): Source & { poly: Point[] } {
  const poly = visibility(o, walls, REACH_MM);
  const fan = new Float32Array((poly.length + 2) * 2);
  fan.set([o.x, o.y]);
  poly.forEach((p, i) => fan.set([p.x, p.y], 2 + i * 2));
  fan.set([poly[0]!.x, poly[0]!.y], fan.length - 2);
  return { x: o.x, y: o.y, fan, bare: false, poly };
}

/** Whether p is inside the polygon (even-odd). */
function inside(poly: Point[], p: Point): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[i]!, poly[j]!];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** How close p comes to the polygon's outline. */
function toOutline(poly: Point[], p: Point): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [a, b] = [poly[j]!, poly[i]!];
    const [dx, dy] = [b.x - a.x, b.y - a.y];
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y));
  }
  return best;
}

/** The lights lighting p, as the GPU reads the lists: its square's lights, each tested if it needs to be. */
function litBy(pools: Pools, sources: Source[], p: Point): Set<number> {
  const { grid, cells, list } = pools;
  const [i, j] = [Math.floor((p.x - grid.x) / grid.cell), Math.floor((p.y - grid.y) / grid.cell)];
  const out = new Set<number>();
  if (i < 0 || j < 0 || i >= grid.width || j >= grid.height) return out;
  const c = j * grid.width + i;
  for (let k = cells[c * 2]!; k < cells[c * 2]! + cells[c * 2 + 1]!; k++) {
    const n = list[k]! >> 1;
    const filed = { edges: pools.edges, bins: pools.bins.subarray(n * BINS * 2, (n + 1) * BINS * 2), list: pools.binList };
    if ((list[k]! & 1) === 0 || sees(filed, p.x - sources[n]!.x, p.y - sources[n]!.y)) out.add(n);
  }
  return out;
}

/** The same random numbers every run. */
function random(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

describe("diamond", () => {
  it("grows with the angle, from +x toward +y, from 0 up to 4", () => {
    const at = Array.from({ length: 721 }, (_, k) => (k / 720) * 2 * Math.PI - 1e-9).map((a) => diamond(Math.cos(a), Math.sin(a)));
    expect(at[0]).toBeGreaterThan(3.99);
    at.slice(2).forEach((d, k) => expect(d).toBeGreaterThan(at[k + 1]!));
    expect(diamond(0, 1)).toBe(1);
    expect(diamond(-1, 0)).toBe(2);
    expect(diamond(0, -1)).toBe(3);
  });
});

describe("poolsOf", () => {
  it("lights a point from exactly the lights whose fans it's in", () => {
    const floor = FLOORS.find((f) => f.id === 4)!;
    const { x, y, width, height } = floor.viewBox;
    const next = random(4);
    const sources = Array.from({ length: 12 }, () => source({ x: x + next() * width, y: y + next() * height }, floor.walls));
    const pools = poolsOf(sources);
    let tested = 0;
    for (let k = 0; k < 20_000; k++) {
      const p = { x: x + next() * width, y: y + next() * height };
      const lit = litBy(pools, sources, p);
      sources.forEach((s, n) => {
        // On an edge, or at the edge of its reach (where it's faded to nothing), either will do.
        if (Math.abs(Math.hypot(p.x - s.x, p.y - s.y) - REACH_MM) < 1 || toOutline(s.poly, p) < 1) return;
        const reached = Math.hypot(p.x - s.x, p.y - s.y) < REACH_MM;
        if (reached) expect(lit.has(n), `light ${n} at ${p.x}, ${p.y}`).toBe(inside(s.poly, p));
        tested++;
      });
    }
    expect(tested).toBeGreaterThan(200_000);
  });

  it("lists a light wholly lit where none of its fan's edges come near", () => {
    // A light in the middle of a 10 m room: all of it is lit, and only the squares on its walls need testing.
    const room: Segment[] = [
      { x1: 0, y1: 0, x2: 10_000, y2: 0 },
      { x1: 10_000, y1: 0, x2: 10_000, y2: 10_000 },
      { x1: 10_000, y1: 10_000, x2: 0, y2: 10_000 },
      { x1: 0, y1: 10_000, x2: 0, y2: 0 },
    ];
    const pools = poolsOf([source({ x: 5000, y: 5000 }, room)]);
    const entries = [...pools.list];
    expect(entries.filter((e) => e === 0)).toHaveLength(18 * 18);
    // Every square touching a wall: 20 along each, the corners counted once,
    // and those just outside the walls, as the margin reaches them.
    expect(entries.filter((e) => e === 1).length).toBeGreaterThanOrEqual(4 * 19);
  });
});
