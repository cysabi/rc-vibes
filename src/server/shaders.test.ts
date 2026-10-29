import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { ShaderDescriptor } from "../shared/arclamp.ts";
import type { Build, Me } from "../shared/vibes.ts";
import { ArclampError } from "./arclamp.ts";
import { handleError } from "./api.ts";
import type { AuthEnv } from "./auth.ts";
import { openDb, type Db } from "./db.ts";
import { loadConfig } from "./env.ts";
import { createInstances, type Instances } from "./instances.ts";
import { createShaders, shaderOfKey, shaderRoutes } from "./shaders.ts";
import { stamp } from "./stamp.ts";

const KEY = "k".repeat(32);
const ada: Me = { id: "rc:1", name: "Ada", dev: false };
const SKETCH = "0f4527e5-4faf-4691-b789-e4c389175401";
const LIGHTS = [1, 2, 3, 4];
const config = loadConfig({ ARCLAMP_BASE_URL: "http://127.0.0.1:1", ARCLAMP_KEY: "k", SESSION_SECRET: "s".repeat(32), VIBES_SIGNING_KEY: KEY, VIBES_DEV_LOGIN: "1" });

let db: Db;
let shaders: Map<number, ShaderDescriptor>;
let instances: Instances;
let app: Hono<AuthEnv>;
// What arclamp was asked to do, in order.
let calls: string[];

const roomtone: ShaderDescriptor = { id: 1, type: "roomtone", position: 0, template: { lights: {} }, state: "running", muted: false, created_by: "system", modified_by: "system" };
const js = (id: number, position: number, script = "function update(p) { return p; }\n"): ShaderDescriptor => ({ id, type: "js", position, script, state: "running", muted: false, created_by: "someone", modified_by: "someone" });

/** arclamp's shaders, bottom first, as "id@position". */
const stack = () =>
  [...shaders.values()]
    .filter((d) => d.type === "js")
    .sort((a, b) => a.position - b.position)
    .map((d) => `${d.id}@${d.position}`);

beforeEach(() => {
  db = openDb(":memory:");
  db.addSketch({ id: SKETCH, name: "Warm wave", by_id: ada.id, by_name: ada.name, at: 0 });
  calls = [];
  shaders = new Map([roomtone, js(10, 1), js(11, 2), js(12, 3)].map((d) => [d.id, d]));
  let next = 20;
  const missing = () => new ArclampError(404, "not_found", "no such shader");
  const arclamp = {
    scene: async () => [...shaders.values()],
    shader: async (id: number) => {
      const d = shaders.get(id);
      if (!d) throw missing();
      return d;
    },
    createShader: async (script: string) => {
      const d = js(next++, shaders.size, script);
      shaders.set(d.id, d);
      return d;
    },
    setScript: async (id: number, script: string) => ({ ...shaders.get(id)!, script }),
    setMuted: async (id: number, muted: boolean) => {
      calls.push(`muted ${id} ${muted}`);
      shaders.set(id, { ...shaders.get(id)!, muted });
    },
    setMutedAt: async (id: number, muted: boolean, s: { at: number }) => {
      calls.push(`muted ${id} ${muted} at ${s.at}`);
      return s.at;
    },
    setMask: async (id: number, mask: number[]) => {
      calls.push(`mask ${id} ${mask.join(",")}`);
      shaders.set(id, { ...shaders.get(id)!, mask });
    },
    // As arclamp does: taken out of the stack, and put back in at `position`.
    moveShader: async (id: number, position: number) => {
      calls.push(`move ${id} ${position}`);
      const order = [...shaders.values()].filter((d) => d.type === "js" && d.id !== id).sort((a, b) => a.position - b.position);
      order.splice(position - 1, 0, shaders.get(id)!);
      order.forEach((d, i) => shaders.set(d.id, { ...d, position: i + 1 }));
    },
    deleteShader: async (id: number) => {
      if (!shaders.delete(id)) throw missing();
      calls.push(`delete ${id}`);
    },
  };
  const builds = {
    start: async (_sketch: string, _rev: string, user: Me) => {
      if (!db.build("b1")) db.addBuild({ id: "b1", sketch_id: SKETCH, commit_sha: "a".repeat(40), builder: "1", by_id: ada.id, by_name: ada.name, at: 0 });
      return { build: { id: "b1", sketchId: SKETCH, commit: "a".repeat(40), state: db.build("b1")!.state, by: user.name } as unknown as Build };
    },
    onFinish: () => () => {},
  };
  instances = createInstances({ config, db, arclamp, builds, lightIds: async () => LIGHTS });
  app = new Hono<AuthEnv>()
    .use("*", async (c, next) => {
      c.set("user", ada);
      await next();
    })
    .route("/", shaderRoutes(createShaders({ config, arclamp, db, instances })));
  app.onError(handleError);
});

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

