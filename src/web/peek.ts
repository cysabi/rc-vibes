// Peeking at a stop on the rail: while the pointer's on it, the map previews
// the room as the light is there, every shader above it set aside (pending
// edits and all). At the base tone's stop, that's the base tone alone.

import { useSyncExternalStore } from "react";

/** The base tone's stop (every shader set aside). */
export const BASE_TONE = "roomtone";

let peeking: string | null = null;
const listeners = new Set<() => void>();

export const peek = {
  /** Peek at this stop (a layer's key, or BASE_TONE), or at nothing. */
  set(key: string | null) {
    if (peeking === key) return;
    peeking = key;
    for (const l of listeners) l();
  },
  /** Stop peeking, if it's this stop that's being peeked at. */
  clear(key: string) {
    if (peeking === key) peek.set(null);
  },
};

export function usePeek(): string | null {
  return useSyncExternalStore(
    (changed) => {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
    () => peeking,
  );
}
