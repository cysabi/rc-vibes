// A layer picked in the layers panel (its row clicked, selecting its lights):
// the selection panel answers by closing every row but that layer's, and
// opening it. Each pick is new (its count), so picking the same layer again
// closes the rest again.

import { useSyncExternalStore } from "react";
import type { LayerKey } from "./draft.ts";

export interface Focus {
  key: LayerKey;
  /** Which pick this is. */
  n: number;
}

let focus: Focus | null = null;
const listeners = new Set<() => void>();

/** The layers panel picked this layer. */
export function focusLayer(key: LayerKey) {
  focus = { key, n: (focus?.n ?? 0) + 1 };
  for (const l of listeners) l();
}

export function useFocus(): Focus | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => focus,
  );
}
