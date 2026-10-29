// Lights pointed out on the map from elsewhere: whatever's under the pointer
// that stands for some lights (a layer's row in the layers panel, an unsaved
// changes asterisk in either panel, a group's chip) rings them as hovered,
// as if the pointer were on them on the map (App.tsx; RoomMap's hinted).
//
// What a click on it would let go of shows too (selection.ts' rings): by
// default, as a click that selects just its lights would (everything else
// selected); or, for one whose click does something else (a chip adds its
// lights, or takes them out), what it says.
//
// Pointing at one thing inside another (a layer's asterisk, in its row's
// head) points out the inner one's lights, and leaving it, the outer one's
// again: each thing pointed at says so in turn, and the last that still is
// wins.

import { useEffect, useId, useSyncExternalStore, type PointerEvent } from "react";

export interface Hint {
  /** The lights it stands for. */
  ids: ReadonlySet<number>;
  /** What a click on it would let go of, if it says; null: as a click selecting just `ids` would. */
  leaving: ReadonlySet<number> | null;
}

type Ids = readonly number[] | ReadonlySet<number>;

const pointing = new Map<string, Hint>();
let current: Hint | null = null;
const listeners = new Set<() => void>();

function changed() {
  current = [...pointing.values()].at(-1) ?? null;
  for (const l of listeners) l();
}

/** What's pointed out (null: nothing). */
export function useHint(): Hint | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

const asSet = (ids: Ids): ReadonlySet<number> => (ids instanceof Set ? ids : new Set(ids));

/**
 * Pointing these lights out while the pointer's on what this is spread on
 * (or null, to point out nothing, as if it weren't there), and, if given,
 * what a click on it would let go of. Unmounted while it's pointed at, it
 * lets go.
 */
export function usePointsOut(ids: () => Ids | null, leaving?: () => Ids) {
  const owner = useId();
  useEffect(
    () => () => {
      if (pointing.delete(owner)) changed();
    },
    [owner],
  );
  return {
    onPointerEnter: (_: PointerEvent) => {
      const these = ids();
      pointing.delete(owner);
      if (these) pointing.set(owner, { ids: asSet(these), leaving: leaving ? asSet(leaving()) : null });
      changed();
    },
    onPointerLeave: (_: PointerEvent) => {
      if (pointing.delete(owner)) changed();
    },
  };
}
