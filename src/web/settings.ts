// Per-browser preferences. Admin mode only reveals room-wide and destructive
// controls; everyone is allowed to turn it on.

import { useSyncExternalStore } from "react";

const ADMIN_KEY = "vibes.adminMode";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(ADMIN_KEY) === "1";
  } catch {
    return false;
  }
}

let cached = read();

export function setAdminMode(on: boolean) {
  try {
    if (on) localStorage.setItem(ADMIN_KEY, "1");
    else localStorage.removeItem(ADMIN_KEY);
  } catch {
    // Storage blocked (private window): the switch just won't persist.
  }
  cached = on;
  for (const l of listeners) l();
}

export function useAdminMode(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => cached,
  );
}

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
