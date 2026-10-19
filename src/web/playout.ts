// Plays arclamp's frames at a steady pace. Each frame carries the beat it was
// made on (initial_time, on arclamp's clock) and is shown at that time plus a
// delay, so a hiccup on the way here shorter than the delay never reaches the
// map. Frames are shown as sent, never blended, so a strobe stays a strobe.
//
// The delay follows how late frames have been arriving: just above nearly all
// of them, and changing slowly enough that the map never jumps. arclamp's
// clock and this browser's are never compared: `lag` is the gap between them
// and the delay together, measured from arrivals.

/** How long lateness is remembered. */
const WINDOW_MS = 10_000;
/** The delay covers all but this share of the frames in the window... */
const PERCENTILE = 0.995;
/** ...with this to spare. */
const MARGIN_MS = 20;
/** The delay stays this far above the window's quickest frame, at least... */
export const MIN_DELAY_MS = 40;
/** ...and at most: past this, a hiccup shows rather than adding more lag. */
export const MAX_DELAY_MS = 400;
/** The delay until there's lateness to go on. */
export const START_DELAY_MS = 150;
/**
 * How fast the delay can grow and shrink, as a share of the time passing: the
 * map briefly runs at 0.75× while it grows, 1.05× while it shrinks.
 */
export const GROW = 0.25;
export const SHRINK = 0.05;
const RETARGET_MS = 250;
/** With fewer frames than this in the window (a still room), the delay holds. */
const MIN_SAMPLES = 20;
/** Stamps jumping this far mean arclamp started over or its clock stepped. */
const JUMP_MS = 2_000;
/** This long between refreshes (a hidden tab), and playing catches up at once. */
const STALL_MS = 1_000;
/** A hidden tab gets no refreshes to take frames, so it keeps only so many. */
const MAX_QUEUE = 1_000;
const MAX_SAMPLES = 4_000;

/** How the timing has gone since the last call to stats(). */
export interface PlayoutStats {
  /** How far behind the quickest frames the map runs, in ms; null until known. */
  delay: number | null;
  /** The latest frame to arrive, measured the same way; null if none came. */
  worst: number | null;
  /** Frames that arrived after they were due to be shown. */
  late: number;
}

export class Playout<T> {
  private queue: { stamp: number; item: T }[] = [];
  private samples: { at: number; lag: number }[] = [];
  /** The newest frame stamped at or before now - lag is the one to show. */
  private lag: number | null = null;
  /** Whether the delay has had a window of lateness to go on yet. */
  private settled = false;
  private target = 0;
  private fastest = 0;
  private lastStamp: number | null = null;
  private lastAt: number | null = null;
  private nextRetarget = 0;
  private shown: T | null = null;
  private worst: number | null = null;
  private late = 0;

  /** A frame stamped `stamp` (arclamp's clock, ms) arrived at `now` (this browser's, ms). */
  push(stamp: number, item: T, now: number) {
    if (this.lastStamp !== null && Math.abs(stamp - this.lastStamp) > JUMP_MS) this.reset();
    // A small step back (a shader added at the end of the scene is a beat
    // behind) plays in the same slot as the frame before it.
    if (this.lastStamp !== null) stamp = Math.max(stamp, this.lastStamp);
    this.lastStamp = stamp;
    const lag = now - stamp;
    if (this.lag === null || !this.settled) {
      // Until there's a window to go on, start from the quickest frame yet,
      // so a first frame that happened to be held up doesn't set the pace.
      this.fastest = this.lag === null ? lag : Math.min(this.fastest, lag);
      this.lag = this.target = this.fastest + START_DELAY_MS;
    } else if (lag > this.lag) {
      this.late++;
    }
    this.worst = Math.max(this.worst ?? lag, lag);
    this.samples.push({ at: now, lag });
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    this.queue.push({ stamp, item });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
  }

  /** The frame to show at `now` (this browser's clock): the newest one due, or null before any is. */
  at(now: number): T | null {
    if (this.lag === null) return this.shown;
    if (this.lastAt !== null && now - this.lastAt > STALL_MS) {
      // Back from a hidden tab: show the newest at once and time afresh.
      const newest = this.queue.at(-1)?.item ?? this.shown;
      this.reset();
      return (this.shown = newest);
    }
    const dt = this.lastAt === null ? 0 : now - this.lastAt;
    this.lastAt = now;
    if (now >= this.nextRetarget) {
      this.retarget(now);
      this.nextRetarget = now + RETARGET_MS;
    }
    const d = this.target - this.lag;
    this.lag += d > 0 ? Math.min(d, GROW * dt) : Math.max(d, -SHRINK * dt);
    const due = now - this.lag;
    let i = 0;
    while (i < this.queue.length && this.queue[i]!.stamp <= due) i++;
    if (i > 0) {
      this.shown = this.queue[i - 1]!.item;
      this.queue.splice(0, i);
    }
    return this.shown;
  }

  /** For the latency readout. Counts start again from each call. */
  stats(): PlayoutStats {
    const stats = {
      delay: this.lag === null ? null : this.lag - this.fastest,
      worst: this.worst === null ? null : Math.max(0, this.worst - this.fastest),
      late: this.late,
    };
    this.worst = null;
    this.late = 0;
    return stats;
  }

  /** Forget everything (a new connection, or arclamp started over). */
  reset() {
    this.shown = null;
    this.queue = [];
    this.samples = [];
    this.lag = null;
    this.settled = false;
    this.lastStamp = null;
    this.lastAt = null;
    this.nextRetarget = 0;
  }

  private retarget(now: number) {
    let old = 0;
    while (old < this.samples.length && this.samples[old]!.at < now - WINDOW_MS) old++;
    if (old > 0) this.samples.splice(0, old);
    if (this.samples.length < MIN_SAMPLES) return;
    const lags = this.samples.map((s) => s.lag).sort((a, b) => a - b);
    this.fastest = lags[0]!;
    const covered = lags[Math.floor(PERCENTILE * (lags.length - 1))]!;
    this.target = Math.min(Math.max(covered + MARGIN_MS, this.fastest + MIN_DELAY_MS), this.fastest + MAX_DELAY_MS);
    this.settled = true;
  }
}
