import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prev, PrevLight } from "./arclamp.ts";
import { lemtone, palettes, white, type ColorInput } from "./color.ts";
import { field, osc } from "./field.ts";
import type { Here } from "./here.ts";
import { square } from "./shape.ts";
import { sketch } from "./sketch.ts";

afterEach(() => vi.restoreAllMocks());

// The library sees no DOM or Node, so no console type either; vitest's is there all the same.
const { console } = globalThis as unknown as { console: { warn(...data: unknown[]): void } };

const color = (id: number, mm_x: number, mm_y: number, extra: Partial<PrevLight> = {}): PrevLight => ({
  id,
  channels: { a: 0, b: 0, brightness: 0, fidelity: 1 },
  tags: [],
  coords: { mm_x, mm_y, floor: 4 },
  rail: null,
  ...extra,
});

// Two bulbs and an old bulb on a rail, a panel off it, and a light not yet placed.
const lights = (): PrevLight[] => [
  color(1, 2000, 1000, { rail: { id: "r", mm_along: 2000 } }),
  color(2, 4000, 1000, { rail: { id: "r", mm_along: 0 }, tags: ["window"] }),
  { ...color(3, 3000, 1000, { rail: { id: "r", mm_along: 1000 } }), channels: { on: 0 } },
  color(4, 12000, 5000),
  color(5, 0, 0, { coords: null }),
];
const prevOf = (list = lights()): Prev => ({ initial_time: 0, lights: list });

/** Runs a look once, at nowMs, and says what each light saw and was given. */
function once(look: (here: Here) => ColorInput | null | undefined, list = lights()) {
  const seen = new Map<number, Here>();
  const update = sketch({ color: (here) => (seen.set(here.light.id, here), look(here)), on: (here) => (seen.set(here.light.id, here), null) });
  const out = update(prevOf(list), 5000, 1000);
  return { seen, out };
}

