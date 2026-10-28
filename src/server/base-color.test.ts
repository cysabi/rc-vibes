import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LightInfo, ShaderDescriptor } from "../shared/arclamp.ts";
import { BASE_COLOR, BASE_COLOR_SPECS } from "../shared/base-color.ts";
import type { RoomMessage } from "../shared/live.ts";
import type { Me } from "../shared/vibes.ts";
import type { AuthEnv } from "./auth.ts";
import { createBaseColor, type BaseColor } from "./base-color.ts";
import type { Builds } from "./builds.ts";
import { openDb, type Db } from "./db.ts";
import { loadConfig } from "./env.ts";
import { createInstances, type Instances } from "./instances.ts";
import type { LayoutEdits } from "./layout.ts";
import { createPools, type Pools } from "./pools.ts";
import { createShaders, type Shaders } from "./shaders.ts";
import { sketchRoutes } from "./sketches.ts";
import { readStamp, stamp } from "./stamp.ts";
import { createUpdates } from "./updates.ts";

const KEY = "k".repeat(32);
const ada: Me = { id: "rc:1", name: "Ada", dev: false };
const SKETCH = "0f4527e5-4faf-4691-b789-e4c389175401";
const LIGHTS = [1, 2, 3, 4, 5, 6];
// 6 is an old bulb.
const INFO: LightInfo[] = LIGHTS.map((id) => ({ id, type: id === 6 ? "relay" : "br30", tags: [], coords: null, rail: null, channels: [] }));
const config = loadConfig({ ARCLAMP_BASE_URL: "http://127.0.0.1:1", ARCLAMP_KEY: "k", SESSION_SECRET: "s".repeat(32), VIBES_SIGNING_KEY: KEY, VIBES_DEV_LOGIN: "1" });
const SCRIPT = "function update(prev) { return prev; }\n";

const roomtone: ShaderDescriptor = {
  id: 0,
  type: "roomtone",
  position: 0,
  state: "running",
  muted: false,
  created_by: "system",
  modified_by: "system",
  template: { lights: { "1": { a: 0.1, b: 0.2, brightness: 0.5, fidelity: 1 }, "2": { a: -0.05, b: 0.1, brightness: 0.25, fidelity: 0.5 }, "6": { on: 0 } } },
};

let db: Db;
let scene: Map<number, ShaderDescriptor>;
// What arclamp was asked to do, in order.
let calls: string[];
let pools: Pools;
let instances: Instances;
let shaders: Shaders;
let base: BaseColor;
let linkedNow: boolean;
let next: number;

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const baseId = () => db.instance(BASE_COLOR.instance)?.shader_id ?? null;
/** The scene's js shaders, bottom first, as the feed hands them on. */
const stack = () => [...scene.values()].sort((a, b) => a.position - b.position).map((d) => ({ id: d.id, position: d.position, muted: d.muted, mask: d.mask ?? [] }));

/** As arclamp does: a shader taken out, and put back in at a position (1 the bottom), the rest closing up. */
function place(id: number | null, at: number) {
  const rest = [...scene.values()].filter((d) => d.id !== id).sort((a, b) => a.position - b.position);
  const moving = id === null ? null : scene.get(id)!;
  const order = moving ? [...rest.slice(0, at - 1), moving, ...rest.slice(at - 1)] : rest;
  order.forEach((d, i) => scene.set(d.id, { ...d, position: i + 1 }));
}

beforeEach(() => {
  db = openDb(":memory:");
  scene = new Map();
  calls = [];
  linkedNow = false;
  next = 1;
  const arclamp = {
    scene: async () => [roomtone, ...scene.values()],
    shader: async (id: number) => {
      if (id === 0) return roomtone;
      const d = scene.get(id);
      if (!d) throw Object.assign(new Error("no such shader"), { status: 404 });
      return d;
    },
    createShader: async (script: string, position?: number, initial?: { muted: boolean; mask: number[] }) => {
      const at = Math.min(Math.max(position ?? scene.size + 1, 1), scene.size + 1);
      const d: ShaderDescriptor = { id: next++, type: "js", position: 0, script, state: "running", muted: initial?.muted ?? false, created_by: "vibes", modified_by: "vibes" };
      if (initial?.mask.length) d.mask = initial.mask;
      scene.set(d.id, d);
      place(d.id, at);
      calls.push(`create ${d.id} at ${at}${d.muted ? " muted" : ""}${d.mask ? ` mask ${d.mask.join(",")}` : ""}`);
      return scene.get(d.id)!;
    },
    setScript: async (id: number, script: string) => {
      scene.set(id, { ...scene.get(id)!, script });
      return scene.get(id)!;
    },
    deleteShader: async (id: number) => {
      calls.push(`delete ${id}`);
      scene.delete(id);
      place(null, 0);
    },
    setMask: async (id: number, mask: number[]) => {
      calls.push(`mask ${id} ${mask.join(",")}`);
      scene.set(id, { ...scene.get(id)!, mask });
    },
    setMuted: async (id: number, muted: boolean) => {
      calls.push(`muted ${id} ${muted}`);
      scene.set(id, { ...scene.get(id)!, muted });
    },
    moveShader: async (id: number, position: number) => {
      calls.push(`move ${id} ${position}`);
      place(id, position);
    },
  };
  const builds = { start: async () => ({ refused: "no builds here", status: 503 }), onFinish: () => () => {} } as unknown as Builds;
  pools = createPools({ db, publish: () => {}, lights: async () => INFO });
  instances = createInstances({ config, db, arclamp, builds, lightIds: async () => LIGHTS, pools, wentIn: (id, d) => base.wentIn(id, d) });
  shaders = createShaders({ config, arclamp, db, instances, pools });
  base = createBaseColor({ signingKey: KEY, db, instances, pools, arclamp, script: async () => SCRIPT, linked: () => linkedNow, holdMs: 2000, retryMs: 60_000 });
});

