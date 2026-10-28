import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LightInfo } from "../shared/arclamp.ts";
import type { Op } from "../shared/live.ts";
import type { Changes, ParamSpec } from "../shared/params.ts";
import { openDb, type Db } from "./db.ts";
import { anyValue, ColorPatch, createPools, laterChange, type LightChanges, type Pools } from "./pools.ts";

const speed: ParamSpec = { kind: "number", name: "speed", label: "Speed", lights: {}, default: 7, min: 0, max: 20, step: 0.1 };
const on: ParamSpec = { kind: "toggle", name: "on", label: "On", lights: { kinds: ["switch"] }, default: false };
const tint: ParamSpec = { kind: "color", name: "tint", label: "Tint", lights: { kinds: ["color"] }, default: { a: 0, b: 0, lm: 300, fidelity: 1 } };
const light = (id: number, channels: string[]): LightInfo => ({ id, type: "br30", tags: [], coords: null, rail: null, channels });
// 1 and 2 take colors; 3 only switches.
const LIGHTS = [light(1, ["a", "b", "brightness", "fidelity"]), light(2, ["a", "b", "brightness", "fidelity"]), light(3, ["on"])];
const P = "9b2f0f8e-1d3c-4b6a-8f00-0000000000a1";

describe("a value any param could have", () => {
  it("is a finite number, true or false, or a color (fidelity 1 if left out)", () => {
    expect(anyValue(3)).toBe(3);
    expect(anyValue(Number.NaN)).toBeNull();
    expect(anyValue(false)).toBe(false);
    expect(anyValue({ a: 0.1, b: 0, lm: 10 })).toEqual({ a: 0.1, b: 0, lm: 10, fidelity: 1 });
    expect(anyValue("red")).toBeNull();
    expect(anyValue(null)).toBeNull();
  });
});

describe("one light's changes, one after another", () => {
  it("are the later, but for a color's numbers, which go over the earlier's", () => {
    const c = { a: 0.1, b: 0.2, lm: 500, fidelity: 1 };
    expect(laterChange(c, 3)).toBe(3);
    expect(laterChange(new ColorPatch({ lm: 1 }), null)).toBeNull();
    expect(laterChange(undefined, new ColorPatch({ lm: 1 }))).toEqual(new ColorPatch({ lm: 1 }));
    expect(laterChange(c, new ColorPatch({ lm: 1 }))).toEqual({ ...c, lm: 1 });
    expect(laterChange(null, new ColorPatch({ lm: 1 }))).toEqual(new ColorPatch({ lm: 1 }, true));
    expect(laterChange(new ColorPatch({ a: 0 }, true), new ColorPatch({ lm: 1 }))).toEqual(new ColorPatch({ a: 0, lm: 1 }, true));
  });
});