/** A sketch put in on `home`: building, or (built) in the room. */
async function putIn(home: number[], built: boolean) {
  db.addBuild({ id: "b1", sketch_id: SKETCH, commit_sha: "a".repeat(40), builder: "1", by_id: ada.id, by_name: ada.name, at: 0 });
  if (built) db.finishBuild("b1", { state: "built", finished_at: 1, plan: "vite main.ts", error: null, log: "", script: stamp("function update(p) { return p; }\n", { sketch: SKETCH, commit: "a".repeat(40), builder: "1" }, KEY) });
  const made = await instances.create(SKETCH, { branch: "main" }, home, ada);
  if ("refused" in made) throw new Error(made.refused);
  return made.instance.id;
}

describe("a shader's key", () => {
  it("is an instance's id, or rclamp-<id> (an instance's shader's included); nothing else", async () => {
    const id = await putIn([1, 2], true);
    const shader = db.instance(id)!.shader_id!;
    expect(shaderOfKey(db, id)).toMatchObject({ instance: { id }, arclampId: shader });
    expect(shaderOfKey(db, `rclamp-${shader}`)).toMatchObject({ instance: { id }, arclampId: shader });
    expect(shaderOfKey(db, "rclamp-11")).toEqual({ instance: null, arclampId: 11 });
    for (const bad of ["rclamp-0", "rclamp-011", "rclamp-1e3", "rclamp-", "#11", "11", "nope"]) expect(shaderOfKey(db, bad)).toBeNull();
  });
});

