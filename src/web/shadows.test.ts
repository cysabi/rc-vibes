import { describe, expect, it } from "vitest";
import type { Point } from "../shared/rails.ts";
import { bucketsOf, pocketsOf, reachOf, splitAtCrossings, visibility, wallsOf, type Segment } from "./shadows.ts";

/** Whether p is inside the polygon (even-odd). */
function inside(poly: Point[], p: Point): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

describe("wallsOf", () => {
  it("reads walls in millimeters, skipping doors, symbols, breaks, dashed lines and steps", () => {
    const svg = `<svg><g transform="matrix(10 0 0 10 -5 -5)">
      <g inkscape:label="Core partitions">
        <rect x="0" y="0" width="2" height="1" stroke="#000"/>
        <line x1="0" y1="5" x2="3" y2="5" stroke="white"/>
        <line x1="0" y1="7" x2="3" y2="7" stroke="#999" stroke-dasharray="7 4"/>
        <line data-step="" x1="0" y1="8" x2="3" y2="8" stroke="#777"/>
        <g transform="translate(1 1)"><line x1="0" y1="0" x2="1" y2="0"/></g>
      </g>
      <g inkscape:label="Doors"><line x1="0" y1="0" x2="9" y2="9"/></g>
      <g inkscape:label="Office partitions"><polyline points="0,2 1,2 1,3"/></g>
    </g></svg>`;
    const walls = wallsOf(svg);
    expect(walls).toHaveLength(6); // the rect's four sides, the polyline's two
    expect(walls[0]).toEqual({ x1: -5, y1: -5, x2: 15, y2: -5 });
    expect(walls[5]).toEqual({ x1: 5, y1: 15, x2: 5, y2: 25 });
  });
});

describe("visibility", () => {
  // A 10 m room with a wall across the middle, open for a 1 m doorway at its left end.
  const room: Segment[] = [
    { x1: 0, y1: 0, x2: 10_000, y2: 0 },
    { x1: 10_000, y1: 0, x2: 10_000, y2: 10_000 },
    { x1: 10_000, y1: 10_000, x2: 0, y2: 10_000 },
    { x1: 0, y1: 10_000, x2: 0, y2: 0 },
    { x1: 1000, y1: 5000, x2: 10_000, y2: 5000 },
  ];

  it("sees its own side of a wall, and through a doorway, but not behind the wall", () => {
    const poly = visibility({ x: 5000, y: 2500 }, room, 20_000);
    expect(inside(poly, { x: 9000, y: 1000 })).toBe(true);
    expect(inside(poly, { x: 7000, y: 8000 })).toBe(false);
    // Through the doorway, on a line from the light that clears its jamb.
    expect(inside(poly, { x: 100, y: 5200 })).toBe(true);
    expect(inside(poly, { x: 500, y: 6000 })).toBe(false);
    // Never past the room's walls.
    expect(poly.every((p) => p.x >= -1 && p.x <= 10_001 && p.y >= -1 && p.y <= 10_001)).toBe(true);
  });

  it("stops at its reach where nothing is in the way", () => {
    const poly = visibility({ x: 0, y: 0 }, [], 3000);
    // The square's corners, each as the two rays either side of it.
    expect(poly).toHaveLength(8);
    for (const p of poly) expect(Math.max(Math.abs(p.x), Math.abs(p.y))).toBeCloseTo(3000);
  });
});

describe("corners", () => {
  // A room drawn the way the plans draw walls: each runs past the others, so
  // its corners are where wall faces cross, not where any wall ends.
  const room: Segment[] = [
    { x1: -500, y1: 0, x2: 10_500, y2: 0 },
    { x1: 10_000, y1: -500, x2: 10_000, y2: 10_500 },
    { x1: 10_500, y1: 10_000, x2: -500, y2: 10_000 },
    { x1: 0, y1: 10_500, x2: 0, y2: -500 },
  ];

  it("splits walls where they cross", () => {
    const split = splitAtCrossings(room);
    expect(split).toHaveLength(12);
    expect(split).toContainEqual({ x1: 0, y1: 0, x2: 10_000, y2: 0 });
  });

  it("lights a room's corners right into them", () => {
    const poly = visibility({ x: 3000, y: 6000 }, splitAtCrossings(room), 20_000);
    for (const corner of [
      { x: 30, y: 30 },
      { x: 9970, y: 30 },
      { x: 9970, y: 9970 },
      { x: 30, y: 9970 },
    ]) {
      expect(inside(poly, corner)).toBe(true);
    }
  });
});

