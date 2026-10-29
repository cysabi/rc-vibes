import { describe, expect, it } from "vitest";
import { coverOf, dotsOf, exact, gather, titleOf, totalOf, type Placed } from "./marks.ts";

let next = 0;
/** `n` lights at one color, its dot at x, y. */
function lights(n: number, x: number, y: number, color = `${x},${y}`, label = color): Placed[] {
  return Array.from({ length: n }, () => ({
    id: ++next,
    same: color,
    x,
    y,
    t: { a: 0, b: 0, brightness: 0.5, fidelity: 1 },
    label,
  }));
}
/** The dots drawn, bottom to top, by how many lights each counts; folded single lights as "under", joined counts as "joined". */
const counts = (placed: Placed[]) => dotsOf(placed).map((g) => (g.into ? (g.ids.length === 1 ? "under" : "joined") : totalOf(g)));

describe("marks for lights at the same value", () => {
  it("share one only when they match exactly, at float32", () => {
    // What arclamp sends back for 3000 K, against what vibes computes.
    expect(exact(0.0600728851, 0.134711643)).toBe(exact(0.060072885, 0.13471164));
    expect(exact(0.06, 0.13)).not.toBe(exact(0.0601, 0.13));
    expect(gather([...lights(3, 10, 10, "warm"), ...lights(2, 10, 10, "cool")]).map((g) => g.ids.length)).toEqual([3, 2]);
  });
});

describe("dots on the wheel and strip", () => {
  it("never fold single lights together, however they overlap", () => {
    expect(counts([...lights(1, 50, 50, "a"), ...lights(1, 50.5, 50, "b"), ...lights(1, 50, 51, "c")])).toEqual([1, 1, 1]);
  });

  it("join counts covering at least half of each other, and keep them apart otherwise", () => {
    // Two counts' dots, 24 px across, cover half of each other about 9.7 px apart.
    expect(counts([...lights(14, 0, 0, "a"), ...lights(9, 9, 0, "b")])).toEqual(["joined", 23]);
    expect(counts([...lights(14, 0, 0, "a"), ...lights(9, 11, 0, "b")])).toEqual([9, 14]);
  });

  it("join counts one to the next, the one with the most lights counting them all", () => {
    // The ends are too far apart to join, but each joins the middle.
    const stack = dotsOf([...lights(5, 0, 0, "a"), ...lights(6, 9, 0, "b"), ...lights(7, 18, 0, "c")]);
    expect(stack.map((g) => (g.into ? `into ${g.into.label}` : totalOf(g)))).toEqual(["into c", "into c", 18]);
  });

  it("says what joined counts hold", () => {
    const [, lead] = dotsOf([...lights(9, 9, 0, "3000 K"), ...lights(14, 0, 0, "2700 K")]);
    expect(titleOf(lead!)).toBe("23 lights: 2700 K (14), 3000 K (9)");
  });

  it("measure how much of the smaller of two circles the other covers", () => {
    expect(coverOf(12, 12, 0)).toBe(1);
    expect(coverOf(12, 12, 24)).toBe(0);
    expect(coverOf(6.5, 12, 4)).toBe(1);
    expect(coverOf(12, 12, 9)).toBeGreaterThan(0.5);
    expect(coverOf(12, 12, 10)).toBeLessThan(0.5);
  });

  it("fold a single light into a count covering more than half of it, and not otherwise", () => {
    // A count's dot is 24 px across; a single light's, 13.
    expect(counts([...lights(5, 0, 0, "count"), ...lights(1, 10, 0, "near")])).toEqual(["under", 6]);
    expect(counts([...lights(5, 0, 0, "count"), ...lights(1, 13, 0, "edge")])).toEqual([1, 5]);
  });

  it("says what a count holds once lights fold into it", () => {
    // Two lights a hair apart, both a 2950 K to look at.
    const placed = [...lights(5, 0, 0, "3000 K"), ...lights(1, 2, 0, "a", "2950 K"), ...lights(1, 0, 2, "b", "2950 K")];
    expect(titleOf(dotsOf(placed).at(-1)!)).toBe("7 lights: 3000 K (5), 2950 K (2)");
    // One a hair off 3000 K, but a 3000 K to look at.
    const alike = [...lights(5, 0, 0, "3000 K"), ...lights(1, 2, 0, "c", "3000 K")];
    expect(titleOf(dotsOf(alike).at(-1)!)).toBe("6 lights: 3000 K");
  });

  it("stacks counts over single lights, and bigger counts over smaller", () => {
    const stack = dotsOf([...lights(9, 0, 0, "nine"), ...lights(1, 100, 0, "one"), ...lights(14, 200, 0, "fourteen")]);
    expect(stack.map((g) => g.ids.length)).toEqual([1, 9, 14]);
  });
});

describe("balls on a track", () => {
  // As the look card's tracks have them: a light 11px across, a count 18px; counts join as soon as they overlap.
  const track = { size: (n: number) => (n > 1 ? 18 : 11), joinCover: 0.01 };
  const along = (placed: Placed[]) => dotsOf(placed, track).map((g) => (g.into ? (g.ids.length === 1 ? "under" : "joined") : totalOf(g)));

  it("join counts that overlap at all, so a blob has one number", () => {
    expect(along([...lights(3, 0, 0), ...lights(2, 16, 0)])).toEqual(["joined", 5]);
  });

  it("keep counts that don't touch apart, each with its own", () => {
    expect(along([...lights(3, 0, 0), ...lights(2, 19, 0)])).toEqual([2, 3]);
  });
});
