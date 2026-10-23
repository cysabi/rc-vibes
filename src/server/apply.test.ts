import { beforeEach, describe, expect, it } from "vitest";
import type { ShaderDescriptor } from "../shared/arclamp.ts";
import type { Change, Me } from "../shared/vibes.ts";
import { ArclampError } from "./arclamp.ts";
import { ApplyRefused, createApply, request, type Apply } from "./apply.ts";
import { openDb, type Db } from "./db.ts";
import { loadConfig } from "./env.ts";
import { createInstances } from "./instances.ts";
import { createShaders } from "./shaders.ts";
import { stamp } from "./stamp.ts";

const KEY = "k".repeat(32);
const ada: Me = { id: "rc:1", name: "Ada", dev: false };
const SKETCH = "0f4527e5-4faf-4691-b789-e4c389175401";
const config = loadConfig({ ARCLAMP_BASE_URL: "http://127.0.0.1:1", ARCLAMP_KEY: "k", SESSION_SECRET: "s".repeat(32), VIBES_SIGNING_KEY: KEY, VIBES_DEV_LOGIN: "1" });

let db: Db;
let shaders: Map<number, ShaderDescriptor>;
let apply: Apply;
// What arclamp (and room tone) was asked to do, in order.
let calls: string[];

const js = (id: number, position: number): ShaderDescriptor => ({ id, type: "js", position, script: "x", state: "running", muted: false, created_by: "someone", modified_by: "someone" });
/** arclamp's shaders, bottom first. */
const stack = () => [...shaders.values()].sort((a, b) => a.position - b.position).map((d) => d.id);

beforeEach(() => {
  db = openDb(":memory:");
  db.addSketch({ id: SKETCH, name: "Warm wave", by_id: ada.id, by_name: ada.name, at: 0 });
  db.addBuild({ id: "b1", sketch_id: SKETCH, commit_sha: "a".repeat(40), builder: "1", by_id: ada.id, by_name: ada.name, at: 0 });
  db.finishBuild("b1", { state: "built", finished_at: 1, plan: "vite main.ts", error: null, log: "", script: stamp("function update(p) { return p; }\n", { sketch: SKETCH, commit: "a".repeat(40), builder: "1" }, KEY) });
  calls = [];
  shaders = new Map([js(10, 1), js(11, 2)].map((d) => [d.id, d]));
  let next = 20;
  const missing = () => new ArclampError(404, "not_found", "no such shader");
  const arclamp = {
    scene: async () => [...shaders.values()],
    shader: async (id: number) => {
      const d = shaders.get(id);
      if (!d) throw missing();
      return d;
    },
    createShader: async (script: string, position?: number) => {
      const order = stack();
      const at = Math.min(position ?? order.length + 1, order.length + 1);
      order.splice(at - 1, 0, next);
      shaders.set(next, { ...js(next, at), script });
      order.forEach((id, i) => shaders.set(id, { ...shaders.get(id)!, position: i + 1 }));
      calls.push(`create ${next} at ${at}`);
      return shaders.get(next++)!;
    },
    setScript: async (id: number) => shaders.get(id)!,
    setMuted: async (id: number, muted: boolean) => {
      if (!shaders.has(id)) throw missing();
      calls.push(`muted ${id} ${muted}`);
      shaders.set(id, { ...shaders.get(id)!, muted });
    },
    setMask: async (id: number, mask: number[]) => {
      if (!shaders.has(id)) throw missing();
      calls.push(`mask ${id} ${mask.join(",")}`);
      shaders.set(id, { ...shaders.get(id)!, mask });
    },
    moveShader: async (id: number, position: number) => {
      calls.push(`move ${id} ${position}`);
      const order = stack().filter((x) => x !== id);
      order.splice(position - 1, 0, id);
      order.forEach((x, i) => shaders.set(x, { ...shaders.get(x)!, position: i + 1 }));
    },
    deleteShader: async (id: number) => {
      if (!shaders.delete(id)) throw missing();
      calls.push(`delete ${id}`);
    },
  };
  const builds = {
    start: async () => ({ refused: "no builds here", status: 409 as const }),
    onFinish: () => () => {},
  } as unknown as Parameters<typeof createInstances>[0]["builds"];
  const instances = createInstances({ config, db, arclamp, builds, lightIds: async () => [1, 2, 3, 4] });
  apply = createApply({
    shaders: createShaders({ config, arclamp, db, instances }),
    instances,
    setRoomtone: async (lights, _user, code) => calls.push(`roomtone ${JSON.stringify(lights)} ${code ?? ""}`),
  });
});

const add = (key: string, more: Partial<Extract<Change, { op: "add" }>> = {}): Change => ({ op: "add", key, sketch: SKETCH, branch: "main", build: "b1", home: [1, 2], muted: false, mask: [], ...more });

