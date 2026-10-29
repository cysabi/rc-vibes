// Selecting lights, and how the map rings them while you do.
//
// A change to the selection is some lights by a mode (selectionWith): replace
// it with them, add them, toggle each, or take them out. Shift adds (or, all
// of them selected already, takes them out); alt always takes out (keyedMode).
//
// A light's ring says one of three things about it, by its line alone (no
// light or ring is ever faded):
//
//   solid    selected
//   dashed   hovered: under the pointer, in a box being dragged out, or
//            pointed out from a panel (a layer's row, an unsaved changes
//            asterisk: hint.ts)
//   dotted   about to be let go of: selected, but what's hovered would
//            leave it out if it were clicked (or the box let go)
//   none     none of those
//
// Letting go wins over hovered, and hovered over selected: what a click would
// do shows over what is.

/** Replace the selection; add to it; toggle each; or take each out of it. */
export type SelectMode = "replace" | "add" | "toggle" | "remove";

/**
 * A selection with a change made: `ids` by `mode`. A replace replaces just
 * what's in `scope` (the lights on the floor shown; everything, by default),
 * so a set that reaches past it (a domain, on every floor) keeps the rest.
 */
export function selectionWith(prev: ReadonlySet<number>, ids: readonly number[], mode: SelectMode, scope?: ReadonlySet<number>): Set<number> {
  if (mode === "replace") return new Set([...(scope ? [...prev].filter((id) => !scope.has(id)) : []), ...ids]);
  const next = new Set(prev);
  for (const id of ids) {
    if (mode === "remove" || (mode === "toggle" && next.has(id))) next.delete(id);
    else next.add(id);
  }
  return next;
}

/**
 * Shift or alt on some lights (one, a box of them, a layer's), as a selection
 * change. Shift adds them; only if every one's selected already does it let
 * go of them. Alt always lets go of them, never adds.
 */
export function keyedMode(mode: "add" | "remove", ids: readonly number[], selected: ReadonlySet<number>): "add" | "remove" {
  if (mode === "add") return ids.length > 0 && ids.every((id) => selected.has(id)) ? "remove" : "add";
  return "remove";
}

/** Of the lights selected, the ones a change would let go of. */
export function leavingFor(selected: ReadonlySet<number>, next: ReadonlySet<number>): Set<number> {
  return new Set([...selected].filter((id) => !next.has(id)));
}

/** How a light's ring is drawn. */
export type RingStyle = "none" | "solid" | "dashed" | "dotted";

/** A light's ring, from what it is to the selection now (see the top of this file). */
export function ringStyle(selected: boolean, hovered: boolean, leaving: boolean): RingStyle {
  if (selected && leaving) return "dotted";
  if (hovered) return "dashed";
  if (selected) return "solid";
  return "none";
}

/** Each style's dashes for a canvas (setLineDash, with round ends for the dots), at a ring's line width. */
export const RING_DASH: Record<Exclude<RingStyle, "none">, number[]> = {
  solid: [],
  dashed: [4, 3],
  // A dash of nothing, with round ends, is a dot.
  dotted: [0, 3.5],
};
