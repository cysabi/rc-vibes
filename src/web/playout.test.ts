import { describe, expect, it } from "vitest";
import { GROW, MAX_DELAY_MS, MIN_DELAY_MS, Playout, SHRINK, START_DELAY_MS } from "./playout.ts";

const BEAT = 10;
const REFRESH = 1000 / 60;
// The browser's clock is nowhere near arclamp's; nothing should care.
const OFFSET = 5_000_000;

interface Sent {
  stamp: number;
  arrival: number;
  index: number;
}

/** A frame every beat until `ms`, each `late(stamp)` after its beat, in order (as on one socket). */
function stream(ms: number, late: (stamp: number) => number, from = 0): Sent[] {
  const out: Sent[] = [];
  for (let stamp = from; stamp <= ms; stamp += BEAT) {
    const arrival = Math.max(OFFSET + stamp + late(stamp), out.at(-1)?.arrival ?? -Infinity);
    out.push({ stamp, arrival, index: out.length });
  }
  return out;
}

interface Refresh {
  now: number;
  shown: Sent | null;
  delay: number | null;
  late: number;
}

/** Plays frames through at 60 Hz from the first arrival to the last; what each refresh showed. */
function play(frames: Sent[], p = new Playout<Sent>()): Refresh[] {
  const out: Refresh[] = [];
  let i = 0;
  for (let now = frames[0]!.arrival; now <= frames.at(-1)!.arrival; now += REFRESH) {
    for (; i < frames.length && frames[i]!.arrival <= now; i++) p.push(frames[i]!.stamp, frames[i]!, frames[i]!.arrival);
    const shown = p.at(now);
    const { delay, late } = p.stats();
    out.push({ now, shown, delay, late });
  }
  return out;
}

const after = (refreshes: Refresh[], ms: number) => refreshes.filter((r) => r.now >= OFFSET + ms);
const totalLate = (refreshes: Refresh[]) => refreshes.reduce((n, r) => n + r.late, 0);

/** Each refresh moves on by one or two beats: nothing held, nothing skipped. */
function expectSteady(refreshes: Refresh[]) {
  for (let i = 1; i < refreshes.length; i++) {
    const step = refreshes[i]!.shown!.stamp - refreshes[i - 1]!.shown!.stamp;
    expect(step).toBeGreaterThanOrEqual(BEAT);
    expect(step).toBeLessThanOrEqual(2 * BEAT);
  }
}

// Frames in the first 250 ms of every 400 are held back and arrive together.
const clumpy = (stamp: number) => (stamp % 400 < 250 ? 255 - (stamp % 400) : 5);

describe("Playout", () => {
  it("settles just above a steady stream", () => {
    const r = play(stream(15_000, () => 5));
    expect(r.at(-1)!.delay).toBeCloseTo(MIN_DELAY_MS);
    expect(totalLate(r)).toBe(0);
    expectSteady(after(r, 5_000));
  });

  it("rides out clumps once the delay has grown over them", () => {
    const r = play(stream(30_000, clumpy));
    const settled = after(r, 15_000);
    expect(settled.at(-1)!.delay).toBeGreaterThan(250);
    expect(settled.at(-1)!.delay).toBeLessThanOrEqual(MAX_DELAY_MS);
    expect(totalLate(settled)).toBe(0);
    expectSteady(settled);
  });

  it("changes the delay gradually, so the map never jumps", () => {
    // Steady, then clumps from 10 s to 30 s, then steady again.
    const r = play(stream(60_000, (s) => (s >= 10_000 && s < 30_000 ? clumpy(s) : 5)));
    const delays = after(r, 1_000).map((x) => x.delay!);
    for (let i = 1; i < delays.length; i++) {
      const change = delays[i]! - delays[i - 1]!;
      expect(change).toBeLessThanOrEqual(GROW * REFRESH + 1e-6);
      expect(change).toBeGreaterThanOrEqual(-SHRINK * REFRESH - 1e-6);
    }
    expect(Math.max(...delays)).toBeGreaterThan(250);
    expect(delays.at(-1)).toBeCloseTo(MIN_DELAY_MS);
  });

  it("keeps the delay under its cap however late frames get, even from the start", () => {
    // Every other second is held back a whole second, the very first included.
    const r = play(stream(20_000, (s) => (s % 2_000 < 1_000 ? 1_005 - (s % 2_000) : 5)));
    // Give or take the few ms the quickest frame moves by, as the window does.
    for (const x of r) expect(x.delay!).toBeLessThanOrEqual(MAX_DELAY_MS + 15);
  });

  it("shows a hard cut as a hard cut", () => {
    const frames = stream(10_000, () => 5);
    const r = play(frames);
    const cut = r.findIndex((x) => x.shown && x.shown.stamp >= 5_000);
    expect(r.slice(0, cut).every((x) => !x.shown || x.shown.stamp < 5_000)).toBe(true);
    expect(r.slice(cut).every((x) => x.shown!.stamp >= 5_000)).toBe(true);
    // ...at its beat plus the delay, to within a refresh.
    expect(Math.abs(r[cut]!.now - (OFFSET + 5_000 + 5 + MIN_DELAY_MS))).toBeLessThanOrEqual(REFRESH);
  });

  it("never goes back to an older frame", () => {
    // A shader added at the end of the scene: its frames are a beat behind.
    const frames = [...stream(3_000, () => 5), ...stream(6_000, () => 15, 2_990)].map((f, index) => ({ ...f, index }));
    const r = play(frames);
    const shown = r.filter((x) => x.shown).map((x) => x.shown!.index);
    for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1]!);
    // ...and that's no reason to start the delay over.
    expect(Math.min(...after(r, 3_100).map((x) => x.delay!))).toBeLessThan(START_DELAY_MS);
  });

  it("starts over when arclamp's clock jumps", () => {
    const p = new Playout<number>();
    for (let s = 0; s <= 5_000; s += BEAT) {
      p.push(s, s, OFFSET + s + 5);
      p.at(OFFSET + s + 5);
    }
    expect(p.stats().delay).toBeLessThan(START_DELAY_MS);
    p.push(900_000, 900_000, OFFSET + 5_015);
    expect(p.stats().delay).toBe(START_DELAY_MS);
    expect(p.at(OFFSET + 5_015)).toBeNull(); // nothing from the new clock is due yet
  });

  it("catches up at once after a tab was hidden", () => {
    const p = new Playout<number>();
    for (let s = 0; s <= 10_000; s += BEAT) {
      p.push(s, s, OFFSET + s + 5);
      if (s <= 3_000) p.at(OFFSET + s + 5); // no refreshes after 3 s
    }
    expect(p.at(OFFSET + 10_005)).toBe(10_000);
  });

  it("counts frames that arrive after they were due", () => {
    // Steady, then one hiccup at 8 s holds 300 ms of frames back.
    const r = play(stream(15_000, (s) => (s >= 8_000 && s < 8_300 ? 8_305 - s : 5)));
    expect(totalLate(r.filter((x) => x.now < OFFSET + 8_000))).toBe(0);
    expect(totalLate(r)).toBeGreaterThan(0);
    expect(totalLate(after(r, 8_400))).toBe(0);
  });
});
