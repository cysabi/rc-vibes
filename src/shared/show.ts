// The show clock: one for the room, in the live tree (show/clock), and what
// a page does to it (show/transport). What it is and how it reads are the
// library's (packages/vibes/src/wire.ts), so vibes, its pages and every
// sketch read it the same way, in arclamp's time: the time a frame has.
//
// A page acts on it; it doesn't set it. vibes makes each action into a new
// anchor (server/show.ts), from where the clock is at the moment the action
// happened, so two pages acting at once can't undo each other with what they
// last saw. Each action says when it happened (`at`, in arclamp's time: a
// page puts its press there, web/rtime.ts), and the new anchor holds from
// then: nothing waits on the way, and a sketch that hears of it late jumps
// to where it would have been.
//
// The anchor's own time is the show's: arclamp's, less the nudge (wire.ts),
// so a nudge moves the room's beat, and acting doesn't.

import { BEATS_PER_BAR, type ShowClock } from "../../packages/vibes/src/wire.ts";

export { BEATS_PER_BAR, beatAt, showClock, timeAt, type ShowClock } from "../../packages/vibes/src/wire.ts";

/** What a page does to the clock, at `at` (arclamp's time). */
export type TransportAction =
  | { do: "play"; at: number }
  | { do: "stop"; at: number }
  /** To `t` seconds into the piece. */
  | { do: "seek"; at: number; t: number }
  /** A tempo, the beats counting on from where they were; `onBeat` (a tap), with `at` on a beat. */
  | { do: "tempo"; at: number; bpm: number; onBeat?: boolean }
  /** `at` was a bar's first beat (Sync): the beats move to the nearest one, the tempo as it was. */
  | { do: "downbeat"; at: number }
  /** The room's beat moved later by `ms` (earlier, below 0): the sound reaches the room late. */
  | { do: "nudge"; ms: number };

export const MIN_BPM = 20;
export const MAX_BPM = 300;
export const MAX_NUDGE_MS = 1000;

/** Before anyone's touched it: stopped at 0, no tempo. */
export const STOPPED: ShowClock = { playing: false, at: 0, t: 0, bpm: null, beat: null, nudge: 0 };

/** The clock after an action: anchored where it was at the action's moment (never before its own anchor). */
export function transported(c: ShowClock, a: TransportAction): ShowClock {
  if (a.do === "nudge") return { ...c, nudge: a.ms };
  const at = Math.max(a.at - c.nudge, c.at);
  const t = c.playing ? c.t + (at - c.at) / 1000 : c.t;
  const beat = c.bpm !== null && c.beat !== null ? c.beat + ((at - c.at) * c.bpm) / 60_000 : null;
  const now: ShowClock = { ...c, at, t, beat };
  switch (a.do) {
    case "play":
      return { ...now, playing: true };
    case "stop":
      return { ...now, playing: false };
    case "seek":
      return { ...now, t: a.t };
    case "tempo": {
      const b = now.beat ?? 0;
      return { ...now, bpm: a.bpm, beat: a.onBeat ? Math.round(b) : b };
    }
    case "downbeat":
      return now.beat === null ? now : { ...now, beat: Math.round(now.beat / BEATS_PER_BAR) * BEATS_PER_BAR };
  }
}

/** A tempo from taps' times (ms, any one clock): the middle of their gaps, if there are enough that agree; else null. */
export function tappedBpm(taps: readonly number[]): number | null {
  if (taps.length < 3) return null;
  const gaps = taps
    .slice(1)
    .map((t, i) => t - taps[i]!)
    .sort((x, y) => x - y);
  const mid = gaps[Math.floor(gaps.length / 2)]!;
  const bpm = 60_000 / mid;
  return bpm >= MIN_BPM && bpm <= MAX_BPM ? Math.round(bpm * 10) / 10 : null;
}
