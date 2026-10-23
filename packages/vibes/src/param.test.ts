import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prev, PrevLight } from "./arclamp.ts";
import type { VibesHost } from "./param.ts";

const g = globalThis as Record<string, unknown>;

// Each test loads the library afresh, as a new script would: declarations
// are the script's, while what's on globalThis (values, the link) outlives it.
async function load() {
  vi.resetModules();
  const param = await import("./param.ts");
  const { sketch } = await import("./sketch.ts");
  const { white, color } = await import("./color.ts");
  const { osc } = await import("./field.ts");
  return { ...param, sketch, white, color, osc, host: g.__vibes as VibesHost };
}

beforeEach(() => {
  delete g.__vibesParams;
  delete g.__vibes;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const colorLight = (id: number, tags: string[] = []): PrevLight => ({ id, channels: { a: 0, b: 0, brightness: 0, fidelity: 1 }, tags, coords: { mm_x: 1000 * id, mm_y: 0, floor: 1 }, rail: null });
const switchLight = (id: number, tags: string[] = []): PrevLight => ({ id, channels: { on: 0 }, tags, coords: { mm_x: 1000 * id, mm_y: 0, floor: 1 }, rail: null });
const prev = (...lights: PrevLight[]): Prev => ({ initial_time: 0, lights });
const room = () => prev(colorLight(1), colorLight(2, ["rail"]), switchLight(3));

describe("param()", () => {
  it("takes its kind from its default, and says what it's for", async () => {
    const { param, host } = await load();
    param("speed", 7);
    param("gain", 0.5, { min: 0, max: 1, step: 0.05, label: "Gain", lights: { tags: "rail" } });
    param("tint", "#ff8800");
    param("on", false, { lights: "switch" });
    const [speed, gain, tint, on] = host.params();
    expect(speed).toEqual({ kind: "number", name: "speed", label: "speed", lights: {}, default: 7, min: 0, max: 7, step: 0.07 });
    expect(gain).toEqual({ kind: "number", name: "gain", label: "Gain", lights: { tags: ["rail"] }, default: 0.5, min: 0, max: 1, step: 0.05 });
    expect(tint).toMatchObject({ kind: "color", name: "tint", lights: { kinds: ["color"] } });
    expect(Object.keys(tint!.default as object).sort()).toEqual(["a", "b", "fidelity", "lm"]);
    expect(on).toEqual({ kind: "toggle", name: "on", label: "on", lights: { kinds: ["switch"] }, default: false });
  });

  it("reads lights given as a kind, kinds, or { kinds, tags, ids }, each one or a list", async () => {
    const { param, host } = await load();
    param("a", 1, { lights: ["color", "switch"] });
    param("b", 1, { lights: { kinds: "switch", tags: ["rail", "desk"], ids: 4 } });
    param("c", 1, { lights: { kinds: [], tags: [] } });
    expect(host.params().map((p) => p.lights)).toEqual([{ kinds: ["color", "switch"] }, { kinds: ["switch"], tags: ["rail", "desk"], ids: [4] }, {}]);
  });

  it("refuses what can't be a param, saying why", async () => {
    const { param } = await load();
    expect(() => param("two words", 1)).toThrow(/name is a word/);
    expect(() => param("x", 1, { min: 5, max: 5 })).toThrow(/min should be a number below its max/);
    expect(() => param("x", "#f80", { lights: "switch" })).toThrow(/a color is for color lights/);
    expect(() => param("x", 1, { lights: "bulb" })).toThrow(/"color" or "switch", not "bulb"/);
    expect(() => param("x", "not a color" as string)).toThrow(/default should be a number, true or false, or a color/);
  });

  it("is a field of each light's value, the default until one's set", async () => {
    const { param, sketch, white, host } = await load();
    const lm = param("lm", 100, { min: 0, max: 1000 });
    const update = sketch((here) => white(2700, lm(here)));
    const read = (id: number) => update(room(), 0, 0).lights.find((l) => l.id === id)!.channels.brightness! * 1000;
    expect(read(1)).toBeCloseTo(100);
    host.apply("state", { v: 1, values: { lm: [[400, [1]], [9999, [2]]] } });
    expect(read(1)).toBeCloseTo(400);
    // Kept within its range.
    expect(read(2)).toBeCloseTo(1000);
    host.apply("change", { name: "lm", set: [[250, [2]], [null, [1]]] });
    expect(read(1)).toBeCloseTo(100);
    expect(read(2)).toBeCloseTo(250);
  });

  it("gives the default on a light it isn't for, whatever's sent", async () => {
    const { param, sketch, white, host } = await load();
    const lm = param("lm", 100, { min: 0, max: 1000, lights: { tags: "rail" } });
    const update = sketch((here) => white(2700, lm(here)));
    host.apply("state", { v: 1, values: { lm: [[500, [1, 2]]] } });
    const out = update(room(), 0, 0);
    expect(out.lights.find((l) => l.id === 1)!.channels.brightness! * 1000).toBeCloseTo(100);
    expect(out.lights.find((l) => l.id === 2)!.channels.brightness! * 1000).toBeCloseTo(500);
  });

  it("gives colors as Colors, and toggles that switch old bulbs", async () => {
    const { param, sketch, color, host } = await load();
    const tint = param("tint", { a: 0, b: 0, lm: 300 });
    const on = param("on", false, { lights: "switch" });
    const update = sketch({ color: tint, switch: on });
    const red = color("#ff0000").at(500).toJSON();
    host.apply("state", { v: 1, values: { tint: [[red, [2]]], on: [[true, [3]]] } });
    const out = update(room(), 0, 0);
    const at = (id: number) => out.lights.find((l) => l.id === id)!.channels;
    expect(at(1).brightness! * 1000).toBeCloseTo(300);
    expect(at(2).a).toBeCloseTo(red.a);
    expect(at(2).brightness! * 1000).toBeCloseTo(500);
    expect(at(3).on).toBe(1);
  });

  it("passes over values that aren't the param's kind, and changes to params it doesn't have", async () => {
    const { param, host } = await load();
    const n = param("n", 1, { min: 0, max: 10 });
    expect(host.apply("change", { name: "nope", set: [[1, [1]]] })).toBe(false);
    expect(host.apply("change", { name: "n", set: [["loud", [1]], [true, [1]]] })).toBe(true);
    expect(n({ light: { id: 1, kind: "color", tags: [] } } as never)).toBe(1);
  });

  it("keeps the values, and not the declarations, through a new script", async () => {
    const first = await load();
    first.param("old", 1);
    first.host.apply("state", { v: 1, values: { lm: [[400, [1]]] } });
    const second = await load();
    const lm = second.param("lm", 100, { min: 0, max: 1000 });
    expect(second.host.params().map((p) => p.name)).toEqual(["lm"]);
    expect(lm({ light: { id: 1, kind: "color", tags: [] } } as never)).toBe(400);
  });
});

// The library sees no DOM or Node; the test uses Node's own, typed here.
interface Controller {
  enqueue(chunk: Uint8Array): void;
  close(): void;
  error(err: unknown): void;
}
const { ReadableStream, TextEncoder, setTimeout } = globalThis as unknown as {
  ReadableStream: new (source: { start(c: Controller): void }) => unknown;
  TextEncoder: new () => { encode(text: string): Uint8Array };
  setTimeout: (fn: () => void, ms: number) => unknown;
};

/** A stand-in for vibes: each fetch answered with a stream the test writes to. */
function fakeVibes() {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string; signal: { addEventListener(type: string, fn: () => void): void } } }[] = [];
  const streams: Controller[] = [];
  let status = 200;
  const fetch = vi.fn(async (url: string, init: (typeof calls)[number]["init"]) => {
    calls.push({ url, init });
    if (status !== 200) return { ok: false, status, body: null };
    const body = new ReadableStream({
      start: (c) => {
        streams.push(c);
        init.signal.addEventListener("abort", () => {
          try {
            c.error(new Error("aborted"));
          } catch {
            // Closed already.
          }
        });
      },
    });
    return { ok: true, status: 200, body };
  });
  vi.stubGlobal("fetch", fetch);
  const encoder = new TextEncoder();
  return {
    calls,
    answer: (code: number) => (status = code),
    send: (text: string, stream = streams.length - 1) => streams[stream]!.enqueue(encoder.encode(text)),
    close: (stream = streams.length - 1) => streams[stream]!.close(),
    get open() {
      return streams.length;
    },
  };
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("the stream to vibes", () => {
  it("opens when vibes links the sandbox, saying what's declared, and takes the events in order", async () => {
    const vibes = fakeVibes();
    const { param, host } = await load();
    const lm = param("lm", 100, { min: 0, max: 1000 });
    expect(host.connect({ v: 1, url: "https://vibes.test/shader-api/params", token: "t0k" })).toEqual({ v: 1, params: 1 });
    await settle();
    expect(vibes.calls).toHaveLength(1);
    const { url, init } = vibes.calls[0]!;
    expect(url).toBe("https://vibes.test/shader-api/params");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer t0k");
    expect(JSON.parse(init.body)).toEqual({ v: 1, params: host.params() });

    // An event split across chunks, a keep-alive, and a change.
    vibes.send('event: state\ndata: {"v":1,"values":{"lm":[[4');
    vibes.send('00,[1]]]}}\n\n: keep-alive\n\nevent: change\ndata: {"name":"lm","set":[[700,[1]]]}\n\n');
    await settle();
    expect(lm({ light: { id: 1, kind: "color", tags: [] } } as never)).toBe(700);
  });

  it("opens again after a break, waiting longer each time, and starts from the state sent again", async () => {
    vi.useFakeTimers();
    const vibes = fakeVibes();
    const { param, host } = await load();
    param("lm", 100, { min: 0, max: 1000 });
    host.connect({ v: 1, url: "https://vibes.test/p", token: "t" });
    await vi.advanceTimersByTimeAsync(0);
    vibes.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(vibes.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(vibes.calls).toHaveLength(2);
    vibes.close();
    await vi.advanceTimersByTimeAsync(1999);
    expect(vibes.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(vibes.calls).toHaveLength(3);
  });

  it("gives up on a stream that goes quiet, and opens another", async () => {
    vi.useFakeTimers();
    const vibes = fakeVibes();
    const { host } = await load();
    host.connect({ v: 1, url: "https://vibes.test/p", token: "t" });
    await vi.advanceTimersByTimeAsync(44_000);
    vibes.send(": keep-alive\n\n");
    await vi.advanceTimersByTimeAsync(44_000);
    expect(vibes.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000 + 1000);
    expect(vibes.calls).toHaveLength(2);
  });

  it("forgets the link when vibes turns it down or ends it for good, and not when another stream takes over", async () => {
    vi.useFakeTimers();
    const vibes = fakeVibes();
    const { host, tickParams } = await load();
    vibes.answer(401);
    host.connect({ v: 1, url: "https://vibes.test/p", token: "old" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vibes.calls).toHaveLength(1);
    expect((g.__vibesParams as { link: unknown }).link).toBeNull();

    vibes.answer(200);
    host.connect({ v: 1, url: "https://vibes.test/p", token: "new" });
    await vi.advanceTimersByTimeAsync(0);
    vibes.send('event: end\ndata: {"reason":"replaced"}\n\n');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vibes.calls).toHaveLength(2);
    expect((g.__vibesParams as { link: unknown }).link).not.toBeNull();

    tickParams();
    await vi.advanceTimersByTimeAsync(0);
    vibes.send('event: end\ndata: {"reason":"revoked"}\n\n');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vibes.calls).toHaveLength(3);
    expect((g.__vibesParams as { link: unknown }).link).toBeNull();
  });

  it("opens by itself in a linked sandbox's next script, on its first tick", async () => {
    const vibes = fakeVibes();
    const first = await load();
    first.host.connect({ v: 1, url: "https://vibes.test/p", token: "t" });
    await settle();
    expect(vibes.calls).toHaveLength(1);
    // arclamp drops the old script's fetches with it.
    (g.__vibesParams as { stream: { abort(): void } }).stream.abort();
    const second = await load();
    const lm = second.param("lm", 1, { min: 0, max: 10 });
    const update = second.sketch((here) => second.white(2700, 100 * lm(here)));
    update(room(), 0, 0);
    await settle();
    expect(vibes.calls).toHaveLength(2);
    expect(JSON.parse(vibes.calls[1]!.init.body).params.map((p: { name: string }) => p.name)).toEqual(["lm"]);
  });

  it("refuses a link it can't read", async () => {
    const { host } = await load();
    expect(host.connect({ url: "x" })).toEqual({ v: 1, error: "connect takes { v: 1, url, token }" });
    expect(host.connect(null)).toMatchObject({ error: expect.any(String) });
  });
});
