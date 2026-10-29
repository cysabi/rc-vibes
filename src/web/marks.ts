// Where the color preview marks lights: lights at exactly the same value share
// one mark, and on the wheel and strip, a single light's dot folds into a
// count's dot when it's mostly hidden under it.

import type { Lemtone } from "../shared/lemtone.ts";

export interface Placed {
  id: number;
  /** What the mark stands for: lights with the same one share it. */
  same: string;
  x: number;
  y: number;
  t: Lemtone;
  label: string;
}

export interface Group {
  key: string;
  x: number;
  y: number;
  /** The lowest-numbered light's. */
  t: Lemtone;
  ids: number[];
  label: string;
  /** Lights folded in from under it, by what they're at. */
  folded: { label: string; n: number }[];
  /** Counts that joined it, it having the most lights: drawn as one blob with it, counted (and hovered) here. */
  joined: Group[];
  /**
   * What it's counted in: for a single light, the count it's folded under
   * (still drawn, under it); for a count, the count it joined.
   */
  into?: Group;
  /** Every light in it is off. */
  dim: boolean;
}

/** arclamp keeps channels as float32, so lights that match there are the same. */
export const exact = (...values: number[]) => values.map((v) => Math.fround(v)).join(",");

/** One mark for each value the lights are at, placed by its lowest-numbered light. */
export function gather(placed: Placed[]): Group[] {
  const bySame = new Map<string, Group>();
  for (const p of [...placed].sort((a, b) => a.id - b.id)) {
    const off = p.t.brightness <= 0;
    const g = bySame.get(p.same);
    if (g) {
      g.ids.push(p.id);
      g.dim &&= off;
    } else {
      bySame.set(p.same, { key: "", x: p.x, y: p.y, t: p.t, ids: [p.id], label: p.label, folded: [], joined: [], dim: off });
    }
  }
  const groups = [...bySame.values()];
  // By its lowest-numbered light, so a mark stays itself as lights join and leave it.
  for (const g of groups) g.key = String(g.ids[0]);
  return groups;
}

/** How many lights a mark counts: its own, folded in or not, and those of the counts that joined it. */
export const totalOf = (g: Group) => g.ids.length + g.joined.reduce((sum, j) => sum + j.ids.length, 0);

/** What a count's lights are at, and how many at each, its own first. */
function partsOf(g: Group): { label: string; n: number }[] {
  const own = g.ids.length - g.folded.reduce((sum, f) => sum + f.n, 0);
  return [{ label: g.label, n: own }, ...g.folded];
}

/** A mark's hover: its lights and what they're at. */
export function titleOf(g: Group): string {
  const n = totalOf(g);
  const parts: { label: string; n: number }[] = [];
  for (const p of [g, ...g.joined].flatMap(partsOf)) {
    const same = parts.find((q) => q.label === p.label);
    if (same) same.n += p.n;
    else parts.push({ ...p });
  }
  if (parts.length === 1) return `${n === 1 ? `Light ${g.ids[0]}` : `${n} lights`}: ${g.label}`;
  return `${n} lights: ${parts.map((p) => `${p.label} (${p.n})`).join(", ")}`;
}

/** How much of the smaller of two circles (radii `r1`, `r2`, centers `d` apart) the other covers, from 0 to 1. */
export function coverOf(r1: number, r2: number, d: number): number {
  const [a, b] = r1 <= r2 ? [r1, r2] : [r2, r1];
  if (d >= a + b) return 0;
  if (d <= b - a) return 1;
  // The lens where they overlap.
  const lens =
    a * a * Math.acos((d * d + a * a - b * b) / (2 * d * a)) +
    b * b * Math.acos((d * d + b * b - a * a) / (2 * d * b)) -
    0.5 * Math.sqrt((-d + a + b) * (d + a - b) * (d - a + b) * (d + a + b));
  return lens / (Math.PI * a * a);
}

/** A dot's diameter (px): one light's, then big enough for a count. */
export const sizeOf = (n: number) => (n === 1 ? 13 : n < 100 ? 24 : 28);

