import { describe, expect, it } from "vitest";
import { Here, roomOf } from "./here.ts";
import { clock } from "./signal.ts";

const room = roomOf({ initial_time: 0, lights: [{ id: 1, channels: { on: 0 }, coords: { mm_x: 0, mm_y: 0, floor: 4 } }] });
const at = (t: number) => new Here(0, 0, t, 0, 0, room.lights[0]!, room);

describe("clocks", () => {
  it("count beats", () => {
    const c = clock(120);
    expect(c.beats(at(1.25))).toBeCloseTo(2.5, 12);
    const bar = c.every(4);
    expect(bar.count(at(1.9))).toBe(0);
    expect(bar.count(at(2.1))).toBe(1);
    expect(bar.ramp(at(3))).toBeCloseTo(0.5, 12);
    expect(bar.since(at(3))).toBeCloseTo(1, 12);
  });

  it("flash on each mark", () => {
    const env = clock(60).every(1).env({ attack: 0.1, release: 0.4 });
    expect(env(at(0))).toBe(0);
    expect(env(at(0.05))).toBeCloseTo(0.5, 12);
    expect(env(at(0.1))).toBeCloseTo(1, 12);
    expect(env(at(0.3))).toBeCloseTo(0.25, 12);
    expect(env(at(0.5))).toBe(0);
    expect(env(at(0.9))).toBe(0);
    expect(env(at(1.1))).toBeCloseTo(1, 9);
  });

  it("step through a sequence, round and round", () => {
    const s = clock(60).every(2).seq(["a", "b", "c"]);
    expect([0, 2.1, 4.5, 6.5, -0.5].map((t) => s(at(t)))).toEqual(["a", "b", "c", "a", "c"]);
    expect(() => clock(60).every(1).seq([])).toThrow();
  });
});
