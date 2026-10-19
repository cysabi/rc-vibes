// The smallest router that will do: the path and its query, kept in step with
// the address bar, and navigate() to change them.

import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
window.addEventListener("popstate", () => listeners.forEach((l) => l()));

export function navigate(to: string) {
  if (to === location.pathname + location.search) return;
  history.pushState(null, "", to);
  listeners.forEach((l) => l());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

/** One of the address's query parameters, or null. */
export function useQueryParam(name: string): string | null {
  return useSyncExternalStore(subscribe, () => new URLSearchParams(location.search).get(name));
}
