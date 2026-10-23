import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { ShaderDescriptor } from "../shared/arclamp.ts";
import type { Build, Instance, Me } from "../shared/vibes.ts";
import { handleError } from "./api.ts";
import type { AuthEnv } from "./auth.ts";
import { openDb, type Db } from "./db.ts";
import { loadConfig } from "./env.ts";
import { createInstances, instanceRoutes, type Instances } from "./instances.ts";
import { createShaders, shaderRoutes } from "./shaders.ts";
import { readStamp, stamp, stampAs } from "./stamp.ts";

const KEY = "k".repeat(32);
const ada: Me = { id: "rc:1", name: "Ada", dev: false };
const SKETCH = "0f4527e5-4faf-4691-b789-e4c389175401";
const LIGHTS = [1, 2, 3, 4, 5, 6];
const config = loadConfig({ ARCLAMP_BASE_URL: "http://127.0.0.1:1", ARCLAMP_KEY: "k", SESSION_SECRET: "s".repeat(32), VIBES_SIGNING_KEY: KEY, VIBES_DEV_LOGIN: "1" });

let db: Db;
let shaders: Map<number, ShaderDescriptor>;
let instances: Instances;
let app: Hono<AuthEnv>;
let finish: (id: string) => void;
let changes: number;
// The instances whose params were sent on, in order.
let sent: string[];
// What builds.start answers next: built at once, or still building.
let nextBuild: { id: string; commit: string; built: boolean };
// What builds.start was asked to build: a branch, or a commit.
let asked: string[];
// What arclamp was asked to do to shaders' mutes and masks, in order.
let calls: string[];

const scriptOf = (commit: string) => stamp(`function update(p) { return p; } // ${commit}\n`, { sketch: SKETCH, commit, builder: "1" }, KEY);

function addBuild(id: string, commit: string, built: boolean) {
  db.addBuild({ id, sketch_id: SKETCH, commit_sha: commit, builder: "1", by_id: ada.id, by_name: ada.name, at: 0 });
  if (built) db.finishBuild(id, { state: "built", finished_at: 1, plan: "vite main.ts", error: null, log: "", script: scriptOf(commit) });
}

/** A build that was building, now done. */
function done(id: string, ok = true) {
  const b = db.build(id)!;
  db.finishBuild(id, ok ? { state: "built", finished_at: 2, plan: "vite main.ts", error: null, log: "", script: scriptOf(b.commit_sha) } : { state: "failed", finished_at: 2, plan: null, error: "it didn't compile", log: "", script: null });
  finish(id);
}

const settle = () => new Promise((r) => setTimeout(r, 0));
/** An instance's shader in arclamp, once it's in. */
const shaderOf = (inst: Instance) => db.instance(inst.id)?.shader_id ?? null;

