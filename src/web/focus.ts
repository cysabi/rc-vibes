// A layer picked in the layers panel (its row clicked, selecting its lights):
// the selection panel answers by closing every row but that layer's, and
// opening it. A pick is something that happens, once, not state: the panel
// open hears it as it's made. One made with no panel open (nothing was
// selected) is kept for the panel the pick itself opens, as it mounts, and
// for no later one: it's dropped once the click is done with.

import { useLayoutEffect, useRef } from "react";
import type { LayerKey } from "./draft.ts";

type Listener = (key: LayerKey) => void;

const listeners = new Set<Listener>();
let pending: LayerKey | null = null;

/** The layers panel picked this layer. */
export function focusLayer(key: LayerKey) {
  if (listeners.size > 0) {
    for (const l of listeners) l(key);
    return;
  }
  pending = key;
  // The panel the click opens mounts before this; any later one never sees it.
  setTimeout(() => {
    if (pending === key) pending = null;
  });
}

/** Hear each pick as it's made (and the one that opened this, if one did). */
export function useOnFocus(onFocus: Listener) {
  const latest = useRef(onFocus);
  latest.current = onFocus;
  useLayoutEffect(() => {
    const l: Listener = (key) => latest.current(key);
    if (pending !== null) {
      const key = pending;
      pending = null;
      l(key);
    }
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}
