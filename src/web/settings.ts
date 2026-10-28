// Per-browser preferences. Admin mode only reveals room-wide and destructive
// controls; everyone is allowed to turn it on. Live mode skips the preview:
// edits go to the room as they're made. It's for this page only, never kept:
// a reload starts out of it, previewing again.

import { useSyncExternalStore } from "react";

/** A switch kept in this browser (or, with no key, only till the page goes), and a hook that follows it. */
function flag(key: string | null) {
  const listeners = new Set<() => void>();
  let cached = false;
  try {
    if (key) cached = localStorage.getItem(key) === "1";
  } catch {
    // Storage blocked: it starts off.
  }
  const set = (on: boolean) => {
    try {
      if (key && on) localStorage.setItem(key, "1");
      else if (key) localStorage.removeItem(key);
    } catch {
      // Storage blocked (private window): the switch just won't persist.
    }
    cached = on;
    for (const l of listeners) l();
  };
  const use = () =>
    useSyncExternalStore(
      (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      () => cached,
    );
  return [set, use] as const;
}

export const [setAdminMode, useAdminMode] = flag("vibes.adminMode");
export const [setLiveMode, useLiveMode] = flag(null);
// Kept once, before it wasn't: let go of.
try {
  localStorage.removeItem("vibes.liveMode");
} catch {
  // Storage blocked: nothing kept to let go of.
}
// The map's light worked out a pixel at a time (lighting-exact.ts), while it's tried out.
export const [setExactLight, useExactLight] = flag("vibes.exactLight");

const FLOOR_KEY = "vibes.floor";

/** The floor this browser last looked at, if any. */
export function savedFloor(): string | null {
  try {
    return localStorage.getItem(FLOOR_KEY);
  } catch {
    return null;
  }
}

export function saveFloor(view: string) {
  try {
    localStorage.setItem(FLOOR_KEY, view);
  } catch {
    // Storage blocked: the map just opens on the default floor next time.
  }
}