describe("reachOf", () => {
  it("counts the steps each cell can take before a wall", () => {
    // Four cells in a row, 1 m each, with a wall between the second and third.
    const reach = reachOf([{ x1: 2000, y1: -100, x2: 2000, y2: 1100 }], { x: 0, y: 0, cell: 1000, width: 4, height: 1 });
    const along = (k: number) => [0, 1, 2, 3].map((i) => reach[i * 4 + k]);
    expect(along(0)).toEqual([1, 0, 1, 0]); // right
    expect(along(1)).toEqual([0, 1, 0, 1]); // left
    expect(along(2)).toEqual([0, 0, 0, 0]); // down: only one row
  });
});

describe("bucketsOf", () => {
  it("files each wall under the cells it comes near", () => {
    // A 1 m grid, 4 × 3, with a diagonal wall across its top left and a short one far off in the bottom right.
    const walls: Segment[] = [
      { x1: 100, y1: 100, x2: 1900, y2: 1900 },
      { x1: 3800, y1: 2800, x2: 3900, y2: 2900 },
    ];
    const { cells, list } = bucketsOf(walls, { x: 0, y: 0, cell: 1000, width: 4, height: 3 }, 150);
    const near = (i: number, j: number) => {
      const k = j * 4 + i;
      return [...list.slice(cells[k * 2]!, cells[k * 2]! + cells[k * 2 + 1]!)];
    };
    expect(near(0, 0)).toEqual([0]);
    expect(near(1, 1)).toEqual([0]);
    // It passes the corner of the cell beside its path, so that's within reach too.
    expect(near(1, 0)).toEqual([0]);
    expect(near(3, 0)).toEqual([]);
    expect(near(3, 2)).toEqual([1]);
    // Well clear of the diagonal's path.
    expect(near(0, 2)).toEqual([]);
  });
});

describe("pocketsOf", () => {
  const rect = (x0: number, y0: number, x1: number, y1: number): Segment[] => [
    { x1: x0, y1: y0, x2: x1, y2: y0 },
    { x1: x1, y1: y0, x2: x1, y2: y1 },
    { x1: x1, y1: y1, x2: x0, y2: y1 },
    { x1: x0, y1: y1, x2: x0, y2: y0 },
  ];
  const area = (p: Point[]) => Math.abs(p.reduce((a, q, i) => a + (q.x * p[(i + 1) % p.length]!.y - p[(i + 1) % p.length]!.x * q.y) / 2, 0));

  it("finds the thin strips walls close off, not the rooms", () => {
    // A 4 × 3 m room with a window in its right wall: a 100 mm strip between
    // two lines, which runs past the room's corner and crosses its wall.
    const walls = splitAtCrossings([
      ...rect(0, 0, 4000, 3000),
      { x1: 4100, y1: 1000, x2: 4100, y2: 2000 },
      { x1: 4000, y1: 1000, x2: 4100, y2: 1000 },
      { x1: 4000, y1: 2000, x2: 4100, y2: 2000 },
      // A wall that stops short, inside the room.
      { x1: 1000, y1: 0, x2: 1000, y2: 1500 },
    ]);
    const pockets = pocketsOf(walls, 250);
    expect(pockets).toHaveLength(1);
    expect(area(pockets[0]!)).toBeCloseTo(100 * 1000);
  });

  it("knows a slim partition from a column", () => {
    expect(pocketsOf(rect(0, 0, 50, 1500), 250)).toHaveLength(1);
    expect(pocketsOf(rect(0, 0, 600, 600), 250)).toHaveLength(0);
  });
});
