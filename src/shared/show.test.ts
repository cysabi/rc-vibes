import { describe, expect, it } from "vitest";
import { BEATS_PER_BAR, beatAt, RESTING_BPM, restingClock, tappedBpm, timeAt, transported, type ShowClock, type TransportAction } from "./show.ts";

const T = 1_800_000_000_000;
const playing: ShowClock = { playing: true, at: T, t: 10, bpm: 120, beat: 8, nudge: 0 };
// Stopped at 0, with no tempo (a clock saved before there was a resting one).
const STOPPED: ShowClock = { playing: false, at: 0, t: 0, bpm: null, beat: null, nudge: 0 };
const run = (c: ShowClock, ...actions: TransportAction[]) => actions.reduce(transported, c);

describe("the resting clock", () => {
  it("plays from where it's anchored, at the resting tempo, on one grid whenever it was anchored", () => {
    const a = restingClock(T);
    expect(a).toMatchObject({ playing: true, t: 0, bpm: RESTING_BPM });
    expect(timeAt(a, T + 1500)).toBeCloseTo(1.5, 9);
    const b = restingClock(T + 12_345);
    expect(beatAt(b, T + 60_000)).toBeCloseTo(beatAt(a, T + 60_000), 4);
    // From 1970: T is a whole bar.
    expect(beatAt(a, T) % BEATS_PER_BAR).toBeCloseTo(0, 4);
  });

  it("is on the grid moved by the nudge", () => {
    const c = restingClock(T - 200, 200);
    expect(beatAt(c, T + 200)).toBeCloseTo(beatAt(restingClock(T), T), 4);
  });
});

describe("a show, started and ended", () => {
  it("starts at 0:00, stopped, the beat going on as it was", () => {
    const resting = restingClock(T);
    const started = run(resting, { do: "start", at: T + 3000 });
    expect(started).toMatchObject({ playing: false, t: 0, bpm: RESTING_BPM });
    expect(timeAt(started, T + 9000)).toBe(0);
    expect(beatAt(started, T + 9000)).toBeCloseTo(beatAt(resting, T + 9000), 4);
  });

  it("ends resting, from then, the nudge kept", () => {
    const show = run(playing, { do: "nudge", ms: 40 }, { do: "tempo", at: T + 1000, bpm: 97 });
    const ended = run(show, { do: "end", at: T + 5000 });
    expect(ended).toEqual(restingClock(T + 5000 - 40, 40));
    expect(timeAt(ended, T + 6000)).toBeCloseTo(1, 9);
  });
});

describe("the show clock, acted on", () => {
  it("plays from where it stopped, and stops where it's got to", () => {
    const going = run(STOPPED, { do: "play", at: T });
    expect(timeAt(going, T + 2500)).toBeCloseTo(2.5, 9);
    const stopped = run(going, { do: "stop", at: T + 2500 });
    expect(timeAt(stopped, T + 9000)).toBeCloseTo(2.5, 9);
    expect(timeAt(run(stopped, { do: "play", at: T + 9000 }), T + 10_000)).toBeCloseTo(3.5, 9);
  });

  it("seeks, playing on from there", () => {
    const c = run(playing, { do: "seek", at: T + 1000, t: 0 });
    expect(timeAt(c, T + 1000)).toBe(0);
    expect(timeAt(c, T + 3000)).toBeCloseTo(2, 9);
  });

  it("changes tempo without a jump in the beats; a tap's lands on a whole one", () => {
    const at = T + 1000;
    expect(beatAt(playing, at)).toBeCloseTo(10, 9);
    const slower = run(playing, { do: "tempo", at: at + 125, bpm: 60 });
    expect(beatAt(slower, at + 125)).toBeCloseTo(10.25, 9);
    expect(beatAt(slower, at + 1125)).toBeCloseTo(11.25, 9);
    const tapped = run(playing, { do: "tempo", at: at + 125, bpm: 90, onBeat: true });
    expect(beatAt(tapped, at + 125)).toBe(10);
    // The first tempo ever starts counting at the tap: a downbeat.
    const first = run(STOPPED, { do: "tempo", at: T, bpm: 100, onBeat: true });
    expect(beatAt(first, T)).toBe(0);
    expect(beatAt(first, T + 600)).toBeCloseTo(1, 9);
  });

  it("syncs a bar's first beat to now, keeping the tempo; without one, nothing", () => {
    // 10.75 beats in: the nearest bar starts at 12.
    const synced = run(playing, { do: "downbeat", at: T + 1375 });
    expect(beatAt(synced, T + 1375)).toBe(12);
    expect(synced.bpm).toBe(120);
    expect(run(STOPPED, { do: "downbeat", at: T })).toEqual({ ...STOPPED, at: T });
  });

  it("is nudged without moving the anchor; acting after a nudge carries on where it is", () => {
    const nudged = run(playing, { do: "nudge", ms: 250 });
    expect(beatAt(nudged, T + 1000)).toBeCloseTo(9.5, 9);
    const tempo = run(nudged, { do: "tempo", at: T + 1000, bpm: 60 });
    expect(beatAt(tempo, T + 1000)).toBeCloseTo(9.5, 9);
    expect(beatAt(tempo, T + 2000)).toBeCloseTo(10.5, 9);
  });

  it("never anchors before where it's anchored: an action that comes late is made as of then", () => {
    const late = run(playing, { do: "stop", at: T - 5000 });
    expect(late.at).toBe(T);
    expect(timeAt(late, T + 9999)).toBe(10);
  });
});

describe("tapped tempo", () => {
  it("is the middle of the gaps between taps, once there are three", () => {
    expect(tappedBpm([0, 500])).toBeNull();
    expect(tappedBpm([0, 500, 1000])).toBe(120);
    // One slip doesn't move it.
    expect(tappedBpm([0, 500, 1000, 1700, 2200, 2700])).toBe(120);
    expect(tappedBpm([0, 10_000, 20_000])).toBeNull();
  });
});
