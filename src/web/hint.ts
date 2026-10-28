// Lights pointed out on the map from elsewhere: whatever's under the pointer
// that stands for some lights (a layer's row in the layers panel, an unsaved
// changes asterisk in either panel) rings them, dashed, as if the pointer
// were on them on the map (App.tsx; RoomMap's hinted).
//
// Pointing at one thing inside another (a layer's asterisk, in its row's
// head) points out the inner one's lights, and leaving it, the outer one's
// again: each thing pointed at says so in turn, and the last that still is
// wins.

import { useEffect, useId, useSyncExternalStore, type PointerEvent } from "react";

const pointing = new Map<string, ReadonlySet<number>>();
let current: ReadonlySet<number> | null = null;
const listeners = new Set<() => void>();

function changed() {
  current = [...pointing.values()].at(-1) ?? null;
  for (const l of listeners) l();
}

/** The lights pointed out (null: none). */
export function useHint(): ReadonlySet<number> | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/**
 * Pointing these lights out while the pointer's on what this is spread on
 * (or null, to point out nothing, as if it weren't there). Unmounted while
 * it's pointed at, it lets go.
 */
export function usePointsOut(ids: () => readonly number[] | ReadonlySet<number> | null) {
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
      if (these) pointing.set(owner, these instanceof Set ? these : new Set(these));
      changed();
    },
    onPointerLeave: (_: PointerEvent) => {
      if (pointing.delete(owner)) changed();
    },
  };
}
