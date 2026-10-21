// Dots along an edge, evenly spaced, for the color editor's backdrops (the
// inner of their two edges: ColorEditor.tsx, backdrop.ts). An edge comes as
// marching squares makes it: a piece in each grid cell it crosses, from where
// it crosses one side of the cell to where it crosses another. Pieces in
// neighboring cells meet where they cross the side they share, so joined up
// by those crossings they're lines (round and back to the start, or ending at
// the picker's own edge). Along each, a dot every so far, the spacing
// stretched a little so the dots come out even: round a closed one, the last
// is as far from the first as from the one before it.

/** A piece of edge, from one crossing to another, each known by the side of the grid it crosses (a key). */
export interface Piece {
  from: number;
  to: number;
}

/**
 * Dots along the lines `pieces` make, about `gap` apart, as x, y pairs;
 * `at` says where each crossing is. A line much shorter than the gap gets
 * none.
 */
export function dotsAlong(pieces: readonly Piece[], at: ReadonlyMap<number, readonly [number, number]>, gap: number): number[] {
  // The pieces at each crossing (two, where the line goes on; one, at its end).
  const ends = new Map<number, number[]>();
  pieces.forEach((p, k) => {
    for (const key of [p.from, p.to]) {
      const here = ends.get(key);
      if (here) here.push(k);
      else ends.set(key, [k]);
    }
  });
  const used = new Uint8Array(pieces.length);
  const dots: number[] = [];

  /** The line from crossing `start`, piece by piece, as the crossings it passes. */
  const walk = (start: number): number[] => {
    const keys = [start];
    for (let key = start; ; ) {
      const next = (ends.get(key) ?? []).find((k) => !used[k]);
      if (next === undefined) return keys;
      used[next] = 1;
      const p = pieces[next]!;
      key = p.from === key ? p.to : p.from;
      keys.push(key);
    }
  };

  const place = (keys: number[]) => {
    const points = keys.map((k) => at.get(k)!);
    const closed = keys.length > 2 && keys[0] === keys[keys.length - 1];
    const lengths = [0];
    for (let i = 1; i < points.length; i++) {
      const [[x0, y0], [x1, y1]] = [points[i - 1]!, points[i]!];
      lengths.push(lengths[i - 1]! + Math.hypot(x1 - x0, y1 - y0));
    }
    const length = lengths[lengths.length - 1]!;
    const n = Math.round(length / gap);
    if (n < 1) return;
    const step = length / n;
    // Round a closed line, from where it starts; along an open one, half a step in from each end.
    let i = 1;
    for (let d = 0; d < n; d++) {
      const s = (closed ? d : d + 0.5) * step;
      while (i < lengths.length - 1 && lengths[i]! < s) i++;
      const [[x0, y0], [x1, y1]] = [points[i - 1]!, points[i]!];
      const span = lengths[i]! - lengths[i - 1]!;
      const t = span > 0 ? (s - lengths[i - 1]!) / span : 0;
      dots.push(x0 + t * (x1 - x0), y0 + t * (y1 - y0));
    }
  };

  // The open lines from their ends first, then what's left, which goes round.
  for (const [key, here] of ends) if (here.length === 1 && !used[here[0]!]) place(walk(key));
  pieces.forEach((p, k) => {
    if (!used[k]) place(walk(p.from));
  });
  return dots;
}
