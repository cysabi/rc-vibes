import { beforeEach, describe, expect, it } from "vitest";
import type { Channels, LightInfo } from "../shared/arclamp.ts";
import type { Op, RoomMessage } from "../shared/live.ts";
import type { ParamSpec } from "../shared/params.ts";
import { RESTING } from "../shared/show.ts";
import type { Me } from "../shared/vibes.ts";
import { openDb } from "./db.ts";
import type { Instances } from "./instances.ts";
import type { LayoutEdits } from "./layout.ts";
import { ColorPatch, createPools, type Pools } from "./pools.ts";
import { Refused, type Shaders } from "./shaders.ts";
import { createUpdates, MAX_OPS, mergeBatches, parseOps, Unmade, type Updates } from "./updates.ts";

const ada: Me = { id: "rc:1", name: "Ada", dev: false };
const bob: Me = { id: "rc:2", name: "Bob", dev: false };
const P = "9b2f0f8e-1d3c-4b6a-8f00-0000000000b1";
const Q = "9b2f0f8e-1d3c-4b6a-8f00-0000000000b2";
const speed: ParamSpec = { kind: "number", name: "speed", label: "Speed", lights: {}, default: 7, min: 0, max: 20, step: 0.1 };
const LIGHTS: LightInfo[] = [1, 2, 3].map((id) => ({ id, type: "br30", tags: [], coords: null, rail: null, channels: ["a", "b", "brightness", "fidelity"] }));
const add = { sketch: "s1", branch: "main", home: [1, 2], muted: false, mask: [3] };
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Why an update's refused, as it's checked: its code. */
function refusal(ops: Op[]): string | null {
  try {
    parseOps(ops);
    return null;
  } catch (err) {
    return err instanceof Unmade ? err.code : "thrown";
  }
}