afterEach(() => base.stop());

/** Base Color in, its params linked, and let go of being held. */
async function started() {
  await base.start();
  linkedNow = true;
  await settle(80);
}

describe("Base Color", () => {
  it("goes in as vibes starts: vibes' own sketch and build, at the bottom, on every light, its values the room tone's", async () => {
    await base.start();
    expect(db.sketch(BASE_COLOR.sketch)?.name).toBe("Base Color");
    const inst = db.instance(BASE_COLOR.instance)!;
    expect(inst).toMatchObject({ state: "live", home: LIGHTS, pool_id: BASE_COLOR.pool, sketch_id: BASE_COLOR.sketch });
    // Its script, stamped as a build of its sketch, as this instance.
    const read = readStamp(scene.get(inst.shader_id!)!.script!, KEY);
    expect(read).toMatchObject({ verified: true, stamp: { sketch: BASE_COLOR.sketch, shader: BASE_COLOR.instance, builder: "vibes" } });
    // Held muted, on every light (no mask), until its params reach it.
    expect(calls).toEqual([`create ${inst.shader_id} at 1 muted`]);
    const pool = pools.get(BASE_COLOR.pool)!;
    expect(pool.declared).toEqual(BASE_COLOR_SPECS);
    expect(pool.values.color).toEqual({ "1": { a: 0.1, b: 0.2, lm: 500, fidelity: 1 }, "2": { a: -0.05, b: 0.1, lm: 250, fidelity: 0.5 } });
    expect(pool.values.on).toEqual({ "6": false });
  });

  it("is let go of, muted, once its params reach it; or once it's waited long enough", async () => {
    await base.start();
    const id = baseId()!;
    await settle(100);
    expect(calls).toEqual([`create ${id} at 1 muted`]);
    linkedNow = true;
    await settle(100);
    expect(calls).toEqual([`create ${id} at 1 muted`, `muted ${id} false`]);
  });

  it("starting again, finds itself by its stamp: not put in twice, not held", async () => {
    await started();
    const id = baseId()!;
    calls = [];
    db.updateInstance(BASE_COLOR.instance, { state: "building", shader_id: null });
    await base.start();
    expect(baseId()).toBe(id);
    expect(calls).toEqual([]);
  });

  it("when its shader's gone, goes back in as it last was, its values kept", async () => {
    await started();
    const was = baseId()!;
    // Muted and masked off 3 by someone, as the feed then sees it.
    scene.set(was, { ...scene.get(was)!, muted: true, mask: [3] });
    base.scene(stack());
    const values = pools.get(BASE_COLOR.pool)!.values;
    calls = [];
    scene.delete(was);
    instances.forget(was);
    await settle(80);
    const now = baseId()!;
    expect(now).not.toBe(was);
    expect(calls).toEqual([`create ${now} at 1 muted mask 3`]);
    // Muted as it was: not unmuted on being let go of.
    await settle(80);
    expect(calls).toEqual([`create ${now} at 1 muted mask 3`]);
    expect(pools.get(BASE_COLOR.pool)!.values).toEqual(values);
  });

  it("can't be taken out, its code updated or its home moved, by any key", async () => {
    await started();
    await expect(shaders.remove(BASE_COLOR.instance, ada)).rejects.toMatchObject({ status: 403, code: "base_color" });
    await expect(shaders.remove(`rclamp-${baseId()}`, ada)).rejects.toMatchObject({ status: 403, code: "base_color" });
    await expect(shaders.setHome(BASE_COLOR.instance, [1], ada)).rejects.toMatchObject({ status: 403, code: "base_color" });
    expect(await instances.update(BASE_COLOR.instance, undefined, ada)).toMatchObject({ code: "base_color" });
    expect(scene.has(baseId()!)).toBe(true);
  });

  it("can be muted and masked like any shader", async () => {
    await started();
    const id = baseId()!;
    await shaders.setMuted(BASE_COLOR.instance, true, ada);
    await shaders.setMask(BASE_COLOR.instance, [2], ada);
    expect(scene.get(id)).toMatchObject({ muted: true, mask: [2] });
  });

  it("an update taking it out, or moving its home, is refused whole", async () => {
    await started();
    const layout = {} as unknown as LayoutEdits;
    const updates = createUpdates({ shaders, instances, pools, layout, setRoomtone: async () => {}, shown: async () => {} });
    const told: RoomMessage[] = [];
    const session = updates.session(ada, (m) => told.push(m));
    session.take("u1", [[`shaders/${BASE_COLOR.instance}`]]);
    session.take("u2", [[`shaders/${BASE_COLOR.instance}/instance/home`, [1, 2]]]);
    await settle(20);
    expect(told).toMatchObject([
      { type: "refused", id: "u1", code: "base_color" },
      { type: "refused", id: "u2", code: "base_color" },
    ]);
    expect(scene.has(baseId()!)).toBe(true);
  });

  it("stays at the bottom: moved back when something's put under it, and wherever a reorder puts it", async () => {
    await started();
    const id = baseId()!;
    // Someone puts a shader in under it, through arclamp.
    scene.set(99, { id: 99, type: "js", position: 0, script: "x", state: "running", muted: false, created_by: "x", modified_by: "x" });
    place(99, 1);
    calls = [];
    base.scene(stack());
    await settle();
    expect(calls).toEqual([`move ${id} 1`]);
    expect(scene.get(id)!.position).toBe(1);
    // A reorder with it on top (or left out) leaves it at the bottom.
    calls = [];
    await shaders.reorder([BASE_COLOR.instance, "rclamp-99"], ada);
    expect(scene.get(id)!.position).toBe(1);
    await shaders.reorder(["rclamp-99"], ada);
    expect(scene.get(id)!.position).toBe(1);
  });

  it("a sketch put in at the bottom goes in just above it", async () => {
    await started();
    db.addSketch({ id: SKETCH, name: "Warm wave", by_id: ada.id, by_name: ada.name, at: 0 });
    const commit = "6".repeat(40);
    db.addBuild({ id: "b1", sketch_id: SKETCH, commit_sha: commit, builder: "1", by_id: ada.id, by_name: ada.name, at: 0 });
    db.finishBuild("b1", { state: "built", finished_at: 1, plan: "vite main.ts", error: null, log: "", script: stamp(SCRIPT, { sketch: SKETCH, commit, builder: "1" }, KEY) });
    calls = [];
    const made = await instances.create(SKETCH, { branch: "main", build: "b1" }, [1, 2], ada, undefined, { above: "" });
    expect("instance" in made).toBe(true);
    const id = db.instance((made as { instance: { id: string } }).instance.id)!.shader_id!;
    expect(calls[0]).toBe(`create ${id} at 2 mask 3,4,5,6`);
    expect(scene.get(baseId()!)!.position).toBe(1);
  });

  it("an instance still noted as the id its new shader got is forgotten: that id's another shader's now", async () => {
    // An instance from before arclamp restarted, noted as shader 1.
    db.addSketch({ id: SKETCH, name: "Warm wave", by_id: ada.id, by_name: ada.name, at: 0 });
    db.addInstance({ id: "0f4527e5-4faf-4691-b789-e4c3891754aa", sketch_id: SKETCH, build_id: "old", home: [1], by_id: ada.id, by_name: ada.name, at: 0, pool_id: "0f4527e5-4faf-4691-b789-e4c3891754ab" });
    db.updateInstance("0f4527e5-4faf-4691-b789-e4c3891754aa", { shader_id: 1, state: "live" });
    await base.start();
    expect(baseId()).toBe(1);
    expect(db.instance("0f4527e5-4faf-4691-b789-e4c3891754aa")).toBeUndefined();
    expect(db.instanceOfShader(1)?.id).toBe(BASE_COLOR.instance);
  });

  it("isn't among the sketches, to open, build or delete", async () => {
    await started();
    const app = new Hono<AuthEnv>()
      .use("*", async (c, next) => {
        c.set("user", ada);
        await next();
      })
      .route("/", sketchRoutes({ dir: "/nonexistent" } as never, db, {} as never, {} as never));
    expect(await (await app.request("/")).json()).toEqual({ sketches: [] });
    expect((await app.request(`/${BASE_COLOR.sketch}`)).status).toBe(404);
    expect((await app.request(`/${BASE_COLOR.sketch}`, { method: "DELETE" })).status).toBe(404);
    expect((await app.request(`/${BASE_COLOR.sketch}/builds`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(404);
    expect(db.sketch(BASE_COLOR.sketch)?.deleted_at).toBeNull();
  });
});
