// Per-browser preferences. Admin mode only reveals room-wide and destructive
// controls; everyone is allowed to turn it on. Live mode skips the preview:
// edits go to the room as they're made.

import { useSyncExternalStore } from "react";

/** A switch kept in this browser, and a hook that follows it. */
function flag(key: string) {
  const listeners = new Set<() => void>();
  let cached = false;
  try {
    cached = localStorage.getItem(key) === "1";
  } catch {
    // Storage blocked: it starts off.
  }
  const set = (on: boolean) => {
    try {
      if (on) localStorage.setItem(key, "1");
      else localStorage.removeItem(key);
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
export const [setLiveMode, useLiveMode] = flag("vibes.liveMode");

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