describe("shaders, by key", () => {
  it("are muted and masked, however they were put in", async () => {
    expect((await send("POST", "/shaders/rclamp-11/muted", { muted: true })).status).toBe(204);
    expect((await send("POST", "/shaders/rclamp-11/mask", { mask: [3, 1, 1] })).status).toBe(204);
    expect(calls).toEqual(["muted 11 true", "mask 11 1,3"]);
    expect((await db.activity(2)).map((a) => [a.action, a.shaderId, a.shaderName])).toEqual([
      ["shader.mask", 11, "Shader #11"],
      ["shader.mute", 11, "Shader #11"],
    ]);
  });

  it("keep an instance off everything outside its home", async () => {
    const id = await putIn([1, 2], true);
    const shader = db.instance(id)!.shader_id!;
    calls = [];
    expect((await send("POST", `/shaders/${id}/mask`, { mask: [2] })).status).toBe(204);
    expect(calls).toEqual([`mask ${shader} 2,3,4`]);
    expect((await db.activity(1))[0]).toMatchObject({ action: "shader.mask", shaderName: "Warm wave" });
  });

  it("not in the room yet, keep what's wanted of them, to go in that way", async () => {
    const id = await putIn([1, 2], false);
    expect((await send("POST", `/shaders/${id}/muted`, { muted: true })).status).toBe(204);
    expect((await send("POST", `/shaders/${id}/mask`, { mask: [2] })).status).toBe(204);
    expect(db.instance(id)).toMatchObject({ muted: true, mask: [2, 3, 4] });
    expect(calls).toEqual([]);
    expect((await db.activity(2)).map((a) => [a.action, a.shaderId, a.shaderName])).toEqual([
      ["shader.mask", null, "Warm wave"],
      ["shader.mute", null, "Warm wave"],
    ]);
  });

  it("can't be changed if there's no such shader", async () => {
    expect((await send("POST", "/shaders/nope/muted", { muted: true })).status).toBe(404);
    expect((await send("POST", "/shaders/rclamp-99/muted", { muted: true })).status).toBe(404);
    // The room tone isn't one of the stack's.
    expect((await send("POST", "/shaders/rclamp-1/mask", { mask: [] })).status).toBe(404);
    expect((await send("DELETE", "/shaders/rclamp-1")).status).toBe(404);
    expect((await send("POST", "/shaders/rclamp-11/muted", { muted: "yes" })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("come out of the room: anyone's, and an instance, building or in", async () => {
    expect((await send("DELETE", "/shaders/rclamp-11")).status).toBe(204);
    expect((await db.activity(1))[0]).toMatchObject({ action: "shader.delete", shaderId: 11 });
    const building = await putIn([1], false);
    expect((await send("DELETE", `/shaders/${building}`)).status).toBe(204);
    expect(db.instance(building)).toBeUndefined();
    db.finishBuild("b1", { state: "built", finished_at: 1, plan: "vite main.ts", error: null, log: "", script: stamp("function update(p) { return p; }\n", { sketch: SKETCH, commit: "a".repeat(40), builder: "1" }, KEY) });
    const live = (await instances.create(SKETCH, { branch: "main" }, [1], ada)) as { instance: { id: string } };
    const shader = db.instance(live.instance.id)!.shader_id!;
    expect((await send("DELETE", `/shaders/${live.instance.id}`)).status).toBe(204);
    expect(shaders.has(shader)).toBe(false);
    expect(db.instances()).toEqual([]);
    // Gone already.
    expect((await send("DELETE", "/shaders/rclamp-11")).status).toBe(404);
  });
});

describe("the stack", () => {
  it("is put in the order asked, top first", async () => {
    expect((await send("PUT", "/stack", { order: ["rclamp-10", "rclamp-12", "rclamp-11"] })).status).toBe(204);
    expect(stack()).toEqual(["11@1", "12@2", "10@3"]);
    expect((await db.activity(10)).filter((a) => a.action === "shader.move").map((a) => [a.shaderId, a.detail])).toEqual(
      expect.arrayContaining([
        [10, { from: 1, to: 3 }],
        [11, { from: 2, to: 1 }],
      ]),
    );
  });

  it("is left alone when it's in that order already", async () => {
    expect((await send("PUT", "/stack", { order: ["rclamp-12", "rclamp-11", "rclamp-10"] })).status).toBe(204);
    expect(calls).toEqual([]);
  });

  it("passes over shaders not in the room, and keeps those it doesn't name on top", async () => {
    const building = await putIn([1], false);
    shaders.set(13, js(13, 4));
    expect((await send("PUT", "/stack", { order: [building, "rclamp-10", "rclamp-99", "rclamp-11", "nope", "rclamp-10"] })).status).toBe(204);
    // 12 and 13, not named, stay above.
    expect(stack()).toEqual(["11@1", "10@2", "12@3", "13@4"]);
  });

  it("places those not in yet: each just above the one under it, or at the bottom", async () => {
    const id = await putIn([1], false);
    db.addInstance({ id: "i2", sketch_id: SKETCH, build_id: "b1", home: [1], by_id: ada.id, by_name: ada.name, at: 1, pool_id: "p2" });
    expect((await send("PUT", "/stack", { order: ["rclamp-12", id, "rclamp-11", "rclamp-10", "i2"] })).status).toBe(204);
    expect(db.instance(id)!.above).toBe("rclamp-11");
    expect(db.instance("i2")!.above).toBe("");
    expect(stack()).toEqual(["10@1", "11@2", "12@3"]);
    // Above one that's an instance's: by its key.
    expect((await send("PUT", "/stack", { order: ["i2", id, "rclamp-12", "rclamp-11", "rclamp-10"] })).status).toBe(204);
    expect(db.instance("i2")!.above).toBe(id);
    expect(db.instance(id)!.above).toBe("rclamp-12");
  });

  it("is reordered one at a time", async () => {
    await Promise.all([send("PUT", "/stack", { order: ["rclamp-10", "rclamp-11", "rclamp-12"] }), send("PUT", "/stack", { order: ["rclamp-11", "rclamp-12", "rclamp-10"] })]);
    expect(stack()).toEqual(["10@1", "12@2", "11@3"]);
  });
});