describe("checking an update", () => {
  it("takes each path a page can change, each with a value of its kind, by area", () => {
    const b = parseOps(
      [
        ["roomtone/24/brightness", 0.5],
        ["roomtone/24/a", 0.1],
        ["shaders/rclamp-3"],
        ["shaders/+k", add],
        ["shaders/i1/muted", true],
        ["shaders/i1/mask", [1, 2]],
        ["shaders/i1/instance/home", [1]],
        ["stack", ["i1", "rclamp-3"]],
        [`pools/${P}/declared`, [speed, { name: "bad" }]],
        [`pools/${P}/values/speed/1`, 3],
        [`pools/${P}/values/speed/2`],
        ["layout/lights/5/spot", { coords: { mm_x: 1, mm_y: 2, floor: 4 } }],
        ["layout/lights/6/spot", { rail: { id: "r1", mm_along: 10 } }],
        ["layout/lights/7/spot", null],
        ["layout/lights/5/type", "4x1-horizontal"],
        ["layout/lights/5/tags", ["couches"]],
        ["layout/rails/r1", { floor: 4, from: { mm_x: 0, mm_y: 0 }, to: { mm_x: 10, mm_y: 0 } }],
        ["layout/rails/r2", null],
      ],
      "warm",
    );
    expect(b.roomtone).toEqual({ "24": { brightness: 0.5, a: 0.1 } });
    expect([...b.removes]).toEqual(["rclamp-3"]);
    expect([...b.adds]).toEqual([["+k", add]]);
    expect([...b.shaders]).toEqual([["i1", { muted: true, mask: [1, 2], home: [1] }]]);
    expect(b.stack).toEqual(["i1", "rclamp-3"]);
    // What isn't a param is left out of what's declared.
    expect([...b.declared]).toEqual([[P, [speed]]]);
    expect([...b.values.get(P)!.get("speed")!]).toEqual([
      [1, 3],
      [2, null],
    ]);
    expect([...b.spots]).toEqual([
      [5, { coords: { mm_x: 1, mm_y: 2, floor: 4 } }],
      [6, { rail: { id: "r1", mm_along: 10 } }],
      [7, null],
    ]);
    expect([...b.types]).toEqual([[5, "4x1-horizontal"]]);
    expect([...b.tags]).toEqual([[5, ["couches"]]]);
    expect([...b.rails]).toEqual([
      ["r1", { floor: 4, from: { mm_x: 0, mm_y: 0 }, to: { mm_x: 10, mm_y: 0 } }],
      ["r2", null],
    ]);
    expect(b.note).toBe("warm");
    expect(b.sync).toBe(false);
  });

  it("is a sync with no changes in it", () => {
    expect(parseOps([]).sync).toBe(true);
  });

  it("refuses all of it for any path or value a page can't change", () => {
    for (const ops of [
      [["roomtone/24/brightness", "bright"]],
      [["roomtone/24/brightness"]],
      [["roomtone/x/brightness", 1]],
      [["roomtone/24", { brightness: 1 }]],
      [["shaders/rclamp-3", add]],
      [["shaders/+k", { ...add, home: [] }]],
      [["shaders/i1/muted", "yes"]],
      [["shaders/i1/name", "x"]],
      [["shaders/i1/instance/home", []]],
      [["stack", "i1"]],
      [["stack"]],
      [["pools/not-a-uuid/values/speed/1", 1]],
      [[`pools/${P}/declared`, { speed }]],
      [[`pools/${P}/values/two words/1`, 1]],
      [[`pools/${P}/values/speed/0`, 1]],
      [[`pools/${P}/values/speed/1`, "fast"]],
      [[`pools/${P}/values/tint/1/lm`]],
      [[`pools/${P}/values/tint/1/hue`, 3]],
      [[`pools/${P}/values/tint/1/lm`, "bright"]],
      [[`pools/${P}/values/tint/1/lm/x`, 3]],
      [["show/transport", { do: "dance", at: 1 }]],
      [["show/transport", { do: "play" }]],
      [["show/transport"]],
      [["show/clock", { playing: true, at: 1, t: 0 }]],
      [["layout/lights/5/spot", { coords: { mm_x: 1 } }]],
      [["layout/lights/5/colour", "red"]],
      [["layout/lights/5/tags", ["Not A Tag"]]],
      [["layout/rails/bad id", null]],
      [["nope", 1]],
      [["roomtone/24/brightness", 1], ["show/clock", 3]],
    ] as Op[][]) {
      expect(refusal(ops), JSON.stringify(ops)).toBe("bad_update");
    }
    expect(refusal(["roomtone/24/brightness"] as unknown as Op[])).toBe("bad_update");
    expect(refusal(Array.from({ length: MAX_OPS + 1 }, (): Op => ["roomtone/1/a", 0]))).toBe("too_big");
  });
});

