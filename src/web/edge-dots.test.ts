import { describe, expect, it } from "vitest";
import { dotsAlong, type Piece } from "./edge-dots.ts";

/** A line through `points` as pieces, crossings keyed from `first`, in the order given (or shuffled). */
function line(points: [number, number][], first: number, closed = false) {
  const at = new Map<number, [number, number]>(points.map((p, i) => [first + i, p]));
  const pieces: Piece[] = points.slice(1).map((_, i) => ({ from: first + i, to: first + i + 1 }));
  if (closed) pieces.push({ from: first + points.length - 1, to: first });
  return { at, pieces };
}

const pairs = (flat: number[]) => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i]!, flat[2 * i + 1]!] as const);

describe("dots along an edge", () => {
  it("are evenly spaced along an open line, half a step in from its ends", () => {
    const { at, pieces } = line(Array.from({ length: 11 }, (_, i) => [i * 6, 0]), 0);
    const dots = pairs(dotsAlong(pieces, at, 5));
    expect(dots.map(([x]) => x)).toEqual(Array.from({ length: 12 }, (_, i) => expect.closeTo(2.5 + 5 * i, 9)));
    expect(dots.every(([, y]) => y === 0)).toBe(true);
  });

  it("go evenly round a closed one, the last as far from the first as from the one before it", () => {
    const n = 90;
    const r = 40;
    const { at, pieces } = line(Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)]), 100, true);
    const dots = pairs(dotsAlong(pieces, at, 6));
    expect(dots.length).toBe(Math.round((2 * Math.PI * r) / 6));
    const gaps = dots.map(([x, y], i) => {
      const [nx, ny] = dots[(i + 1) % dots.length]!;
      return Math.hypot(nx - x, ny - y);
    });
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.05);
  });

  it("join pieces in any order, and put dots on each separate line", () => {
    const a = line([[0, 0], [10, 0], [20, 0]], 0);
    const b = line([[0, 50], [0, 60], [0, 70]], 10);
    const pieces = [b.pieces[1]!, a.pieces[1]!, b.pieces[0]!, a.pieces[0]!].map((p, i) => (i % 2 ? p : { from: p.to, to: p.from }));
    const dots = pairs(dotsAlong(pieces, new Map([...a.at, ...b.at]), 5));
    expect(dots.filter(([, y]) => y === 0)).toHaveLength(4);
    expect(dots.filter(([x, y]) => x === 0 && y >= 50)).toHaveLength(4);
  });

  it("leaves out a line much shorter than the gap", () => {
    const { at, pieces } = line([[0, 0], [2, 0]], 0);
    expect(dotsAlong(pieces, at, 6)).toEqual([]);
  });
});