describe("sketch()", () => {
  it("gives color lights lemtone channels, in thousands of lumens", () => {
    const c = lemtone(40, 0.2, 250);
    const { out } = once(() => c);
    expect(out.lights.find((l) => l.id === 1)!.channels).toEqual({ a: c.a, b: c.b, brightness: 0.25, fidelity: 1 });
    expect(out.lights).toHaveLength(4);
  });

  it("never switches old bulbs by color: they have a look of their own", () => {
    const asked: number[] = [];
    const update = sketch((here) => (asked.push(here.light.id), white(2700, 900)));
    const out = update(prevOf(), 0, 0);
    expect(asked).not.toContain(3);
    expect(out.lights.map((l) => l.id)).toEqual([1, 2, 4, 5]);
    expect(sketch(palettes.dusk)(prevOf(), 0, 0).lights.map((l) => l.id)).not.toContain(3);
  });

  it("switches old bulbs by their on look, however it says it", () => {
    const onOf = (on: unknown) => {
      const lights = sketch({ on: () => on as never })(prevOf(), 0, 0).lights;
      return lights.find((l) => l.id === 3)?.channels.on;
    };
    expect([true, false, 1, 0, 0.5, 0.49, "on", "off", " ON ", "yes", "no", "1", "0", { on: 1 }, { on: false }].map(onOf)).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0]);
    expect(onOf(null)).toBeUndefined();
    expect(onOf(undefined)).toBeUndefined();
  });

  it("takes the on look as a function, a field, or one answer for every old bulb", () => {
    const onOfThree = (update: ReturnType<typeof sketch>, now = 0) => update(prevOf(), now, 0).lights.find((l) => l.id === 3)?.channels.on;
    expect(onOfThree(sketch({ on: true }))).toBe(1);
    expect(onOfThree(sketch({ on: "off" }))).toBe(0);
    expect(onOfThree(sketch("#f80", { on: 1 }))).toBe(1);
    expect(onOfThree(sketch({ on: ({ light }) => light.rail?.index === 1 }))).toBe(1);
    // A field: on for the first half of every two seconds.
    const blink = sketch({ on: field(({ t }) => square(t / 2)) });
    expect([0, 500, 1500, 2500].map((now) => onOfThree(blink, now))).toEqual([1, 1, 0, 1]);
    // Only the old bulbs are touched.
    expect(sketch({ on: true })(prevOf(), 0, 0).lights.map((l) => l.id)).toEqual([3]);
    expect(() => sketch({ on: "sometimes" })).toThrow(/isn't on or off/);
  });

  it("says once when an old bulb is given something it can't switch by", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const update = sketch({ on: () => white(2700, 800) as never });
    expect(update(prevOf(), 0, 0).lights).toEqual([]);
    update(prevOf(), 10, 0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/old bulb.*sketch\(\{ color, on \}\)/);
  });

  it("takes anything that says a color, from the look or as the look", () => {
    const orange = lemtone(0, 0, 0).mix("#ff8800", 1);
    const channelsOf = (look: Parameters<typeof sketch>[0]) => sketch(look)(prevOf(), 0, 0).lights.find((l) => l.id === 1)!.channels;
    for (const look of ["#ff8800", "rgb(255 136 0)", [1, 136 / 255, 0], { r: 255, g: 136, b: 0 }, () => "#f80", () => orange]) {
      const ch = channelsOf(look as Parameters<typeof sketch>[0]);
      expect(ch.a).toBeCloseTo(orange.a, 3);
      expect(ch.brightness).toBeCloseTo(orange.brightness, 3);
    }
    expect(channelsOf(2700).a).toBeCloseTo(white(2700).a, 9);
    expect(sketch(() => false)(prevOf(), 0, 0).lights).toEqual([]);
    // A palette as the look is laid across the room, left to right.
    const across = sketch(palettes.dusk)(prevOf(), 0, 0).lights;
    expect(across.find((l) => l.id === 1)!.channels.brightness).toBeCloseTo(palettes.dusk(0).brightness, 9);
    expect(across.find((l) => l.id === 4)!.channels.brightness).toBeCloseTo(palettes.dusk(1).brightness, 9);
    // One color said wrong is an error now, not every tick.
    expect(() => sketch("blurple")).toThrow(/isn't a color/);
  });

  it("leaves a light alone when it isn't given a color, saying why once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const update = sketch((here) => (here.light.id === 1 ? 0.5 : here.light.id === 2 ? "blurple" : null));
    expect(update(prevOf(), 0, 0).lights).toEqual([]);
    update(prevOf(), 10, 0);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]![0])).toMatch(/kelvin.*\.color\(palettes\.dusk\)/);
    expect(String(warn.mock.calls[1]![0])).toMatch(/blurple/);
  });

  it("reads what arclamp sends leniently", () => {
    const odd: PrevLight[] = [
      { id: 1, channels: undefined as never, coords: "" as never, tags: null },
      { id: 2, channels: { a: 0, b: 0, brightness: 0, fidelity: 1 }, coords: { mm_x: 1000, mm_y: 1000, floor: 4 }, tags: "x" as never, rail: { id: "r" } as never },
    ];
    const seen: Here[] = [];
    const update = sketch((here) => (seen.push(here), "#fff"));
    expect(update({ initial_time: 0, lights: odd }, 0, 0).lights).toHaveLength(2);
    expect(seen[0]!.light.placed).toBe(false);
    expect(seen[1]!.light.rail).toBeNull();
    expect(seen[1]!.light.tags).toEqual([]);
    expect(sketch(() => "#fff")({ initial_time: 0 } as never, 0, 0).lights).toEqual([]);
  });

  it("leaves a light as it is below when the look gives nothing", () => {
    const { out } = once((here) => (here.light.id === 2 ? white(2700, 10) : null));
    expect(out.lights.map((l) => l.id)).toEqual([2]);
  });

  it("leaves out colors that aren't all numbers, and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const update = sketch((here) => (here.light.id === 4 ? lemtone(30, 0.2, NaN) : here.light.id === 1 ? white(2700, NaN) : null));
    expect(update(prevOf(), 0, 0).lights).toEqual([]);
    expect(update(prevOf(), 10, 0).lights).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("tells the look where and when it is", () => {
    const { seen } = once(() => null);
    const here = seen.get(4)!;
    expect(here.t).toBe(4);
    expect(here.now).toBe(5000);
    expect(here.dt).toBe(0);
    expect([here.x, here.y]).toEqual([12, 5]);
    // The room the lights fill: 2 to 12 m across, 1 to 5 m down.
    expect([here.u, here.v]).toEqual([1, 1]);
    expect(seen.get(1)!.u).toBe(0);
    expect(here.room.center).toEqual({ x: 7, y: 3 });
    const unplaced = seen.get(5)!;
    expect(unplaced.light.placed).toBe(false);
    expect([unplaced.x, unplaced.y]).toEqual([7, 3]);
  });

  it("counts dt from tick to tick, but not a long gap", () => {
    const dts: number[] = [];
    const update = sketch((here) => (here.light.id === 1 && dts.push(here.dt), null));
    for (const now of [0, 10, 40, 5040]) update(prevOf(), now, 0);
    expect(dts).toEqual([0, 0.01, 0.03, 0.25]);
  });

  it("knows each light: its kind, tags, rail, and its own random number", () => {
    const { seen } = once(() => null);
    const [one, two, old, panel] = [1, 2, 3, 4].map((id) => seen.get(id)!.light);
    expect(old!.kind).toBe("switch");
    expect(panel!.kind).toBe("color");
    expect(two!.has("window")).toBe(true);
    expect(panel!.rail).toBeNull();
    expect(two!.rail).toEqual({ id: "r", along: 0, t: 0, index: 0, count: 3 });
    expect(one!.rail).toEqual({ id: "r", along: 2, t: 1, index: 2, count: 3 });
    expect(seen.get(1)!.room.rail("r")!.lights.map((l) => l.id)).toEqual([2, 3, 1]);
    expect(one!.random).not.toBe(two!.random);
    expect(once(() => null).seen.get(1)!.light.random).toBe(one!.random);
  });

  it("shows the look what's below", () => {
    const list = lights();
    list[0]!.channels = { a: 0.1, b: 0.05, brightness: 0.3, fidelity: 0 };
    list[2]!.channels = { on: 1 };
    const { seen } = once(() => null, list);
    expect(seen.get(1)!.light.below).toEqual({ a: 0.1, b: 0.05, lm: 300, fidelity: 0 });
    expect(seen.get(1)!.light.belowOn).toBe(true);
    expect(seen.get(2)!.light.belowOn).toBe(false);
    expect(seen.get(3)!.light.below.lm).toBe(800);
    expect(seen.get(3)!.light.belowOn).toBe(true);
  });

  it("keeps each light's memory, even when lights move", () => {
    const update = sketch((here) => {
      here.light.state.n = (here.light.state.n ?? 0) + 1;
      return white(2700, here.light.state.n);
    });
    update(prevOf(), 0, 0);
    update(prevOf(), 10, 0);
    const moved = lights();
    moved[0]!.coords = { mm_x: 9000, mm_y: 9000, floor: 4 };
    const out = update(prevOf(moved), 20, 0);
    expect(out.lights.find((l) => l.id === 1)!.channels.brightness).toBeCloseTo(0.003, 12);
  });

  it("makes the room once, and again only when the lights change", () => {
    const rooms = new Set<unknown>();
    const update = sketch((here) => (rooms.add(here.room), null));
    // arclamp gives every tick its own fresh objects.
    update(prevOf(), 0, 0);
    update(prevOf(), 10, 0);
    expect(rooms.size).toBe(1);
    const tagged = lights();
    tagged[3]!.tags = ["stage"];
    update(prevOf(tagged), 20, 0);
    expect(rooms.size).toBe(2);
  });

  it("takes a field as it is", () => {
    const update = sketch(osc(3, 0).color((v) => white(2700, 100 * v)));
    const out = update(prevOf(), 0, 0);
    expect(out.lights).toHaveLength(4);
  });
});
