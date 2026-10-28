// arclamp's clock, as vibes keeps up with it. The show clock is in
// arclamp's time (shared/show.ts), the time its frames have, so vibes needs
// it to put a press in it (a page's, through vibes: api.ts answers each
// page's "time" with it).
//
// Every so often vibes asks GET /v1/time a few times, as NTP does: each
// answer, less the middle of its round trip by vibes' clock, is how far
// arclamp's is from vibes', off by at most half the round trip; of a round's
// tries, the quickest's is kept. Only the latest round's: while NTP slews
// arclamp's own clock (by up to half a millisecond a second), an older try
// would be further off than a slower new one. vibes' clock here is its
// monotonic one, so NTP correcting kokuzo's doesn't move it.
//
// Till arclamp first answers, arclamp's time is vibes' (offset 0, error
// unknown); if it stops answering, the last round's stays, getting older.

import type { Arclamp } from "./arclamp.ts";

const EVERY_MS = 10_000;
const TRIES = 8;
const GAP_MS = 50;

/** vibes' monotonic clock, in ms since 1970 (as it was when vibes started). */
export const monotonic = () => performance.timeOrigin + performance.now();

export interface RclampTimeState {
  /** arclamp's clock less vibes'; null till it's answered. */
  offset: number | null;
  /** At most this far off (ms): half the kept try's round trip. */
  error: number | null;
  /** How long ago arclamp last answered (ms). */
  age: number | null;
}

interface Deps {
  arclamp: Pick<Arclamp, "time">;
  now?: () => number;
  everyMs?: number;
  tries?: number;
  gapMs?: number;
}

export function createRclampTime({ arclamp, now = monotonic, everyMs = EVERY_MS, tries = TRIES, gapMs = GAP_MS }: Deps) {
  let kept: { offset: number; rtt: number } | null = null;
  let answered: number | null = null;
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  /** One round of tries: the quickest kept, if any answered. */
  async function round() {
    if (running) return;
    running = true;
    try {
      let best: { offset: number; rtt: number } | null = null;
      for (let i = 0; i < tries; i++) {
        if (i > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
        const v0 = now();
        let r: number;
        try {
          r = (await arclamp.time()).now_ms;
        } catch {
          continue;
        }
        const v1 = now();
        if (!Number.isFinite(r)) continue;
        const rtt = v1 - v0;
        if (!best || rtt < best.rtt) best = { offset: r - (v0 + v1) / 2, rtt };
        answered = v1;
      }
      if (best) kept = best;
    } finally {
      running = false;
    }
  }

  return {
    round,

    start() {
      void round();
      timer = setInterval(() => void round(), everyMs);
      timer.unref?.();
    },

    stop() {
      clearInterval(timer);
    },

    /** arclamp's time now, as best vibes knows it. */
    rNow: () => now() + (kept?.offset ?? 0),

    state(): RclampTimeState {
      return { offset: kept?.offset ?? null, error: kept ? kept.rtt / 2 : null, age: answered === null ? null : now() - answered };
    },
  };
}

export type RclampTime = ReturnType<typeof createRclampTime>;