describe("an apply", () => {
  it("makes each change, in order, naming what it adds by its edit's key", async () => {
    const made = await apply(
      [
        { op: "roomtone", lights: { "1": { brightness: 0.2 } }, code: "dim" },
        { op: "remove", key: "rclamp-10" },
        add("+low", { above: "" }),
        add("+high", { above: "+low", muted: true }),
        { op: "mask", key: "+low", mask: [1] },
        { op: "stack", order: ["rclamp-11", "+high", "+low"] },
      ],
      ada,
    );
    const low = db.instance(made["+low"]!)!;
    const high = db.instance(made["+high"]!)!;
    expect(low).toMatchObject({ state: "live", client_key: "+low" });
    expect(high).toMatchObject({ state: "live", above: low.id });
    expect(stack()).toEqual([low.shader_id, high.shader_id, 11]);
    expect(calls).toEqual([
      'roomtone {"1":{"brightness":0.2}} dim',
      "delete 10",
      `create ${low.shader_id} at 1`,
      `mask ${low.shader_id} 3,4`,
      `create ${high.shader_id} at 2`,
      `muted ${high.shader_id} true`,
      `mask ${high.shader_id} 3,4`,
      `mask ${low.shader_id} 1,3,4`,
      // Already as asked: nothing moves.
    ]);
  });

  it("passes over shaders gone meanwhile", async () => {
    await apply(
      [
        { op: "remove", key: "rclamp-99" },
        { op: "muted", key: "rclamp-98", muted: true },
        { op: "muted", key: "rclamp-11", muted: true },
      ],
      ada,
    );
    expect(calls).toEqual(["muted 11 true"]);
  });

  it("stops at a change it won't make: the ones before it made, and what they added said", async () => {
    const refused = await apply([add("+one"), { op: "muted", key: "rclamp-11", muted: true }, add("+two", { sketch: "nope" }), { op: "remove", key: "rclamp-11" }], ada).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApplyRefused);
    expect(refused).toMatchObject({ at: 2, code: "not_found", message: "no such sketch" });
    expect(Object.keys((refused as ApplyRefused).made)).toEqual(["+one"]);
    expect(shaders.has(11)).toBe(true);
  });

  it("is only what a browser can say", () => {
    expect(request.safeParse({ type: "apply", id: "1", changes: [add("+a")] }).success).toBe(true);
    expect(request.safeParse({ type: "apply", id: "1", changes: [{ op: "script", key: "rclamp-11", script: "x" }] }).success).toBe(false);
    expect(request.safeParse({ type: "apply", id: "1", changes: [add("+a", { branch: "../x" })] }).success).toBe(false);
    expect(request.safeParse({ type: "apply", id: "1", changes: [{ op: "mask", key: "rclamp-11", mask: ["1"] }] }).success).toBe(false);
  });
});

describe("a param in an apply", () => {
  const speed = { name: "speed", default: 7, min: 0, max: 20, step: 0.1, label: "Speed", perLight: true };

  /** A live instance of a build whose script declares `speed`. */
  function liveInstance(): string {
    db.addBuild({ id: "bp", sketch_id: SKETCH, commit_sha: "b".repeat(40), builder: "1", by_id: ada.id, by_name: ada.name, at: 0 });
    db.finishBuild("bp", { state: "built", finished_at: 1, plan: "vite main.ts", error: null, log: "", script: "function update(p) { return p; }", params: [speed] });
    db.addInstance({ id: "0f4527e5-4faf-4691-b789-e4c389175402", sketch_id: SKETCH, build_id: "bp", home: [1, 2], by_id: ada.id, by_name: ada.name, at: 0 });
    db.updateInstance("0f4527e5-4faf-4691-b789-e4c389175402", { shader_id: 11, state: "live" });
    return "0f4527e5-4faf-4691-b789-e4c389175402";
  }

  it("changes the instance's values, for everywhere or for some lights", async () => {
    const id = liveInstance();
    await apply([{ op: "params", key: id, name: "speed", patch: { all: 9, lights: { "2": 3 } } }], ada);
    expect(db.instance(id)!.params).toEqual({ speed: { all: 9, lights: { "2": 3 } } });
  });

  it("is refused for a param the sketch doesn't declare, not passed over as gone", async () => {
    const id = liveInstance();
    await expect(apply([{ op: "params", key: id, name: "nope", patch: { all: 1 } }], ada)).rejects.toMatchObject({ at: 0, code: "no_param" });
  });

  it("isn't taken from a browser for a param with a name that isn't a word", () => {
    expect(request.safeParse({ type: "apply", id: "a", changes: [{ op: "params", key: "k", name: "two words", patch: {} }] }).success).toBe(false);
    expect(request.safeParse({ type: "apply", id: "a", changes: [{ op: "params", key: "k", name: "speed", patch: { all: null, lights: { "1": null } } }] }).success).toBe(true);
  });
});