beforeEach(() => {
  db = openDb(":memory:");
  db.addSketch({ id: SKETCH, name: "Warm wave", by_id: ada.id, by_name: ada.name, at: 0 });
  shaders = new Map();
  changes = 0;
  let next = 1;
  const arclamp = {
    shader: async (id: number) => {
      const d = shaders.get(id);
      if (!d) throw Object.assign(new Error("no such shader"), { status: 404 });
      return d;
    },
    // As arclamp does: put in at `position` (on top without one), the rest above it moving up.
    createShader: async (script: string, position?: number) => {
      const stack = [...shaders.values()].sort((a, b) => a.position - b.position);
      const at = Math.min(Math.max(position ?? stack.length + 1, 1), stack.length + 1);
      for (const s of stack) if (s.position >= at) shaders.set(s.id, { ...s, position: s.position + 1 });
      const d: ShaderDescriptor = { id: next++, type: "js", position: at, script, state: "running", muted: false, created_by: "vibes", modified_by: "vibes" };
      shaders.set(d.id, d);
      return d;
    },
    setScript: async (id: number, script: string) => {
      const d = { ...shaders.get(id)!, script };
      shaders.set(id, d);
      return d;
    },
    setMask: async (id: number, mask: number[]) => {
      calls.push(`mask ${id} ${mask.join(",")}`);
      shaders.set(id, { ...shaders.get(id)!, mask });
    },
    deleteShader: async (id: number) => void shaders.delete(id),
    scene: async () => [...shaders.values()],
    setMuted: async (id: number, muted: boolean) => {
      calls.push(`muted ${id} ${muted}`);
      shaders.set(id, { ...shaders.get(id)!, muted });
    },
    moveShader: async () => {},
  };
  asked = [];
  calls = [];
  const builds = {
    start: async (_sketch: string, rev: string, user: Me) => {
      asked.push(rev);
      if (!db.build(nextBuild.id)) addBuild(nextBuild.id, nextBuild.commit, nextBuild.built);
      const b = db.build(nextBuild.id)!;
      return { build: { id: b.id, sketchId: SKETCH, commit: b.commit_sha, state: b.state, by: user.name } as unknown as Build };
    },
    onFinish: (listener: (id: string) => void) => {
      finish = listener;
      return () => {};
    },
  };
  sent = [];
  instances = createInstances({ config, db, arclamp, builds, lightIds: async () => LIGHTS, changed: () => changes++, sendParams: (id) => sent.push(id) });
  app = new Hono<AuthEnv>()
    .use("*", async (c, next) => {
      c.set("user", ada);
      await next();
    })
    .route("/", instanceRoutes(instances))
    .route("/", shaderRoutes(createShaders({ config, arclamp, db, instances })));
  // A refusal thrown by a shader route is answered as the API answers it.
  app.onError(handleError);
});

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("an instance", () => {
  it("of a built commit goes straight in, masked off everything outside its home", async () => {
    nextBuild = { id: "b1", commit: "a".repeat(40), built: true };
    const res = await send("POST", "/instances", { sketch: SKETCH, home: [2, 3, 3] });
    expect(res.status).toBe(202);
    const inst = (await res.json()) as Instance;
    expect(inst).toMatchObject({ state: "live", home: [2, 3], commit: "a".repeat(40), sketchName: "Warm wave", by: { name: "Ada" } });
    const d = shaders.get(shaderOf(inst)!)!;
    // Its build's script, stamped as this shader.
    expect(d.script).toBe(stampAs(scriptOf("a".repeat(40)), inst.id, KEY));
    expect(readStamp(d.script!, KEY)).toMatchObject({ verified: true, stamp: { shader: inst.id } });
    expect(d.mask).toEqual([1, 4, 5, 6]);
    expect(db.activity(1)[0]).toMatchObject({ action: "shader.create", shaderName: "Warm wave" });
  });

  it("is only in vibes while it builds, and goes in once built", async () => {
    nextBuild = { id: "b2", commit: "b".repeat(40), built: false };
    const inst = (await (await send("POST", "/instances", { sketch: SKETCH, home: LIGHTS })).json()) as Instance;
    expect(inst).toMatchObject({ state: "building" });
    expect(shaderOf(inst)).toBeNull();
    expect(shaders.size).toBe(0);
    done("b2");
    await settle();
    const live = instances.view(db.instance(inst.id)!);
    expect(live.state).toBe("live");
    // Home is every light: nothing to mask.
    expect(shaders.get(shaderOf(live)!)!.mask).toBeUndefined();
    expect(changes).toBeGreaterThan(1);
  });

  it("that couldn't build stays, failed, with why", async () => {
    nextBuild = { id: "b3", commit: "c".repeat(40), built: false };
    const inst = (await (await send("POST", "/instances", { sketch: SKETCH, home: [1] })).json()) as Instance;
    done("b3", false);
    await settle();
    expect(instances.view(db.instance(inst.id)!)).toMatchObject({ state: "failed", error: "it didn't compile" });
    expect((await send("DELETE", `/shaders/${inst.id}`)).status).toBe(204);
    expect(db.instance(inst.id)).toBeUndefined();
  });

  it("is from a branch, main unless it says, at its head unless a commit's given", async () => {
    nextBuild = { id: "b8", commit: "2".repeat(40), built: false };
    expect(await (await send("POST", "/instances", { sketch: SKETCH, home: [1] })).json()).toMatchObject({ branch: "main" });
    expect(await (await send("POST", "/instances", { sketch: SKETCH, branch: "ada/try", home: [1] })).json()).toMatchObject({ branch: "ada/try" });
    expect(await (await send("POST", "/instances", { sketch: SKETCH, branch: "ada/try", commit: "2222222", home: [1] })).json()).toMatchObject({ branch: "ada/try" });
    expect(asked).toEqual(["main", "ada/try", "2222222"]);
    expect((await send("POST", "/instances", { sketch: SKETCH, branch: "../x", home: [1] })).status).toBe(400);
  });

  it("with a key, is put in once, however often (or at once) it's asked, by the one who asked", async () => {
    nextBuild = { id: "b11", commit: "5".repeat(40), built: false };
    const ask = () => send("POST", "/instances", { sketch: SKETCH, home: [1], key: "+one" });
    const [a, b] = await Promise.all([ask(), ask()]);
    const again = await ask();
    const ids = await Promise.all([a, b, again].map(async (r) => ((await r.json()) as Instance).id));
    expect(new Set(ids).size).toBe(1);
    expect(db.instances()).toHaveLength(1);
    expect(asked).toEqual(["main"]);
    // Without one, each ask is its own.
    await send("POST", "/instances", { sketch: SKETCH, home: [1] });
    await send("POST", "/instances", { sketch: SKETCH, home: [1] });
    expect(db.instances()).toHaveLength(3);
  });

  it("updates to its branch's head, unless it's given a commit", async () => {
    nextBuild = { id: "b9", commit: "3".repeat(40), built: true };
    const inst = (await (await send("POST", "/instances", { sketch: SKETCH, branch: "ada/try", home: [1] })).json()) as Instance;
    nextBuild = { id: "b10", commit: "4".repeat(40), built: false };
    await send("POST", `/instances/${inst.id}/update`, {});
    await send("POST", `/instances/${inst.id}/update`, { commit: "4444444" });
    expect(asked).toEqual(["ada/try", "ada/try", "4444444"]);
  });

  it("needs a sketch, and a home of real lights", async () => {
    nextBuild = { id: "b4", commit: "d".repeat(40), built: true };
    expect((await send("POST", "/instances", { sketch: SKETCH, home: [] })).status).toBe(400);
    expect((await send("POST", "/instances", { sketch: SKETCH, home: [99] })).status).toBe(400);
    expect((await send("POST", "/instances", { sketch: "nope", home: [1] })).status).toBe(404);
    expect(shaders.size).toBe(0);
  });

  it("updates to a newer commit once that's built, the old one running meanwhile", async () => {
    nextBuild = { id: "b5", commit: "e".repeat(40), built: true };
    const inst = (await (await send("POST", "/instances", { sketch: SKETCH, home: [1, 2] })).json()) as Instance;
    nextBuild = { id: "b6", commit: "f".repeat(40), built: false };
    const updating = (await (await send("POST", `/instances/${inst.id}/update`, {})).json()) as Instance;
    expect(updating.next).toMatchObject({ commit: "f".repeat(40), state: "building" });
    expect(shaders.get(shaderOf(inst)!)!.script).toBe(stampAs(scriptOf("e".repeat(40)), inst.id, KEY));
    done("b6");
    await settle();
    expect(shaders.get(shaderOf(inst)!)!.script).toBe(stampAs(scriptOf("f".repeat(40)), inst.id, KEY));
    expect(instances.view(db.instance(inst.id)!)).toMatchObject({ commit: "f".repeat(40), next: null });
  });

  it("moves home: lights still in it keep being off, new ones start on, the rest are masked", async () => {
    nextBuild = { id: "b7", commit: "1".repeat(40), built: true };
    const inst = (await (await send("POST", "/instances", { sketch: SKETCH, home: [1, 2, 3] })).json()) as Instance;
    // Switched off on 2, through the mask (and kept off outside its home).
    expect(await instances.within(shaderOf(inst)!, [2])).toEqual([2, 4, 5, 6]);
    shaders.set(shaderOf(inst)!, { ...shaders.get(shaderOf(inst)!)!, mask: [2, 4, 5, 6] });
    const moved = (await (await send("PUT", `/instances/${inst.id}/home`, { home: [2, 3, 4] })).json()) as Instance;
    expect(moved.home).toEqual([2, 3, 4]);
    expect(shaders.get(shaderOf(inst)!)!.mask).toEqual([1, 2, 5, 6]);
  });

  it("goes when it's taken out, or its shader's removed", async () => {
    nextBuild = { id: "b8", commit: "2".repeat(40), built: true };
    const one = (await (await send("POST", "/instances", { sketch: SKETCH, home: [1] })).json()) as Instance;
    const two = (await (await send("POST", "/instances", { sketch: SKETCH, home: [2] })).json()) as Instance;
    const first = shaderOf(one)!;
    expect((await send("DELETE", `/shaders/${one.id}`)).status).toBe(204);
    expect(shaders.has(first)).toBe(false);
    // By arclamp's id, it's still the instance.
    expect((await send("DELETE", `/shaders/rclamp-${shaderOf(two)}`)).status).toBe(204);
    expect(db.instances()).toEqual([]);
    // A shader that's no instance has no home to keep to.
    expect(await instances.within(42, [3])).toEqual([3]);
  });

  it("goes in as it's wanted meanwhile: muted before it's masked, and just above another shader", async () => {
    shaders.set(10, { id: 10, type: "js", position: 1, script: "a", state: "running", muted: false, created_by: "x", modified_by: "x" });
    shaders.set(11, { id: 11, type: "js", position: 2, script: "b", state: "running", muted: false, created_by: "x", modified_by: "x" });
    nextBuild = { id: "b12", commit: "6".repeat(40), built: false };
    const inst = (await (await send("POST", "/instances", { sketch: SKETCH, home: [1, 2, 3], muted: true, mask: [2], above: "rclamp-10" })).json()) as Instance;
    expect(db.instance(inst.id)).toMatchObject({ muted: true, mask: [2, 4, 5, 6], above: "rclamp-10" });
    // Wanted on after all, and off on 3 too.
    expect(await instances.want(inst.id, { muted: false, mask: [2, 3] })).toBe(true);
    done("b12");
    await settle();
    const d = shaders.get(shaderOf(inst)!)!;
    expect(d.position).toBe(2);
    expect(shaders.get(11)!.position).toBe(3);
    expect(calls).toEqual([`mask ${d.id} 2,3,4,5,6`]);
  });

  it("going in muted, is muted first", async () => {
    nextBuild = { id: "b13", commit: "7".repeat(40), built: true };
    const inst = (await (await send("POST", "/instances", { sketch: SKETCH, home: [1], muted: true })).json()) as Instance;
    expect(calls).toEqual([`muted ${shaderOf(inst)} true`, `mask ${shaderOf(inst)} 2,3,4,5,6`]);
  });

  it("goes in at the bottom, or above one still on its way in, where that's to go", async () => {
    shaders.set(10, { id: 10, type: "js", position: 1, script: "a", state: "running", muted: false, created_by: "x", modified_by: "x" });
    nextBuild = { id: "b14", commit: "8".repeat(40), built: false };
    const under = (await (await send("POST", "/instances", { sketch: SKETCH, home: [1], above: "" })).json()) as Instance;
    const over = (await (await send("POST", "/instances", { sketch: SKETCH, home: [1], above: under.id })).json()) as Instance;
    // Not where it's to be above yet: where that's to go, the bottom.
    done("b14");
    await settle();
    const stack = [...shaders.values()].sort((a, b) => a.position - b.position).map((d) => d.id);
    expect(stack).toEqual([shaderOf(under), shaderOf(over), 10]);
  });

  it("is put in as the build given, built or building, rather than building again", async () => {
    addBuild("given", "9".repeat(40), false);
    nextBuild = { id: "other", commit: "0".repeat(40), built: true };
    const inst = (await (await send("POST", "/instances", { sketch: SKETCH, home: [1], build: "given" })).json()) as Instance;
    expect(inst).toMatchObject({ buildId: "given", state: "building" });
    expect(asked).toEqual([]);
    done("given");
    await settle();
    expect(shaders.get(shaderOf(inst)!)!.script).toBe(stampAs(scriptOf("9".repeat(40)), inst.id, KEY));
    // One that failed is built again, from its branch.
    addBuild("broken", "1".repeat(40), false);
    done("broken", false);
    await send("POST", "/instances", { sketch: SKETCH, home: [1], build: "broken" });
    expect(asked).toEqual(["main"]);
  });

  it("put in just before vibes stopped, is found by its stamp, not put in again", async () => {
    nextBuild = { id: "b15", commit: "2".repeat(40), built: false };
    const inst = (await (await send("POST", "/instances", { sketch: SKETCH, home: [1] })).json()) as Instance;
    const script = stampAs(scriptOf("2".repeat(40)), inst.id, KEY)!;
    shaders.set(40, { id: 40, type: "js", position: 1, script, state: "running", muted: false, created_by: "vibes", modified_by: "vibes" });
    done("b15");
    await settle();
    expect(shaderOf(inst)).toBe(40);
    expect(shaders.size).toBe(1);
    expect(shaders.get(40)!.mask).toEqual([2, 3, 4, 5, 6]);
  });

  it("moving home before it's in keeps the lights it's off on that stay in it", async () => {
    nextBuild = { id: "b16", commit: "3".repeat(40), built: false };
    const inst = (await (await send("POST", "/instances", { sketch: SKETCH, home: [1, 2, 3], mask: [2] })).json()) as Instance;
    await send("PUT", `/instances/${inst.id}/home`, { home: [2, 3, 4] });
    expect(db.instance(inst.id)!.mask).toEqual([1, 2, 5, 6]);
  });
});

