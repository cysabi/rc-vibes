// arclamp's time, in this page: the show clock is in it (shared/show.ts), so
// a press goes there, and the transport reads the room's beat from it.
//
// The page asks vibes, on the room socket (scene.ts): vibes answers at once
// with arclamp's time as it reckons it (server/rclamp-time.ts). That, less
// the middle of the round trip by this page's clock, is how far arclamp's is
// from this page's, off by at most half the round trip (plus vibes' own
// reckoning's error, which it says). Of the last few, the quickest's is
// kept: few enough that this machine's clock can't drift far meanwhile.
// This page's clock is performance's, which nothing jumps (the laptop's own
// clock sync can jump Date.now()).

import { useSyncExternalStore } from "react";

// The quickest of this many answers (one every few seconds) is kept.
const KEEP = 8;

/** This page's clock, in ms since 1970 (as it was when the page loaded). */
export const pageNow = () => performance.timeOrigin + performance.now();

interface Sample {
  offset: number;
  rtt: number;
}

export interface TimeSync {
  /** arclamp's clock less this page's; null till vibes has answered. */
  offset: number | null;
  /** At most this far off, this page from vibes' reckoning (half the kept answer's round trip). */
  error: number | null;
  /** At most this far off, vibes' reckoning from arclamp's own; null till arclamp's answered vibes. */
  vibesError: number | null;
}

let samples: Sample[] = [];
let sync: TimeSync = { offset: null, error: null, vibesError: null };
const listeners = new Set<() => void>();

/** An answer: asked at `asked`, answered at `answered` (this page's clock), saying arclamp's time was `r` and vibes' reckoning off by up to `e`. */
export function heard(asked: number, answered: number, r: number, e: number | null) {
  if (!(answered >= asked) || !Number.isFinite(r)) return;
  samples = [...samples.slice(1 - KEEP), { offset: r - (asked + answered) / 2, rtt: answered - asked }];
  const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  sync = { offset: best.offset, error: best.rtt / 2, vibesError: e };
  for (const l of listeners) l();
}

/** arclamp's time now, as best this page knows it (this page's own, till vibes has said). */
export const rNow = () => pageNow() + (sync.offset ?? 0);

/** When an event happened (a press, a tap), in arclamp's time. */
export const rOfEvent = (e: { timeStamp: number }) => performance.timeOrigin + e.timeStamp + (sync.offset ?? 0);

/** How well this page knows arclamp's time. */
export function useTimeSync(): TimeSync {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => sync,
  );
}

/** For tests: forget every answer. */
export function forgetTime() {
  samples = [];
  sync = { offset: null, error: null, vibesError: null };
}