describe("pools", () => {
  let db: Db;
  let pools: Pools;
  let published: Op[];
  let changes: [string, string, Changes][];
  let clock: number;

  const make = () => {
    pools = createPools({ db, publish: (ops) => published.push(...ops), lights: async () => LIGHTS, now: () => clock });
    pools.onChange((id, name, set) => changes.push([id, name, set]));
  };

  beforeEach(() => {
    db = openDb(":memory:");
    published = [];
    changes = [];
    clock = 1000;
    make();
  });
  afterEach(() => {
    pools.stop();
    vi.useRealTimers();
  });

  it("are made when first wanted, owned by whoever wanted one, and shown in the tree", () => {
    const p = pools.ensure(P, "user:ada");
    expect(p).toMatchObject({ id: P, owner: "user:ada", declared: null, values: {}, link_epoch: 0 });
    expect(pools.ensure(P, "user:bob")).toBe(p);
    expect(published).toEqual([[`pools/${P}`, { declared: null, values: {} }]]);
    expect(db.pools()).toHaveLength(1);
    expect(pools.tree()).toEqual({ [P]: { declared: null, values: {} } });
  });

  it("say what they declare only by their owner; one not made yet, anyone may", () => {
    expect(pools.mayDeclare(P, "user:ada")).toBe(true);
    pools.ensure(P, "user:ada");
    expect(pools.mayDeclare(P, "user:ada")).toBe(true);
    expect(pools.mayDeclare(P, "user:bob")).toBe(false);
    // An instance takes it on: its shader's to say from then on.
    pools.adopt(P, "instance:i");
    expect(pools.get(P)!.owner).toBe("instance:i");
    expect(pools.mayDeclare(P, "user:ada")).toBe(false);
    expect(pools.mayDeclare(P, "instance:i")).toBe(true);
  });

  it("keep what's declared, shown when it changes", () => {
    pools.declare(P, [speed], "user:ada");
    pools.declare(P, [speed], "user:ada");
    expect(pools.get(P)!.declared).toEqual([speed]);
    expect(published.filter(([path]) => path === `pools/${P}/declared`)).toEqual([[`pools/${P}/declared`, [speed]]]);
  });

  it("set values light by light, as the param's declared: within its range, its kind, and the lights it's for", async () => {
    pools.declare(P, [speed, on, tint], "user:ada");
    published.length = 0;
    expect(await pools.set(P, "speed", [[1, 30], [2, 9]], "user:ada")).toBe(true);
    expect(pools.get(P)!.values.speed).toEqual({ "1": 20, "2": 9 });
    expect(published).toEqual([
      [`pools/${P}/values/speed/1`, 20],
      [`pools/${P}/values/speed/2`, 9],
    ]);
    // A toggle's for switches only; a number's not a toggle.
    expect(await pools.set(P, "on", [[1, true], [3, 1], [3, true]], "user:ada")).toBe(true);
    expect(pools.get(P)!.values.on).toEqual({ "3": true });
    // A light there's no such light of, nothing.
    expect(await pools.set(P, "speed", [[99, 3]], "user:ada")).toBe(false);
    expect(changes.map(([, name, set]) => [name, set])).toEqual([
      ["speed", [[20, [1]], [9, [2]]]],
      ["on", [[true, [3]]]],
    ]);
  });

  it("take a light back to the default by setting it, or by null, and say nothing's changed when nothing has", async () => {
    pools.declare(P, [speed], "user:ada");
    await pools.set(P, "speed", [[1, 9], [2, 9]], "user:ada");
    published.length = 0;
    changes.length = 0;
    expect(await pools.set(P, "speed", [[1, 7], [2, null]], "user:ada")).toBe(true);
    expect(pools.get(P)!.values.speed).toEqual({});
    expect(published).toEqual([[`pools/${P}/values/speed/1`], [`pools/${P}/values/speed/2`]]);
    expect(changes).toEqual([[P, "speed", [[null, [1, 2]]]]]);
    expect(await pools.set(P, "speed", [[1, null], [2, 7]], "user:ada")).toBe(false);
    expect(changes).toHaveLength(1);
  });

  it("change some of a color's numbers over its color, or the default's: in the tree just those, each number's lights together", async () => {
    pools.declare(P, [tint], "user:ada");
    await pools.set(P, "tint", [[1, { a: 0.1, b: 0.2, lm: 500, fidelity: 1 }], [2, { a: -0.1, b: 0, lm: 200, fidelity: 1 }]], "user:ada");
    published.length = 0;
    changes.length = 0;
    expect(await pools.set(P, "tint", [[1, new ColorPatch({ lm: 40, a: 0.3 })], [2, new ColorPatch({ lm: 40, a: 0.3 })]], "user:ada")).toBe(true);
    expect(pools.get(P)!.values.tint).toEqual({ "1": { a: 0.3, b: 0.2, lm: 40, fidelity: 1 }, "2": { a: 0.3, b: 0, lm: 40, fidelity: 1 } });
    expect(published).toEqual([
      [`pools/${P}/values/tint/1/a`, 0.3],
      [`pools/${P}/values/tint/2/a`, 0.3],
      [`pools/${P}/values/tint/1/lm`, 40],
      [`pools/${P}/values/tint/2/lm`, 40],
    ]);
    // The stream has each light's whole color.
    expect(changes).toEqual([[P, "tint", [[{ a: 0.3, b: 0.2, lm: 40, fidelity: 1 }, [1]], [{ a: 0.3, b: 0, lm: 40, fidelity: 1 }, [2]]]]]);
    // A light at the default: the default's color, whole in the tree; or from the default, put back to it first.
    await pools.set(P, "tint", [[2, null]], "user:ada");
    published.length = 0;
    expect(await pools.set(P, "tint", [[2, new ColorPatch({ lm: 90 })], [1, new ColorPatch({ lm: 90 }, true)]], "user:ada")).toBe(true);
    expect(published).toEqual([
      [`pools/${P}/values/tint/2`, { a: 0, b: 0, lm: 90, fidelity: 1 }],
      [`pools/${P}/values/tint/1/a`, 0],
      [`pools/${P}/values/tint/1/b`, 0],
      [`pools/${P}/values/tint/1/lm`, 90],
    ]);
    // A number's no color to change the numbers of.
    pools.declare(P, [tint, speed], "user:ada");
    expect(await pools.set(P, "speed", [[1, new ColorPatch({ lm: 1 })]], "user:ada")).toBe(false);
  });

  it("pass over a param their code doesn't declare, once it's said what it does", async () => {
    pools.declare(P, [speed], "user:ada");
    expect(await pools.set(P, "gone", [[1, 3]], "user:ada")).toBe(false);
    expect(pools.get(P)!.values).toEqual({});
  });

  it("before anything's declared, take any value a param could have, on any light", async () => {
    // As a page might send them: anything at all.
    const loose = (changes: [number, unknown][]) => changes as LightChanges;
    expect(await pools.set(P, "speed", loose([[42, 3], [1, "fast"]]), "user:ada")).toBe(true);
    expect(await pools.set(P, "tint", loose([[2, { a: 0.1, b: 0, lm: 200 }]]), "user:ada")).toBe(true);
    expect(pools.get(P)!.values).toEqual({ speed: { "42": 3 }, tint: { "2": { a: 0.1, b: 0, lm: 200, fidelity: 1 } } });
    // Made by the first to set it.
    expect(pools.get(P)!.owner).toBe("user:ada");
  });

  it("group each param's values for the stream: by value, the default left out; each its own before anything's declared", async () => {
    await pools.set(P, "speed", [[1, 9], [2, 9], [3, 7]], "user:ada");
    expect(pools.table(P)).toEqual({ speed: [[9, [1]], [9, [2]], [7, [3]]] });
    pools.declare(P, [speed], "user:ada");
    expect(pools.table(P)).toEqual({ speed: [[9, [1, 2]]] });
    expect(pools.table("nope")).toEqual({});
  });

  it("are saved a second after they last changed, and at once when vibes stops", async () => {
    vi.useFakeTimers();
    pools.ensure(P, "user:ada");
    pools.declare(P, [speed], "user:ada");
    await pools.set(P, "speed", [[1, 9]], "user:ada");
    expect(db.pools()[0]).toMatchObject({ declared: null, values: {} });
    vi.advanceTimersByTime(999);
    await pools.set(P, "speed", [[2, 9]], "user:ada");
    vi.advanceTimersByTime(999);
    expect(db.pools()[0]!.values).toEqual({});
    vi.advanceTimersByTime(1);
    expect(db.pools()[0]).toMatchObject({ declared: [speed], values: { speed: { "1": 9, "2": 9 } } });
    await pools.set(P, "speed", [[1, 3]], "user:ada");
    pools.stop();
    expect(db.pools()[0]!.values).toEqual({ speed: { "1": 3, "2": 9 } });
    // Back as it was saved.
    make();
    expect(pools.get(P)).toMatchObject({ owner: "user:ada", declared: [speed], values: { speed: { "1": 3, "2": 9 } } });
  });

  it("are let go: gone from the tree and the database", () => {
    pools.ensure(P, "user:ada");
    published.length = 0;
    pools.remove(P);
    expect(pools.get(P)).toBeUndefined();
    expect(db.pools()).toEqual([]);
    expect(published).toEqual([[`pools/${P}`]]);
    pools.remove(P);
    expect(published).toHaveLength(1);
  });

  it("count each link from the room, saved, so older links' tokens stop working", () => {
    pools.ensure(P, "instance:i");
    expect(pools.relink(P)).toBe(1);
    expect(pools.relink(P)).toBe(2);
    expect(db.pools()[0]!.link_epoch).toBe(2);
    expect(pools.relink("nope")).toBe(0);
  });

  it("no instance has, untouched for a day, are let go; an instance's stay", () => {
    vi.useFakeTimers();
    pools.stop();
    make();
    pools.ensure(P, "user:ada");
    pools.ensure("9b2f0f8e-1d3c-4b6a-8f00-0000000000a2", "instance:i");
    clock += 24 * 60 * 60 * 1000 + 1;
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(pools.get(P)).toBeUndefined();
    expect(pools.get("9b2f0f8e-1d3c-4b6a-8f00-0000000000a2")).toBeDefined();
  });
});