describe("updates made together", () => {
  it("have the later's changes over the earlier's, path by path", () => {
    const a = parseOps([
      ["roomtone/1/a", 0.1],
      ["roomtone/1/b", 0.2],
      ["shaders/x/muted", true],
      ["shaders/+k", add],
      ["shaders/+z"],
      ["shaders/y"],
      ["stack", ["x"]],
      [`pools/${P}/values/speed/1`, 1],
      [`pools/${P}/values/speed/2`, 2],
      ["layout/lights/5/type", "a"],
    ], "first");
    const b = parseOps([
      ["roomtone/1/a", 0.3],
      ["shaders/x/mask", [1]],
      ["shaders/+k"],
      ["shaders/+z", add],
      [`pools/${P}/values/speed/2`],
      ["layout/lights/5/type", "b"],
    ]);
    const m = mergeBatches(a, b);
    expect(m.roomtone).toEqual({ "1": { a: 0.3, b: 0.2 } });
    expect([...m.shaders]).toEqual([["x", { muted: true, mask: [1] }]]);
    // Taken out after it was put in: it isn't put in; put in after it's taken out, it is.
    expect([...m.adds.keys()]).toEqual(["+z"]);
    expect([...m.removes]).toEqual(["y", "+k"]);
    expect(m.stack).toEqual(["x"]);
    expect([...m.values.get(P)!.get("speed")!]).toEqual([
      [1, 1],
      [2, null],
    ]);
    expect([...m.types]).toEqual([[5, "b"]]);
    expect(m.note).toBe("first");
    expect(m.sync).toBe(false);
    expect(mergeBatches(parseOps([]), parseOps([])).sync).toBe(true);
    // The earlier's aren't changed.
    expect(a.roomtone).toEqual({ "1": { a: 0.1, b: 0.2 } });
  });

  it("keep every action on the show clock, in order: two taps aren't one", () => {
    const a = parseOps([
      ["show/transport", { do: "play", at: 1 }],
      ["show/transport", { do: "tempo", at: 2, bpm: 120, onBeat: true }],
    ]);
    expect(a.transport).toEqual([
      { do: "play", at: 1 },
      { do: "tempo", at: 2, bpm: 120, onBeat: true },
    ]);
    const m = mergeBatches(a, parseOps([["show/transport", { do: "tempo", at: 3, bpm: 121, onBeat: true }]]));
    expect(m.transport.map((t) => ("bpm" in t ? t.bpm : t.do))).toEqual(["play", 120, 121]);
  });

  it("make each change to the scenes, in order: each counts", () => {
    const S = "00000000-0000-4000-8000-000000000001";
    const a = parseOps([
      [`scenes/list/${S}`, { name: " Intro " }],
      [`scenes/list/${S}/name`, "Opening"],
      [`scenes/list/${S}/shaders/i-1`, { speed: { "1": 5 } }],
      [`scenes/list/${S}/shaders/i-1/speed/2`, 7],
      [`scenes/list/${S}/shaders/i-1/speed/1`],
      ["scenes/order", [S]],
      [`scenes/list/${S}/shaders/i-1`, null],
      [`scenes/list/${S}`],
    ]);
    expect(a.scenes).toEqual([
      { op: "create", id: S, name: "Intro" },
      { op: "name", id: S, name: "Opening" },
      { op: "sketch", id: S, key: "i-1", knobs: { speed: { "1": 5 } } },
      { op: "knob", id: S, key: "i-1", param: "speed", light: "2", value: 7 },
      { op: "knob", id: S, key: "i-1", param: "speed", light: "1", value: null },
      { op: "order", ids: [S] },
      { op: "sketch", id: S, key: "i-1", knobs: null },
      { op: "remove", id: S },
    ]);
    expect(mergeBatches(a, parseOps([[`scenes/list/${S}`]])).scenes).toHaveLength(9);
    for (const op of [
      ["scenes/list/not-a-uuid", { name: "x" }],
      [`scenes/list/${S}`, { name: "" }],
      [`scenes/list/${S}/shaders/i-1/speed/0`, 1],
      [`scenes/list/${S}/shaders/i-1/speed/1`, "fast"],
      ["scenes/order", "x"],
      ["scenes/elsewhere", 1],
    ] as Op[]) {
      expect(() => parseOps([op]), JSON.stringify(op)).toThrow(/scenes/);
    }
  });

  it("have a color's numbers over the color before them, path by path, within an update and across them", () => {
    const tint = (light: number) => `pools/${P}/values/tint/${light}`;
    const c = { a: 0.1, b: 0.2, lm: 500, fidelity: 1 };
    const one = parseOps([
      [tint(1), c],
      [`${tint(1)}/lm`, 40],
      [`${tint(2)}/lm`, 40],
      [`${tint(2)}/a`, 0.3],
      [tint(3)],
      [`${tint(3)}/lm`, 90],
      [`${tint(4)}/lm`, 90],
      [tint(4), c],
    ]);
    expect([...one.values.get(P)!.get("tint")!]).toEqual([
      [1, { ...c, lm: 40 }],
      [2, new ColorPatch({ lm: 40, a: 0.3 })],
      [3, new ColorPatch({ lm: 90 }, true)],
      [4, c],
    ]);
    const m = mergeBatches(one, parseOps([[`${tint(2)}/b`, 0.5], [`${tint(4)}/lm`, 1]]));
    expect(m.values.get(P)!.get("tint")!.get(2)).toEqual(new ColorPatch({ lm: 40, a: 0.3, b: 0.5 }));
    expect(m.values.get(P)!.get("tint")!.get(4)).toEqual({ ...c, lm: 1 });
  });
});

