// Peeking: while the pointer's on something, the map shows the room as it
// would be there. At a stop on the rail, the pipeline (pending edits and all)
// up to and including that stop, every shader above it set aside; at room
// tone's stop, the room tone alone. At the discard button, the saved
// pipeline: the room as it is, without what's pending (SAVED).

import { useSyncExternalStore } from "react";

/** Room tone's stop (every shader set aside). */
export const ROOM_TONE = "roomtone";
/** The saved pipeline: the room as it is, what's pending set aside. */
export const SAVED = "saved";

let peeking: string | null = null;
const listeners = new Set<() => void>();

export const peek = {
  /** Peek at this stop (a layer's key, or ROOM_TONE), or the saved room (SAVED), or at nothing. */
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