describe("pools from before there were pools", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vibes-pools-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // A database on disk, opened twice: every table made and every migration run, each written through,
  // which takes CI's runner (on kokuzo's slow disk) more than the usual 5 s.
  it("are made from each instance's params, declarations and link, with the instance's id, its own", { timeout: 30_000 }, () => {
    const path = join(dir, "vibes.db");
    const old = new DatabaseSync(path);
    // Instances as they were kept just before pools: params kept with each.
    old.exec(`
      CREATE TABLE instances (
        id TEXT PRIMARY KEY, sketch_id TEXT NOT NULL, build_id TEXT NOT NULL, home TEXT NOT NULL,
        shader_id INTEGER, state TEXT NOT NULL, error TEXT, next_build_id TEXT,
        by_id TEXT NOT NULL, by_name TEXT NOT NULL, at INTEGER NOT NULL,
        branch TEXT NOT NULL DEFAULT 'main', client_key TEXT,
        muted INTEGER NOT NULL DEFAULT 0, mask TEXT, above TEXT,
        params TEXT, declared TEXT, link_epoch INTEGER NOT NULL DEFAULT 0
      );
    `);
    const insert = old.prepare("INSERT INTO instances (id, sketch_id, build_id, home, state, by_id, by_name, at, params, declared, link_epoch) VALUES (?, 's', 'b', '[1,2]', 'live', 'u', 'U', ?, ?, ?, ?)");
    insert.run("i1", 5, JSON.stringify({ speed: [[9, [1, 2]], [3, [4]]] }), JSON.stringify([speed]), 3);
    insert.run("i2", 6, null, null, 0);
    old.close();

    const db = openDb(path);
    const pools = Object.fromEntries(db.pools().map((p) => [p.id, p]));
    expect(pools.i1).toMatchObject({ owner: "instance:i1", declared: [speed], values: { speed: { "1": 9, "2": 9, "4": 3 } }, link_epoch: 3, at: 5 });
    expect(pools.i2).toMatchObject({ owner: "instance:i2", declared: null, values: {}, link_epoch: 0 });
    expect(db.instance("i1")!.pool_id).toBe("i1");
    expect(db.instance("i2")!.pool_id).toBe("i2");
    db.close();
    // Opened again: nothing moved twice.
    const again = openDb(path);
    expect(again.pools()).toHaveLength(2);
    again.close();
  });
});
