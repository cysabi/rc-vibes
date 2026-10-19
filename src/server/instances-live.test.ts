import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { ShaderDescriptor } from "../shared/arclamp.ts";
import type { Build, Instance, Me } from "../shared/vibes.ts";
import type { AuthEnv } from "./auth.ts";
import { openDb, type Db } from "./db.ts";
import { loadConfig } from "./env.ts";
import { createInstances, instanceRoutes, type Instances } from "./instances.ts";
import { stamp } from "./stamp.ts";

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
// What builds.start answers next: built at once, or still building.
let nextBuild: { id: string; commit: string; built: boolean };
// What builds.start was asked to build: a branch, or a commit.
let asked: string[];

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
    createShader: async (script: string) => {
      const d: ShaderDescriptor = { id: next++, type: "js", position: shaders.size + 1, script, state: "running", muted: false, created_by: "vibes", modified_by: "vibes" };
      shaders.set(d.id, d);
      return d;
    },
    setScript: async (id: number, script: string) => {
      const d = { ...shaders.get(id)!, script };
      shaders.set(id, d);
      return d;
    },
    setMask: async (id: number, mask: number[]) => void shaders.set(id, { ...shaders.get(id)!, mask }),
    deleteShader: async (id: number) => void shaders.delete(id),
  };
  asked = [];
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
  instances = createInstances({ config, db, arclamp, builds, lightIds: async () => LIGHTS, changed: () => changes++ });
  app = new Hono<AuthEnv>()
    .use("*", async (c, next) => {
      c.set("user", ada);
      await next();
    })
    .route("/", instanceRoutes(config, arclamp, db, instances));
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
    const d = shaders.get(inst.shaderId!)!;
    expect(d.script).toBe(scriptOf("a".repeat(40)));
    expect(d.mask).toEqual([1, 4, 5, 6]);
    expect(db.activity(1)[0]).toMatchObject({ action: "shader.create", shaderName: "Warm wave" });
  });

  it("is only in vibes while it builds, and goes in once built", async () => {
    nextBuild = { id: "b2", commit: "b".repeat(40), built: false };
    const inst = (await (await send("POST", "/instances", { sketch: SKETCH, home: LIGHTS })).json()) as Instance;
    expect(inst).toMatchObject({ state: "building", shaderId: null });
    expect(shaders.size).toBe(0);
    done("b2");
    await settle();
    const live = instances.view(db.instance(inst.id)!);
    expect(live.state).toBe("live");
    // Home is every light: nothing to mask.
    expect(shaders.get(live.shaderId!)!.mask).toBeUndefined();
    expect(changes).toBeGreaterThan(1);
  });

  it("that couldn't build stays, failed, with why", async () => {
    nextBuild = { id: "b3", commit: "c".repeat(40), built: false };
    const inst = (await (await send("POST", "/instances", { sketch: SKETCH, home: [1] })).json()) as Instance;
    done("b3", false);
    await settle();
    expect(instances.view(db.instance(inst.id)!)).toMatchObject({ state: "failed", error: "it didn't compile", shaderId: null });
    expect((await send("DELETE", `/instances/${inst.id}`)).status).toBe(204);
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
    expect(shaders.get(inst.shaderId!)!.script).toBe(scriptOf("e".repeat(40)));
    done("b6");
    await settle();
    expect(shaders.get(inst.shaderId!)!.script).toBe(scriptOf("f".repeat(40)));
    expect(instances.view(db.instance(inst.id)!)).toMatchObject({ commit: "f".repeat(40), next: null });
  });

  it("moves home: lights still in it keep being off, new ones start on, the rest are masked", async () => {
    nextBuild = { id: "b7", commit: "1".repeat(40), built: true };
    const inst = (await (await send("POST", "/instances", { sketch: SKETCH, home: [1, 2, 3] })).json()) as Instance;
    // Switched off on 2, through the mask (and kept off outside its home).
    expect(await instances.within(inst.shaderId!, [2])).toEqual([2, 4, 5, 6]);
    shaders.set(inst.shaderId!, { ...shaders.get(inst.shaderId!)!, mask: [2, 4, 5, 6] });
    const moved = (await (await send("PUT", `/instances/${inst.id}/home`, { home: [2, 3, 4] })).json()) as Instance;
    expect(moved.home).toEqual([2, 3, 4]);
    expect(shaders.get(inst.shaderId!)!.mask).toEqual([1, 2, 5, 6]);
  });

  it("goes when it's taken out, or its shader's removed", async () => {
    nextBuild = { id: "b8", commit: "2".repeat(40), built: true };
    const one = (await (await send("POST", "/instances", { sketch: SKETCH, home: [1] })).json()) as Instance;
    const two = (await (await send("POST", "/instances", { sketch: SKETCH, home: [2] })).json()) as Instance;
    expect((await send("DELETE", `/instances/${one.id}`)).status).toBe(204);
    expect(shaders.has(one.shaderId!)).toBe(false);
    expect((await send("DELETE", `/shaders/${two.shaderId}`)).status).toBe(204);
    expect(db.instances()).toEqual([]);
    // A shader that's no instance has no home to keep to.
    expect(await instances.within(42, [3])).toEqual([3]);
  });
});
