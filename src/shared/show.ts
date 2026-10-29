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
//
// A show is on or off, for the whole room (show/on). Off, the clock rests
// (wire.ts' restingClock): playing, at 120 beats a minute on a grid every
// sketch shares, so one that moves on the beat moves well anyway; nobody can
// do anything to it but start a show. Starting one keeps the beat going and
// puts the piece at 0:00, stopped, for someone to play; ending one rests the
// clock again, the nudge kept (the room's sound is as late as it was).

import { BEATS_PER_BAR, beatAt, restingClock, type ShowClock } from "../../packages/vibes/src/wire.ts";

export { BEATS_PER_BAR, beatAt, RESTING_BPM, restingClock, showClock, timeAt, type ShowClock } from "../../packages/vibes/src/wire.ts";

/**
 * How a scene applied in a show comes in (server/show-apply.ts): at once, or
 * on the clock's next beat, or its next bar's first. A show's own setting:
 * outside one, a scene is just an edit, made at once.
 */
export type CueMode = "now" | "beat" | "bar";
export const CUE_MODES: readonly CueMode[] = ["now", "beat", "bar"];

/** The show: whether one's on, its clock (resting, while none is), how scenes come in, and the one waiting for its frame. */
export interface ShowState {
  on: boolean;
  clock: ShowClock;
  cue: CueMode;
  /** A scene applied, waiting for its frame (arclamp's time): gone once that's come. */
  queued: { scene: string; frame: number } | null;
}

/** What a page does to the clock, at `at` (arclamp's time). */
export type TransportAction =
  /** A show begins: the piece at 0:00, stopped, the beat going on. */
  | { do: "start"; at: number }
  /** The show's over: the clock rests. */
  | { do: "end"; at: number }
  | { do: "play"; at: number }
  | { do: "stop"; at: number }
  /** To `t` seconds into the piece. */
  | { do: "seek"; at: number; t: number }
  /** A tempo, the beats counting on from where they were; `onBeat` (a tap), with `at` on a beat. */
  | { do: "tempo"; at: number; bpm: number; onBeat?: boolean }
  /** `at` was a bar's first beat (Sync): the beats move to the nearest one, the tempo as it was. */
  | { do: "downbeat"; at: number }
  /** The room's beat moved later by `ms` (earlier, below 0): the sound reaches the room late. */
  | { do: "nudge"; ms: number }
  /** How scenes come in from now on (CueMode). */
  | { do: "cue"; mode: CueMode };

export const MIN_BPM = 20;
export const MAX_BPM = 300;
export const MAX_NUDGE_MS = 1000;

/** No show on, as a page has it till vibes says: resting, the piece counted from 1970 (vibes' rests from when it began). */
export const RESTING: ShowState = { on: false, clock: restingClock(0), cue: "now", queued: null };

// A press this little after a beat (as a fraction of one) is that beat's, not the next's.
export const LATE_BEATS = 0.04;

/**
 * When something done at `at` (arclamp's time) lands, as `mode` says: at
 * once, or on the clock's next beat (or bar's first; one just gone, within
 * LATE_BEATS, counts); never before `earliest`, the soonest it can be made
 * (one that can't make its beat lands as soon after as it can). With no
 * tempo, at once.
 */
export function cueAt(mode: CueMode, c: ShowClock, at: number, earliest: number): number {
  if (mode === "now" || c.bpm === null || c.beat === null) return earliest;
  const per = mode === "bar" ? BEATS_PER_BAR : 1;
  const target = Math.ceil((beatAt(c, at) - LATE_BEATS) / per) * per;
  return Math.max(c.at + c.nudge + ((target - c.beat) * 60_000) / c.bpm, earliest);
}

/** The clock after an action: anchored where it was at the action's moment (never before its own anchor). */
export function transported(c: ShowClock, a: TransportAction): ShowClock {
  if (a.do === "cue") return c;
  if (a.do === "nudge") return { ...c, nudge: a.ms };
  const at = Math.max(a.at - c.nudge, c.at);
  if (a.do === "end") return restingClock(at, c.nudge);
  const t = c.playing ? c.t + (at - c.at) / 1000 : c.t;
  const beat = c.bpm !== null && c.beat !== null ? c.beat + ((at - c.at) * c.bpm) / 60_000 : null;
  const now: ShowClock = { ...c, at, t, beat };
  switch (a.do) {
    case "start":
      return { ...now, t: 0, playing: false };
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
