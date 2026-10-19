import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { ShaderDescriptor } from "../shared/arclamp.ts";
import type { Me } from "../shared/vibes.ts";
import type { AuthEnv } from "./auth.ts";
import { openDb, type Db } from "./db.ts";
import { loadConfig } from "./env.ts";
import { instanceRoutes } from "./instances.ts";
import { readStamp, stamp } from "./stamp.ts";

const KEY = "k".repeat(32);
const ada: Me = { id: "rc:1", name: "Ada", dev: false };
const SKETCH = "0f4527e5-4faf-4691-b789-e4c389175401";
const COMMIT = "a".repeat(40);
const BODY = "function update(prev) { return prev; }\n";
const config = loadConfig({ ARCLAMP_BASE_URL: "http://127.0.0.1:1", ARCLAMP_KEY: "k", SESSION_SECRET: "s".repeat(32), VIBES_SIGNING_KEY: KEY, VIBES_DEV_LOGIN: "1" });

let db: Db;
let app: Hono<AuthEnv>;
let shaders: Map<number, ShaderDescriptor>;

/** A build of the sketch, built, with `script` (the real one: stamped with vibes' key). */
function built(id: string, script = stamp(BODY, { sketch: SKETCH, commit: COMMIT, builder: "1" }, KEY), sketch = SKETCH) {
  db.addBuild({ id, sketch_id: sketch, commit_sha: COMMIT, builder: "1", by_id: ada.id, by_name: ada.name, at: 0 });
  db.finishBuild(id, { state: "built", finished_at: 1, plan: "vite main.ts", error: null, log: "", script });
}

beforeEach(() => {
  db = openDb(":memory:");
  db.addSketch({ id: SKETCH, name: "Warm wave", by_id: ada.id, by_name: ada.name, at: 0 });
  shaders = new Map();
  let next = 1;
  const arclamp = {
    shader: async (id: number) => {
      const d = shaders.get(id);
      if (!d) throw new Error("no such shader");
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
    deleteShader: async (id: number) => void shaders.delete(id),
  };
  app = new Hono<AuthEnv>()
    .use("*", async (c, next) => {
      c.set("user", ada);
      await next();
    })
    .route("/", instanceRoutes(config, arclamp, db));
});

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe("a build, in the room", () => {
  it("is a new shader running exactly its stamped script", async () => {
    built("b1");
    const res = await send("POST", "/shaders", { build: "b1" });
    expect(res.status).toBe(201);
    const d = (await res.json()) as ShaderDescriptor;
    expect(shaders.get(d.id)!.script).toBe(db.build("b1")!.script);
    expect(readStamp(shaders.get(d.id)!.script!, KEY)).toMatchObject({ verified: true, stamp: { sketch: SKETCH, commit: COMMIT } });
    expect(db.activity(1)[0]).toMatchObject({ action: "shader.create", shaderName: "Warm wave", detail: { sketch: SKETCH, commit: COMMIT, build: "b1" } });
  });

  it("can only be a build: never a script sent in", async () => {
    expect((await send("POST", "/shaders", { script: BODY })).status).toBe(400);
    expect(shaders.size).toBe(0);
  });

  it("isn't, unless it built, its sketch is still there, and its stamp checks out", async () => {
    expect((await send("POST", "/shaders", { build: "nope" })).status).toBe(404);
    db.addBuild({ id: "going", sketch_id: SKETCH, commit_sha: COMMIT, builder: "1", by_id: ada.id, by_name: ada.name, at: 0 });
    expect((await send("POST", "/shaders", { build: "going" })).status).toBe(404);
    built("other-key", stamp(BODY, { sketch: SKETCH, commit: COMMIT, builder: "1" }, "o".repeat(32)));
    expect((await send("POST", "/shaders", { build: "other-key" })).status).toBe(409);
    built("deleted");
    db.deleteSketch(SKETCH, ada, 1);
    expect((await send("POST", "/shaders", { build: "deleted" })).status).toBe(410);
    expect(shaders.size).toBe(0);
  });
});

describe("one of vibes' shaders", () => {
  it("runs another build instead", async () => {
    built("b1");
    built("b2", stamp(`${BODY}// newer\n`, { sketch: SKETCH, commit: "b".repeat(40), builder: "1" }, KEY));
    const d = (await (await send("POST", "/shaders", { build: "b1" })).json()) as ShaderDescriptor;
    expect((await send("PUT", `/shaders/${d.id}/build`, { build: "b2" })).status).toBe(200);
    expect(shaders.get(d.id)!.script).toBe(db.build("b2")!.script);
  });

  it("comes out of the room", async () => {
    built("b1");
    const d = (await (await send("POST", "/shaders", { build: "b1" })).json()) as ShaderDescriptor;
    expect((await send("DELETE", `/shaders/${d.id}`)).status).toBe(204);
    expect(shaders.has(d.id)).toBe(false);
  });

  it("is the only kind vibes changes or removes", async () => {
    built("b1");
    shaders.set(9, { id: 9, type: "js", position: 1, script: BODY, state: "running", muted: false, created_by: "someone", modified_by: "someone" });
    expect((await send("PUT", "/shaders/9/build", { build: "b1" })).status).toBe(409);
    expect((await send("DELETE", "/shaders/9")).status).toBe(409);
    expect(shaders.get(9)!.script).toBe(BODY);
  });
});