describe("an instance's params", () => {
  const speed = { name: "speed", default: 7, min: 0, max: 20, step: 0.1, label: "Speed", perLight: true };
  const bands = { name: "bands", default: 3, min: 1, max: 8, step: 1, label: "Bands", perLight: false };

  /** A built build whose script declares `speed` and `bands`, and an instance of it, live. */
  async function liveWithParams(): Promise<Instance> {
    db.addBuild({ id: "bp", sketch_id: SKETCH, commit_sha: "deadbeef".repeat(5), builder: "1", by_id: ada.id, by_name: ada.name, at: 0 });
    db.finishBuild("bp", { state: "built", finished_at: 1, plan: "vite main.ts", error: null, log: "", script: scriptOf("deadbeef".repeat(5)), params: [speed, bands] });
    nextBuild = { id: "bp", commit: "deadbeef".repeat(5), built: true };
    return (await (await send("POST", "/instances", { sketch: SKETCH, home: [1, 2, 3] })).json()) as Instance;
  }

  it("start unset, and are set for everywhere or for some lights, the rest kept; each change is sent on", async () => {
    const inst = await liveWithParams();
    expect(inst.params).toEqual({});
    expect((await send("PUT", `/shaders/${inst.id}/params/speed`, { all: 9 })).status).toBe(204);
    expect(db.instance(inst.id)!.params).toEqual({ speed: { all: 9 } });
    expect((await send("PUT", `/shaders/${inst.id}/params/speed`, { lights: { "2": 3, "3": 30 } })).status).toBe(204);
    expect(db.instance(inst.id)!.params).toEqual({ speed: { all: 9, lights: { "2": 3, "3": 20 } } });
    expect((await send("PUT", `/shaders/${inst.id}/params/speed`, { all: null, lights: { "2": null } })).status).toBe(204);
    expect(db.instance(inst.id)!.params).toEqual({ speed: { lights: { "3": 20 } } });
    expect(sent).toEqual([inst.id, inst.id, inst.id]);
    expect(instances.view(db.instance(inst.id)!).params).toEqual({ speed: { lights: { "3": 20 } } });
    expect(db.activity(1)[0]).toMatchObject({ action: "shader.param", shaderName: "Warm wave", detail: { param: "speed", lights: 1 } });
    // A run of changes to one param (a slider dragged) is one entry in the history; another param's is its own.
    expect(db.activity(10).filter((a) => a.action === "shader.param")).toHaveLength(1);
    expect((await send("PUT", `/shaders/${inst.id}/params/bands`, { all: 5 })).status).toBe(204);
    expect(db.activity(10).filter((a) => a.action === "shader.param").map((a) => a.detail?.param)).toEqual(["bands", "speed"]);
  });

  it("are only what its sketch declares, and only an instance has any", async () => {
    const inst = await liveWithParams();
    expect((await send("PUT", `/shaders/${inst.id}/params/nope`, { all: 1 })).status).toBe(404);
    expect((await send("PUT", `/shaders/${inst.id}/params/two words`, { all: 1 })).status).toBe(400);
    expect((await send("PUT", `/shaders/${inst.id}/params/speed`, { all: "fast" })).status).toBe(400);
    shaders.set(77, { id: 77, type: "js", position: 9, script: "", state: "running", muted: false, created_by: "x", modified_by: "x" });
    expect((await send("PUT", "/shaders/rclamp-77/params/speed", { all: 1 })).status).toBe(404);
    expect(sent).toEqual([]);
  });
});
