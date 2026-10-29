// Whether to show unsaved changes at all: the asterisks (each layer's, and
// the selection title's), and the panels' save and discard. Outside live
// mode, always. In live mode, edits go to the room as they're made, so what's
// pending is only ever on its way for a moment: showing it would just flicker.
// Only once a send's failed (App.tsx), and they wait for a save by hand, are
// they shown again.

import { useSyncExternalStore } from "react";
import { useLiveMode } from "./settings.ts";

let stuck = false;
const listeners = new Set<() => void>();

/** Live mode's sending has failed (or is fine again): App.tsx says so. */
export function setLiveStuck(now: boolean) {
  if (stuck === now) return;
  stuck = now;
  for (const l of listeners) l();
}

/** Whether unsaved changes are shown. */
export function useShowUnsaved(): boolean {
  const live = useLiveMode();
  const isStuck = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => stuck,
  );
  return !live || isStuck;
}
