// Peeking at the room tone alone: while it's held, the map previews the room
// with every shader set aside (pending edits and all), so you can see the
// base light the shaders draw over.

import { useSyncExternalStore } from "react";

let peeking = false;
const listeners = new Set<() => void>();

export const peek = {
  set(on: boolean) {
    if (peeking === on) return;
    peeking = on;
    for (const l of listeners) l();
  },
};

export function usePeek(): boolean {
  return useSyncExternalStore(
    (changed) => {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
    () => peeking,
  );
}
