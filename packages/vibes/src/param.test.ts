import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prev, PrevLight } from "./arclamp.ts";
import { osc } from "./field.ts";
import { declaredParams, param, receiveParams, setParamValues, takePacket, valueOf, type ParamPacket } from "./param.ts";
import { sketch } from "./sketch.ts";
import { white } from "./color.ts";

const g = globalThis as Record<string, unknown>;

// Declarations and values live on globalThis; each test starts afresh, without udp.
beforeEach(() => {
  delete g.__vibesParams;
  delete g.__vibesStart;
  delete g.udp;
});
afterEach(() => {
  delete g.udp;
});

const light = (id: number, mm_x = 1000 * id): PrevLight => ({ id, channels: { a: 0, b: 0, brightness: 0, fidelity: 1 }, tags: [], coords: { mm_x, mm_y: 0, floor: 1 }, rail: null });
const prev = (): Prev => ({ initial_time: 0, lights: [light(1), light(2), light(3)] });

const packet = (p: Partial<ParamPacket> & { name: string }): string => JSON.stringify({ vibes: "params", v: 1, seq: 1, ...p });
// ASCII, as the packets are; the library sees no TextEncoder.
const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

describe("param()", () => {
  it("declares a param, with a range around its default when none is given", () => {
    param("speed", 7);
    param("gain", 0.5, { min: 0, max: 1, step: 0.05, label: "Gain", perLight: false });
    expect(declaredParams()).toEqual([
      { name: "speed", default: 7, min: 0, max: 7, step: 0.07, label: "speed", perLight: true },
      { name: "gain", default: 0.5, min: 0, max: 1, step: 0.05, label: "Gain", perLight: false },
    ]);
  });

  it("refuses a name that isn't a word, and a range that isn't one", () => {
    expect(() => param("two words", 1)).toThrow(/name is a word/);
    expect(() => param("x", 1, { min: 5, max: 5 })).toThrow(/min .* below its max/);
    expect(() => param("x", Number.NaN)).toThrow(/default should be a number/);
  });

  it("is a field of each light's value: its own, else everywhere's, else the default", () => {
    const speed = param("speed", 7, { min: 0, max: 20 });
    const update = sketch((here) => white(2700, 100 * speed(here)));
    const lm = (out: ReturnType<typeof update>, id: number) => out.lights.find((l) => l.id === id)!.channels.brightness! * 1000;
    let out = update(prev(), 0, 0);
    expect(lm(out, 1)).toBeCloseTo(700);
    setParamValues("speed", { all: 3, lights: { "2": 10 } });
    out = update(prev(), 100, 100);
    expect(lm(out, 1)).toBeCloseTo(300);
    expect(lm(out, 2)).toBeCloseTo(1000);
    expect(lm(out, 3)).toBeCloseTo(300);
  });

  it("works wherever a number can depend on here", () => {
    const n = param("bands", 3, { min: 1, max: 6 });
    const f = osc(n, 0);
    const update = sketch((here) => white(2700, 100 + 100 * f(here)));
    expect(update(prev(), 0, 0).lights).toHaveLength(3);
  });

  it("keeps a value within the range, and 0 for a param that was never declared", () => {
    param("speed", 7, { min: 0, max: 10 });
    setParamValues("speed", { all: 99, lights: { "1": -5 } });
    expect(valueOf("speed", 1)).toBe(0);
    expect(valueOf("speed", 2)).toBe(10);
    expect(valueOf("nope", 2)).toBe(0);
  });

  it("takes a packet as text, bytes, or an object carrying either, and nothing else", () => {
    param("speed", 7, { min: 0, max: 20 });
    expect(takePacket(packet({ name: "speed", all: 4 }))).toBe(true);
    expect(valueOf("speed", 1)).toBe(4);
    expect(takePacket(bytes(packet({ name: "speed", seq: 2, all: 5 })))).toBe(true);
    expect(valueOf("speed", 1)).toBe(5);
    expect(takePacket({ data: packet({ name: "speed", seq: 3, lights: { "1": 6 } }) })).toBe(true);
    expect(valueOf("speed", 1)).toBe(6);
    expect(valueOf("speed", 2)).toBe(7);
    expect(takePacket("not json")).toBe(false);
    expect(takePacket(JSON.stringify({ hello: 1 }))).toBe(false);
    expect(takePacket(null)).toBe(false);
  });

  it("ignores a packet older than the last one taken, for that param", () => {
    param("speed", 7, { min: 0, max: 20 });
    expect(takePacket(packet({ name: "speed", seq: 5, all: 5 }))).toBe(true);
    expect(takePacket(packet({ name: "speed", seq: 4, all: 4 }))).toBe(false);
    expect(takePacket(packet({ name: "speed", seq: 6 }))).toBe(true);
    expect(valueOf("speed", 1)).toBe(7);
  });

  it("binds udp once anything's declared, and drains it each tick through sketch()", () => {
    const binds: unknown[] = [];
    const queue: string[] = [];
    g.udp = {
      bind(opts: unknown) {
        binds.push(opts);
        return { recv: () => queue.shift() ?? null };
      },
    };
    const speed = param("speed", 7, { min: 0, max: 20 });
    const update = sketch((here) => white(2700, 100 * speed(here)));
    update(prev(), 0, 0);
    expect(binds).toEqual([{ port: 0 }]);
    queue.push(packet({ name: "speed", all: 2 }));
    const out = update(prev(), 100, 100);
    expect(out.lights[0]!.channels.brightness).toBeCloseTo(0.2);
    update(prev(), 200, 200);
    expect(binds).toHaveLength(1);
  });

  it("uses drain() where there is one", () => {
    g.udp = { bind: () => ({ recv: () => null, drain: () => [packet({ name: "speed", all: 1 }), packet({ name: "speed", seq: 2, all: 2 })] }) };
    param("speed", 7, { min: 0, max: 20 });
    receiveParams();
    expect(valueOf("speed", 1)).toBe(2);
  });

  it("does without udp where there's none, and binds nothing when nothing's declared", () => {
    const update = sketch(() => white(2700, 100));
    expect(() => update(prev(), 0, 0)).not.toThrow();
    let bound = 0;
    g.udp = { bind: () => (bound++, { recv: () => null }) };
    update(prev(), 100, 100);
    expect(bound).toBe(0);
  });
});