describe("making updates", () => {
  let calls: string[];
  let tone: { lights: Record<string, Channels>; user: string; code?: string }[];
  let pools: Pools;
  let updates: Updates;
  let made: Record<string, string>;
  // What's gone from the room (by key), what fails, and how the tree's shown.
  let gone: Set<string>;
  let failing: ((call: string) => Refused | null) | null;
  let hold: Promise<void> | null;
  let showing: () => Promise<unknown>;
  let logged: [string, string, number, string][];

  const call = async (what: string) => {
    calls.push(what);
    const err = failing?.(what);
    if (err) throw err;
  };

  function build(withInstances = true) {
    const db = openDb(":memory:");
    pools = createPools({ db, publish: () => {}, lights: async () => LIGHTS });
    const shaders = {
      keyOf: (key: string) => (key.startsWith("+") ? (made[key] ?? null) : gone.has(key) ? null : key),
      remove: (key: string) => call(`remove ${key}`),
      setMuted: (key: string, muted: boolean) => call(`muted ${key} ${muted}`),
      setMask: (key: string, mask: number[]) => call(`mask ${key} ${mask.join(",")}`),
      setHome: (key: string, home: number[]) => call(`home ${key} ${home.join(",")}`),
      reorder: (order: string[]) => call(`stack ${order.join(",")}`),
    } as unknown as Shaders;
    const instances = {
      create: async (sketch: string, _from: unknown, home: number[], _user: Me, key: string, want: { above?: string | null }, pool?: string) => {
        await call(`add ${key} ${sketch} on ${home.join(",")} above=${want.above ?? "top"} pool=${pool === P ? "P" : pool} declared=${JSON.stringify(pool ? (pools.get(pool)?.declared?.map((s) => s.name) ?? null) : null)}`);
        made[key] = `inst${key.slice(1)}`;
        // As instances.ts does: the pool it went in with is its own now.
        if (pool) pools.adopt(pool, `instance:${made[key]}`);
        return { instance: { id: made[key] } };
      },
    } as unknown as Instances;
    const layout = {
      setRails: (rails: { id: string }[]) => call(`rails ${rails.map((r) => r.id).join(",")}`),
      place: (placements: { id: number }[]) => call(`place ${placements.map((p) => p.id).join(",")}`),
      turn: (lights: { id: number }[]) => call(`turn ${lights.map((l) => l.id).join(",")}`),
      tag: (lights: { id: number }[]) => call(`tag ${lights.map((l) => l.id).join(",")}`),
    } as unknown as LayoutEdits;
    updates = createUpdates({
      shaders,
      instances: withInstances ? instances : null,
      pools,
      layout,
      setRoomtone: async (lights, user, code) => {
        tone.push({ lights, user: user.name, ...(code ? { code } : {}) });
        await call(`roomtone ${Object.keys(lights).join(",")}`);
        if (hold) await hold;
      },
      shown: (soon) => {
        calls.push(`shown ${soon ? "soon" : "now"}`);
        return showing();
      },
      logParam: (pool, name, lights, user) => logged.push([pool, name, lights, user.name]),
      show: {
        act: (a) => {
          if (a.do === "tempo" && a.bpm < 20) throw new Refused(400, "bad_tempo", "too slow");
          calls.push(`show ${a.do}`);
          return RESTING.clock;
        },
      },
    });
  }

  /** A page's session, and everything it's been told (its updates' answers). */
  function page(user = ada) {
    const heard: Extract<RoomMessage, { type: "done" | "refused" }>[] = [];
    const s = updates.session(user, (m) => heard.push(m as (typeof heard)[number]));
    let n = 0;
    return {
      heard,
      send(ops: Op[], note?: string) {
        const id = `u${++n}`;
        s.take(id, ops, note);
        return id;
      },
      close: () => s.close(),
    };
  }

  const until = async (test: () => boolean) => {
    for (let i = 0; i < 200 && !test(); i++) await settle(5);
    expect(test()).toBe(true);
  };

  beforeEach(() => {
    calls = [];
    tone = [];
    made = {};
    gone = new Set();
    failing = null;
    hold = null;
    showing = async () => {};
    logged = [];
    build();
  });

  it("makes each area in an order that keeps the room right, and answers once the tree shows it", async () => {
    const p = page();
    p.send(
      [
        ["layout/lights/5/tags", ["a"]],
        ["layout/lights/5/type", "t"],
        ["layout/lights/6/spot", null],
        ["layout/rails/r1", null],
        ["stack", ["+k", "i1"]],
        [`pools/${P}/values/speed/1`, 9],
        [`pools/${P}/declared`, [speed]],
        ["shaders/i1/muted", false],
        ["shaders/i1/mask", [3]],
        ["shaders/i1/instance/home", [1, 2, 3]],
        ["shaders/+k", { ...add, above: "i1", pool: P }],
        ["shaders/rclamp-9"],
        ["roomtone/24/brightness", 0.5],
      ],
      "warm",
    );
    await until(() => p.heard.length === 1);
    expect(calls).toEqual([
      "roomtone 24",
      "remove rclamp-9",
      // Its pool first: what it declared before it went in.
      'add +k s1 on 1,2 above=i1 pool=P declared=["speed"]',
      // Home; then, unmuting, the mask before the mute.
      "home i1 1,2,3",
      "mask i1 3",
      "muted i1 false",
      "stack +k,i1",
      "rails r1",
      "place 6",
      "turn 5",
      "tag 5",
      "shown soon",
    ]);
    expect(tone).toEqual([{ lights: { "24": { brightness: 0.5 } }, user: "Ada", code: "warm" }]);
    expect(pools.get(P)).toMatchObject({ declared: [speed], values: { speed: { "1": 9 } } });
    expect(p.heard).toEqual([{ type: "done", id: "u1", made: { "+k": "inst+k".replace("+", "") } }]);
    expect(logged).toEqual([[P, "speed", 1, "Ada"]]);
  });

  it("mutes before masking, so a shader switched off never runs where it shouldn't meanwhile", async () => {
    const p = page();
    p.send([
      ["shaders/i1/mask", [1]],
      ["shaders/i1/muted", true],
    ]);
    await until(() => p.heard.length === 1);
    expect(calls).toEqual(["muted i1 true", "mask i1 1", "shown soon"]);
  });

  it("answers each in the order they came, once the tree shows them", async () => {
    let show: (() => void)[] = [];
    showing = () => new Promise<void>((r) => show.push(r));
    const p = page();
    p.send([["roomtone/1/a", 0.1]]);
    await until(() => show.length === 1);
    p.send([["roomtone/1/a", 0.2]]);
    await until(() => show.length === 2);
    expect(p.heard).toEqual([]);
    show[1]!();
    await settle(5);
    // The second's shown, but the first isn't answered yet: nor is it.
    expect(p.heard).toEqual([]);
    show[0]!();
    await until(() => p.heard.length === 2);
    expect(p.heard.map((m) => m.id)).toEqual(["u1", "u2"]);
    show = [];
  });

  it("makes those that come while one's being made together, the latest of each path winning, and answers each", async () => {
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const p = page();
    p.send([["roomtone/1/a", 0.1]]);
    await until(() => tone.length === 1);
    hold = null;
    p.send([["roomtone/1/a", 0.2]]);
    p.send([
      ["roomtone/1/a", 0.3],
      ["roomtone/2/b", 1],
    ]);
    p.send([["shaders/i1/muted", true]]);
    release();
    await until(() => p.heard.length === 4);
    expect(tone.map((t) => t.lights)).toEqual([{ "1": { a: 0.1 } }, { "1": { a: 0.3 }, "2": { b: 1 } }]);
    expect(calls.filter((c) => c.startsWith("muted"))).toEqual(["muted i1 true"]);
    expect(p.heard.map((m) => [m.type, m.id])).toEqual([
      ["done", "u1"],
      ["done", "u2"],
      ["done", "u3"],
      ["done", "u4"],
    ]);
  });

  it("sends room tone from everyone in one call while one's out: the latest, merged", async () => {
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const a = page(ada);
    a.send([["roomtone/1/a", 0.1]]);
    await until(() => tone.length === 1);
    hold = null;
    const b = page(bob);
    const c = page(ada);
    b.send([["roomtone/2/b", 0.5]]);
    c.send([["roomtone/3/b", 0.7]]);
    await settle(5);
    release();
    await until(() => a.heard.length + b.heard.length + c.heard.length === 3);
    expect(tone.map((t) => t.lights)).toEqual([{ "1": { a: 0.1 } }, { "2": { b: 0.5 }, "3": { b: 0.7 } }]);
    expect([...a.heard, ...b.heard, ...c.heard].every((m) => m.type === "done")).toBe(true);
  });

  it("refuses all of an update that's wrong, or that says what someone else's pool declares, before making any of it", async () => {
    pools.ensure(Q, "instance:i9");
    const p = page();
    p.send([
      ["roomtone/1/a", 0.1],
      ["shaders/x/colour", "red"],
    ]);
    p.send([
      ["roomtone/1/a", 0.1],
      [`pools/${Q}/declared`, [speed]],
    ]);
    await until(() => p.heard.length === 2);
    expect(p.heard).toEqual([
      { type: "refused", id: "u1", error: "shaders/x/colour isn't a change a page can make", code: "bad_update", made: {} },
      { type: "refused", id: "u2", error: "what a pool declares is for the code running with it to say", code: "not_owner", made: {} },
    ]);
    expect(calls).toEqual([]);
    expect(pools.get(Q)!.declared).toBeNull();
    // One's own pool is one's own to declare for.
    pools.ensure(P, `user:${ada.id}`);
    p.send([[`pools/${P}/declared`, [speed]]]);
    await until(() => p.heard.length === 3);
    expect(p.heard[2]).toMatchObject({ type: "done" });
    expect(pools.get(P)).toMatchObject({ owner: `user:${ada.id}`, declared: [speed] });
  });

  it("only makes pools with a sketch put in with one: changes to any other vibes doesn't have are passed over", async () => {
    const p = page();
    p.send([
      [`pools/${P}/declared`, [speed]],
      [`pools/${P}/values/speed/1`, 2],
    ]);
    await until(() => p.heard.length === 1);
    expect(p.heard[0]).toMatchObject({ type: "done" });
    expect(pools.get(P)).toBeUndefined();
  });

  it("won't put a sketch in with another shader's pool: that would take its params over", async () => {
    pools.ensure(Q, "instance:i9");
    const p = page();
    p.send([[`shaders/+k`, { ...add, pool: Q }]]);
    await until(() => p.heard.length === 1);
    expect(p.heard[0]).toMatchObject({ type: "refused", code: "not_owner" });
    expect(calls).toEqual([]);
    expect(pools.get(Q)!.owner).toBe("instance:i9");
  });

  it("takes the same add sent again, with the pool it went in with, as the one it made", async () => {
    const p = page();
    const again: Op[] = [
      [`shaders/+k`, { ...add, pool: P }],
      [`pools/${P}/declared`, [speed]],
    ];
    p.send(again);
    await until(() => p.heard.length === 1);
    expect(p.heard[0]).toMatchObject({ type: "done", made: { "+k": "instk" } });
    expect(pools.get(P)!.owner).toBe("instance:instk");
    p.send(again);
    await until(() => p.heard.length === 2);
    expect(p.heard[1]).toMatchObject({ type: "done", made: { "+k": "instk" } });
  });

  it("passes over shaders that are gone: there's nothing left to change", async () => {
    gone.add("rclamp-4");
    failing = (c) => (c.startsWith("muted rclamp-5") || c.startsWith("remove rclamp-6") ? new Refused(404, "not_found", "no such shader") : null);
    const p = page();
    p.send([
      ["shaders/rclamp-4/muted", true],
      ["shaders/rclamp-5/muted", true],
      ["shaders/rclamp-6"],
    ]);
    await until(() => p.heard.length === 1);
    expect(p.heard[0]).toMatchObject({ type: "done" });
    expect(calls).toEqual(["remove rclamp-6", "muted rclamp-5 true", "shown soon"]);
  });

  it("failing part way, says why, with the shaders it added before it stopped", async () => {
    failing = (c) => (c.startsWith("mask") ? new Refused(400, "bad_mask", "that's no mask") : null);
    const p = page();
    p.send([
      ["shaders/+k", add],
      ["shaders/i1/mask", [1]],
      ["stack", ["i1"]],
    ]);
    await until(() => p.heard.length === 1);
    expect(p.heard[0]).toEqual({ type: "refused", id: "u1", error: "that's no mask", code: "bad_mask", made: { "+k": "instk" } });
    expect(calls.some((c) => c.startsWith("stack"))).toBe(false);
  });

  it("can't put a sketch in with sketches off", async () => {
    build(false);
    const p = page();
    p.send([["shaders/+k", add]]);
    await until(() => p.heard.length === 1);
    expect(p.heard[0]).toMatchObject({ type: "refused", code: "no_sketches" });
  });

  it("makes each action on the show clock in turn, answered at once, and refuses one the clock won't take", async () => {
    const p = page();
    p.send([
      ["show/transport", { do: "play", at: 1 }],
      ["show/transport", { do: "downbeat", at: 2 }],
    ]);
    await until(() => p.heard.length === 1);
    expect(p.heard[0]).toMatchObject({ type: "done" });
    expect(calls).toEqual(["show play", "show downbeat"]);
    p.send([["show/transport", { do: "tempo", at: 3, bpm: 5 }]]);
    await until(() => p.heard.length === 2);
    expect(p.heard[1]).toMatchObject({ type: "refused", code: "bad_tempo" });
  });

  it("answers params at once: they're vibes' own, with nothing to wait for in the room", async () => {
    pools.declare(P, [speed], `user:${ada.id}`);
    const p = page();
    p.send([[`pools/${P}/values/speed/1`, 3], [`pools/${P}/values/speed/2`, 4]]);
    await until(() => p.heard.length === 1);
    expect(calls).toEqual([]);
    expect(pools.get(P)!.values.speed).toEqual({ "1": 3, "2": 4 });
    expect(logged).toEqual([[P, "speed", 2, "Ada"]]);
    // Nothing changed: nothing noted.
    p.send([[`pools/${P}/values/speed/1`, 3]]);
    await until(() => p.heard.length === 2);
    expect(logged).toHaveLength(1);
  });

  it("changes a color's numbers over each light's color: a brightness over lights of different colors", async () => {
    const tint: ParamSpec = { kind: "color", name: "tint", label: "Tint", lights: {}, default: { a: 0, b: 0, lm: 300, fidelity: 1 } };
    pools.declare(P, [tint], `user:${ada.id}`);
    await pools.set(P, "tint", [[1, { a: 0.1, b: 0.2, lm: 500, fidelity: 1 }], [2, { a: -0.1, b: 0, lm: 200, fidelity: 0.5 }]], `user:${ada.id}`);
    const p = page();
    p.send([1, 2, 3].map((l): Op => [`pools/${P}/values/tint/${l}/lm`, 40]));
    await until(() => p.heard.length === 1);
    expect(p.heard[0]).toMatchObject({ type: "done" });
    expect(pools.get(P)!.values.tint).toEqual({
      "1": { a: 0.1, b: 0.2, lm: 40, fidelity: 1 },
      "2": { a: -0.1, b: 0, lm: 40, fidelity: 0.5 },
      // At the default: the default's color, with this brightness.
      "3": { a: 0, b: 0, lm: 40, fidelity: 1 },
    });
  });

  it("answers an update with no changes once the tree's up to date, at once", async () => {
    const p = page();
    p.send([]);
    await until(() => p.heard.length === 1);
    expect(calls).toEqual(["shown now"]);
    expect(p.heard[0]).toEqual({ type: "done", id: "u1", made: {} });
  });

  it("stops making a closed page's updates", async () => {
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const p = page();
    p.send([["roomtone/1/a", 0.1]]);
    await until(() => tone.length === 1);
    hold = null;
    p.send([["shaders/i1/muted", true]]);
    p.close();
    release();
    await settle(30);
    expect(calls.some((c) => c.startsWith("muted"))).toBe(false);
  });
});