// Points spread over a unit disc, for how much of a dot others cover.
const DISC: [number, number][] = [];
for (let i = 0; i < 10; i++) {
  for (let j = 0; j < 10; j++) {
    const [x, y] = [-0.9 + i * 0.2, -0.9 + j * 0.2];
    if (x * x + y * y <= 1) DISC.push([x, y]);
  }
}

/**
 * The dots for lights on the wheel or strip (`x`, `y` in px), bottom to top:
 * counts over single lights, bigger counts over smaller.
 *
 * A single light's dot folds into the counts over it when they cover more
 * than half of it, and only then, into the one covering most of it: it's
 * counted there, and still drawn, under it. Single dots never fold into each
 * other, however they overlap.
 *
 * Counts join when one covers at least half of the other (and so on, one to
 * the next): the one with the most lights counts them all, and they're drawn
 * as one blob. Counts that overlap less stay apart.
 *
 * Its dots are `size` across (the goo's own, by default); on a track, where
 * they're all on one line, counts join as soon as they overlap at all
 * (`joinCover`), so a blob never carries two numbers.
 */
export function dotsOf(placed: Placed[], { size = sizeOf, joinCover = JOIN_COVER }: { size?: (n: number) => number; joinCover?: number } = {}): Group[] {
  const stack = gather(placed).sort((a, b) => a.ids.length - b.ids.length);
  const counts = stack.filter((g) => g.ids.length > 1).reverse();
  const radius = new Map(counts.map((c) => [c, size(c.ids.length) / 2]));
  const r = size(1) / 2;
  for (const g of stack) {
    if (g.ids.length > 1) continue;
    const near = counts.filter((c) => Math.hypot(c.x - g.x, c.y - g.y) < r + radius.get(c)!);
    // Each point goes to the topmost count over it.
    const hits = new Map<Group, number>();
    for (const [dx, dy] of DISC) {
      const over = near.find((c) => Math.hypot(c.x - (g.x + dx * r), c.y - (g.y + dy * r)) <= radius.get(c)!);
      if (over) hits.set(over, (hits.get(over) ?? 0) + 1);
    }
    let covered = 0;
    for (const n of hits.values()) covered += n;
    if (covered * 2 <= DISC.length) continue;
    const into = [...hits].sort((p, q) => q[1] - p[1])[0]![0];
    into.ids.push(g.ids[0]!);
    into.dim &&= g.dim;
    // Lights that read the same as the count's own (if not exactly it) are just counted with them.
    if (g.label !== into.label) {
      const same = into.folded.find((f) => f.label === g.label);
      if (same) same.n++;
      else into.folded.push({ label: g.label, n: 1 });
    }
    g.into = into;
  }

  // Counts covering at least half of each other, joined up one to the next.
  const leadOf = new Map<Group, Group>(counts.map((c) => [c, c]));
  const find = (c: Group): Group => (leadOf.get(c) === c ? c : find(leadOf.get(c)!));
  for (const [i, a] of counts.entries()) {
    for (const b of counts.slice(i + 1)) {
      if (coverOf(size(a.ids.length) / 2, size(b.ids.length) / 2, Math.hypot(a.x - b.x, a.y - b.y)) >= joinCover) {
        leadOf.set(find(a), find(b));
      }
    }
  }
  const clusters = new Map<Group, Group[]>();
  for (const c of counts) clusters.set(find(c), [...(clusters.get(find(c)) ?? []), c]);
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    // The one with the most lights leads (the lowest-numbered, if it's a tie).
    const [lead, ...rest] = [...members].sort((a, b) => b.ids.length - a.ids.length || Number(a.key) - Number(b.key));
    for (const m of rest) m.into = lead;
    lead!.joined = rest;
  }

  // What they hold now; single lights, folded or not, stay at the bottom.
  return stack.sort((a, b) => a.ids.length - b.ids.length);
}

/** How much of one count another must cover for them to join. */
const JOIN_COVER = 0.5;
