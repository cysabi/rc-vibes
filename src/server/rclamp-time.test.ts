import { describe, expect, it } from "vitest";
import { createRclampTime } from "./rclamp-time.ts";

/** A clock vibes reads, moved by hand, and an arclamp `ahead` of it whose answers take the given round trips. */
function rig(ahead: number, trips: (number | "down")[]) {
  let now = 1_000_000;
  const arclamp = {
    async time() {
      const trip = trips.shift() ?? 5;
      if (trip === "down") throw new Error("unreachable");
      now += trip / 2;
      const r = now + ahead;
      now += trip / 2;
      return { now_ms: r };
    },
  };
  const rtime = createRclampTime({ arclamp, now: () => now, tries: 4, gapMs: 0 });
  return { rtime, advance: (ms: number) => (now += ms), at: () => now };
}

describe("arclamp's time", () => {
  it("is vibes' own till arclamp's answered, with no idea how far off", () => {
    const { rtime, at } = rig(55, []);
    expect(rtime.rNow()).toBe(at());
    expect(rtime.state()).toEqual({ offset: null, error: null, age: null });
  });

  it("is as the quickest of a round's tries says, off by at most half its round trip", async () => {
    const { rtime, at } = rig(55.25, [40, 8, 90, 12]);
    await rtime.round();
    expect(rtime.state()).toEqual({ offset: 55.25, error: 4, age: 0 });
    expect(rtime.rNow()).toBeCloseTo(at() + 55.25, 9);
  });

  it("keeps the last round's when arclamp stops answering, getting older", async () => {
    const { rtime, advance } = rig(20, [6, 6, 6, 6, "down", "down", "down", "down"]);
    await rtime.round();
    advance(30_000);
    await rtime.round();
    expect(rtime.state()).toMatchObject({ offset: 20, error: 3, age: 30_000 });
  });

  it("takes only the latest round: a slower answer now beats a quicker one from before", async () => {
    const { rtime } = rig(10, [2, 2, 2, 2, 30, 30, 30, 30]);
    await rtime.round();
    expect(rtime.state().error).toBe(1);
    await rtime.round();
    expect(rtime.state().error).toBe(15);
  });
});
