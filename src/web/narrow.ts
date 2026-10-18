// Whether the screen is narrow: a phone, where the selection panel is a sheet
// up from the bottom and the map's overlays shrink to fit (as in the CSS).
// Wider, there's room along the map's bottom for the panel's inset (372 px),
// the color preview stacked (220), the scale at its widest and the zoom (169),
// and the gaps between (36): 797 px, so the preview never has to move up.

import { useSyncExternalStore } from "react";

const narrowScreen = typeof matchMedia === "function" ? matchMedia("(max-width: 800px)") : null;

export function useNarrow(): boolean {
  return useSyncExternalStore(
    (changed) => {
      narrowScreen?.addEventListener("change", changed);
      return () => narrowScreen?.removeEventListener("change", changed);
    },
    () => narrowScreen?.matches ?? false,
  );
}
