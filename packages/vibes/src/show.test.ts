import { beforeEach, describe, expect, it, vi } from "vitest";
import { Here, roomOf } from "./here.ts";
import type { VibesHost } from "./param.ts";
import { beatAt, RESTING_BPM, restingClock, showClock, timeAt, type ShowClock } from "./wire.ts";

const g = globalThis as Record<string, unknown>;
const room = roomOf({ initial_time: 0, lights: [{ id: 1, channels: { on: 0 }, coords: { mm_x: 0, mm_y: 0, floor: 4 } }] });
// A light at a frame's time (ms since 1970, arclamp's): what show reads.
const at = (now: number) => new Here(0, 0, 0, 0, now, room.lights[0]!, room);

async function load() {
  vi.resetModules();
  const { show } = await import("./show.ts");
  return { show, host: g.__vibes as VibesHost };
}

beforeEach(() => {
  delete g.__vibesParams;
  delete g.__vibes;
});

const T = 1_800_000_000_000;
const clock = (c: Partial<ShowClock> = {}): ShowClock => ({ playing: true, at: T, t: 10, bpm: 120, beat: 8, nudge: 0, ...c });

describe("the show clock, as the wire has it", () => {
  it("runs on from its anchor: the piece while it plays, the beat whether or not", () => {
    expect(timeAt(clock(), T + 1500)).toBeCloseTo(11.5, 9);
    expect(timeAt(clock({ playing: false }), T + 1500)).toBe(10);
    expect(beatAt(clock(), T + 1500)).toBeCloseTo(11, 9);
    expect(beatAt(clock({ playing: false }), T + 1500)).toBeCloseTo(11, 9);
    // No tempo, no beats.
    expect(beatAt(clock({ bpm: null, beat: null }), T + 1500)).toBe(0);
  });

  it("is nudged later (or earlier) for a room that hears the sound late", () => {
    expect(beatAt(clock({ nudge: 250 }), T + 1500)).toBeCloseTo(10.5, 9);
    expect(timeAt(clock({ nudge: -500 }), T)).toBeCloseTo(10.5, 9);
  });

  it("is only a clock if it says one", () => {
    expect(showClock(clock())).toEqual(clock());
    expect(showClock({ playing: true, at: T, t: 0 })).toEqual({ playing: true, at: T, t: 0, bpm: null, beat: null, nudge: 0 });
    expect(showClock({ ...clock(), bpm: 0 })).toMatchObject({ bpm: null, beat: null });
    expect(showClock({ ...clock(), at: "now" })).toBeNull();
    expect(showClock(null)).toBeNull();
  });
});

describe("show", () => {
  it("rests till vibes says otherwise: playing, at 120, on the grid from 1970, the piece from the sketch's start", async () => {
    const { show } = await load();
    const here = new Here(0, 0, 7.5, 0, T + 250, room.lights[0]!, room);
    expect(show.time(here)).toBe(7.5);
    expect(show.playing(here)).toBe(true);
    expect(show.bpm(here)).toBe(RESTING_BPM);
    expect(show.clock.bpm).toBe(RESTING_BPM);
    // T is a whole bar from 1970; a quarter second on, half a beat.
    expect(show.beat(here) % 4).toBeCloseTo(0.5, 4);
    expect(show.bar(at(T + 2000)) % 1).toBeCloseTo(0, 4);
    // Where vibes' resting clock is, whenever it began.
    expect(show.beat(here)).toBeCloseTo(beatAt(restingClock(T - 5000), T + 250), 4);
    expect(show.clock.every(1).env({ attack: 0.01, release: 0.3 })(at(T + 10))).toBeCloseTo(1, 4);
  });

  it("reads the clock vibes sends at each frame's own time", async () => {
    const { show, host } = await load();
    expect(host.apply("clock", { v: 1, clock: clock() })).toBe(true);
    expect(show.time(at(T + 500))).toBeCloseTo(10.5, 9);
    expect(show.playing(at(T))).toBe(true);
    expect(show.beat(at(T + 500))).toBeCloseTo(9, 9);
    expect(show.bar(at(T + 500))).toBeCloseTo(2.25, 9);
    expect(show.bpm(at(T))).toBe(120);
    // As a clock: a flash on each of the room's beats, a new value each bar.
    const flash = show.clock.every(1).env({ attack: 0.01, release: 0.3 });
    expect(flash(at(T + 505))).toBeCloseTo(0.5, 6);
    expect(flash(at(T + 510))).toBeCloseTo(1, 6);
    expect(flash(at(T + 750))).toBeCloseTo(0.04, 6);
    expect(show.clock.every(4).seq(["a", "b", "c"])(at(T + 2000))).toBe("a");
    expect(show.clock.bpm).toBe(120);
    // Not a clock: kept as it was.
    expect(host.apply("clock", { v: 1, clock: { playing: "yes" } })).toBe(false);
    expect(show.bpm(at(T))).toBe(120);
  });

  it("keeps the clock for the next script in the sandbox", async () => {
    const first = await load();
    first.host.apply("clock", { v: 1, clock: clock({ playing: false, t: 42 }) });
    const { show } = await load();
    expect(show.time(at(T + 9999))).toBe(42);
  });
});
