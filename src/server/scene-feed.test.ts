import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LightsResponse, ShaderDescriptor } from "../shared/arclamp.ts";
import type { SceneFeed } from "../shared/vibes.ts";
import { ArclampError, type Arclamp, type Schedule } from "./arclamp.ts";
import { openDb, type Db, type InstanceRow } from "./db.ts";
import { loadConfig } from "./env.ts";
import type { EventHandlers } from "./event-stream.ts";
import type { Instances } from "./instances.ts";
import type { SeenShader } from "./params.ts";
import { createSceneFeed, type SceneFeedSource } from "./scene-feed.ts";
import { stamp, stampAs } from "./stamp.ts";

const config = loadConfig({ ARCLAMP_BASE_URL: "http://127.0.0.1:1", ARCLAMP_KEY: "k", SESSION_SECRET: "s".repeat(32), VIBES_SIGNING_KEY: "k".repeat(32), VIBES_DEV_LOGIN: "1" });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const roomtone: ShaderDescriptor = { id: 0, type: "roomtone", position: 0, template: { lights: {} }, state: "running", muted: false, created_by: "system", modified_by: "system" };
const shader = (id: number, script: string, more: Partial<ShaderDescriptor> = {}): ShaderDescriptor => ({
  id,
  type: "js",
  position: id,
  script,
  script_hash: sha(script),
  state: "running",
  muted: false,
  created_by: "x",
  modified_by: "x",
  ...more,
});
/** As arclamp's events send a shader: its script left out, said by hash. */
const sent = ({ script: _script, ...rest }: ShaderDescriptor) => rest;

// The lights, in arclamp's order, and a frame of the light stream saying what each shader touched.
const LIGHTS = [1, 2, 5, 6];
const layout: LightsResponse = { id_width: 1, rails: [], lights: LIGHTS.map((id) => ({ id, type: "br30", tags: [], coords: null, rail: null, channels: ["brightness"] })) };
function touching(shaders: { id: number; touched: number[] }[]): Uint8Array {
  const bytes: number[] = [];
  const header = new DataView(new ArrayBuffer(12));
  header.setUint16(8, LIGHTS.length, true);
  header.setUint16(10, 1, true);
  bytes.push(...new Uint8Array(header.buffer));
  for (const id of LIGHTS) bytes.push(id, 0b1, 0, 0, 0, 0);
  bytes.push(shaders.length, 0, 1, 0);
  for (const s of shaders) {
    const bits = s.touched.reduce((b, id) => b | (1 << LIGHTS.indexOf(id)), 0);
    bytes.push(s.id & 0xff, s.id >> 8, 0, 0, 0, bits, 0);
  }
  return new Uint8Array(bytes);
}

let db: Db;
// What arclamp has.
let scene: ShaderDescriptor[];
let on: EventHandlers;
let feed: SceneFeedSource;

const arclamp = {
  shader: async (id: number) => {
    const d = scene.find((n) => n.id === id);
    if (!d) throw new ArclampError(404, "not_found", "no such shader");
    return d;
  },
};

// arclamp taking vibes' changes, saying nothing of them until its events do
// (or it's asked: a test says what it has after a mute, mask or move).
const writes = {
  ...arclamp,
  createShader: async (script: string) => {
    const d = shader(9, script, { position: 9 });
    scene = [...scene, d];
    return d;
  },
  setScript: async (id: number, script: string) => shader(id, script),
  mergeRoomtone: async () => ({ ...roomtone, template: { lights: { "1": { brightness: 0.2 } } } }),
  setMuted: async () => {},
  setMask: async () => {},
  moveShader: async () => {},
  deleteShader: async (id: number) => void (scene = scene.filter((n) => n.id !== id)),
  clearScene: async () => {},
} as unknown as Arclamp;

beforeEach(() => {
  db = openDb(":memory:");
  scene = [roomtone];
});
afterEach(() => feed.stop());

const start = (instances: () => Instances | null = () => null) => {
  feed = createSceneFeed({ config, db, arclamp, follow: (handlers) => ((on = handlers), { stop() {} }), layout: async () => layout, instances, confirmMs: 30 });
};
const snapshot = () => on.event("snapshot", JSON.stringify(scene.map(sent)), null);
const changed = (n: ShaderDescriptor) => on.event("shader", JSON.stringify(sent(n)), null);
const removed = (id: number) => on.event("removed", JSON.stringify({ id }), null);
// Past the feed gathering events together, and any script fetches.
const settle = () => new Promise((r) => setTimeout(r, 50));
const now = () => feed.current()!.feed;
const byKey = (f: SceneFeed, key: string) => f.shaders.find((s) => s.key === key);

describe("the scene feed", () => {
  it("follows arclamp: the whole scene, then each shader as it changes, and as it goes", async () => {
    scene = [roomtone, shader(3, "function update(p) { return p; }")];
    start();
    snapshot();
    await settle();
    // Its script fetched once, by its hash, for the preview; left out of the feed.
    expect(now().shaders).toEqual([
      { key: "rclamp-3", stage: "live", name: "Shader #3", state: "running", error: null, muted: false, mask: [], sketch: null, instance: null, by: "x", footprint: [], scriptHash: sha("function update(p) { return p; }"), pool: null },
    ]);
    expect(feed.scripts().get(sha("function update(p) { return p; }"))).toBe("function update(p) { return p; }");
    expect(now().roomtone).toEqual({ lights: {} });

    const heard: SceneFeed[] = [];
    feed.subscribe((f) => heard.push(f));
    // What it's changing this second isn't news (footprints come from the light stream).
    changed(shader(3, "function update(p) { return p; }", { changing: [1, 2] }));
    await settle();
    expect(heard).toHaveLength(0);
    changed(shader(3, "function update(p) { return p; }", { muted: true }));
    await settle();
    expect(heard).toHaveLength(1);
    expect(heard[0]!.shaders[0]!.muted).toBe(true);

    removed(3);
    await settle();
    expect(now().shaders).toEqual([]);
  });

  it("learns each shader's footprint from what it touches, keeps it, and starts again with a new script", async () => {
    scene = [roomtone, shader(3, "one")];
    start();
    snapshot();
    feed.touched(touching([{ id: 3, touched: [1, 2] }]));
    feed.touched(touching([{ id: 3, touched: [2, 5] }]));
    await settle();
    expect(now().shaders[0]!.footprint).toEqual([1, 2, 5]);
    feed.stop();
    expect(db.footprints()).toEqual([{ shaderId: 3, scriptHash: sha("one"), lights: [1, 2, 5] }]);

    // Kept across vibes restarting.
    start();
    snapshot();
    await settle();
    expect(now().shaders[0]!.footprint).toEqual([1, 2, 5]);

    scene = [roomtone, shader(3, "two")];
    changed(scene[1]!);
    feed.touched(touching([{ id: 3, touched: [6] }]));
    await settle();
    expect(now().shaders[0]!.footprint).toEqual([6]);
    removed(3);
    await settle();
    expect(db.footprints()).toEqual([]);
  });

  it("shows each shader's instance by its key, and the instances not in the room yet on top; forgets one when arclamp says its shader's gone", async () => {
    db.addSketch({ id: "s1", name: "Warm wave", by_id: "rc:1", by_name: "Ada", at: 0 });
    db.addBuild({ id: "b1", sketch_id: "s1", commit_sha: "a".repeat(40), builder: "1", by_id: "rc:1", by_name: "Ada", at: 0 });
    for (const [id, at] of [["i1", 1], ["i2", 2], ["i3", 3], ["i4", 4]] as const) db.addInstance({ id, sketch_id: "s1", build_id: "b1", home: [at], by_id: "rc:1", by_name: "Ada", at, pool_id: `p-${id}` });
    db.updateInstance("i1", { shader_id: 3, state: "live" });
    db.updateInstance("i3", { shader_id: 4, state: "live" });
    db.updateInstance("i4", { state: "failed", error: "it didn't compile" });
    const forgot: number[] = [];
    const fake = {
      view: (row: InstanceRow) => ({ id: row.id, sketchId: row.sketch_id, sketchName: "Warm wave", commit: "a".repeat(40), home: row.home, state: row.state, error: row.error, by: { id: row.by_id, name: row.by_name }, at: row.at }),
      forget: (id: number) => {
        forgot.push(id);
        const inst = db.instanceOfShader(id);
        if (inst) db.deleteInstance(inst.id);
      },
    } as unknown as Instances;
    // 4 was just put in: too new for the scene arclamp sends, but there when asked.
    scene = [roomtone, shader(3, "one"), shader(4, "one")];
    start(() => fake);
    on.event("snapshot", JSON.stringify([roomtone, shader(3, "one")].map(sent)), null);
    await settle();
    // 4's shader not heard of yet: still on its way in, not nowhere. The latest on top.
    expect(now().shaders.map((s) => [s.key, s.stage, s.name])).toEqual([
      ["i4", "failed", "Warm wave"],
      ["i3", "building", "Warm wave"],
      ["i2", "building", "Warm wave"],
      ["i1", "live", "Warm wave"],
    ]);
    expect(byKey(now(), "i1")!.instance).toMatchObject({ id: "i1", home: [1] });
    expect(byKey(now(), "i4")).toMatchObject({ error: "it didn't compile", state: null, scriptHash: null, by: "Ada", sketch: { id: "s1", name: "Warm wave", commit: "a".repeat(40) } });
    expect(forgot).toEqual([]);

    // 3 removed some other way: its instance goes too. And 4, missing from a scene and from arclamp.
    removed(3);
    scene = [roomtone];
    snapshot();
    await settle();
    expect(forgot).toEqual([3, 4]);
    expect(db.instances().map((i) => i.id)).toEqual(["i2", "i4"]);
  });

  it("carries each instance's pool, and says which shaders are instances' to link, with their pools", async () => {
    const [i1, i2, i3] = ["0f4527e5-4faf-4691-b789-e4c389175411", "0f4527e5-4faf-4691-b789-e4c389175412", "0f4527e5-4faf-4691-b789-e4c389175413"];
    const SKETCH = "0f4527e5-4faf-4691-b789-e4c389175401";
    db.addSketch({ id: SKETCH, name: "Warm wave", by_id: "rc:1", by_name: "Ada", at: 0 });
    db.addBuild({ id: "b1", sketch_id: SKETCH, commit_sha: "a".repeat(40), builder: "1", by_id: "rc:1", by_name: "Ada", at: 0 });
    const built = stamp("function update(p) { return p; }", { sketch: SKETCH, commit: "a".repeat(40), builder: "1" }, config.signingKey!);
    const as = (id: string) => stampAs(built, id, config.signingKey!)!;
    db.addInstance({ id: i1, sketch_id: SKETCH, build_id: "b1", home: [1], by_id: "rc:1", by_name: "Ada", at: 1, pool_id: "pool1" });
    db.updateInstance(i1, { shader_id: 3, state: "live" });
    // Its shader's script says it's another's: not one to link.
    db.addInstance({ id: i2, sketch_id: SKETCH, build_id: "b1", home: [2], by_id: "rc:1", by_name: "Ada", at: 2, pool_id: "pool2" });
    db.updateInstance(i2, { shader_id: 4, state: "live" });
    // On its way in: no shader yet.
    db.addInstance({ id: i3, sketch_id: SKETCH, build_id: "b1", home: [2], by_id: "rc:1", by_name: "Ada", at: 3, pool_id: "pool3" });
    const fake = { view: (row: InstanceRow) => ({ id: row.id, sketchId: row.sketch_id, sketchName: "Warm wave", commit: "a".repeat(40), home: row.home, state: row.state, error: row.error, by: { id: row.by_id, name: row.by_name }, at: row.at }), forget: () => {} } as unknown as Instances;
    const seen: SeenShader[][] = [];
    scene = [roomtone, shader(3, as(i1), { respawns: 2 }), shader(4, as(i1), { state: "error" }), shader(5, "three")];
    feed = createSceneFeed({ config, db, arclamp, follow: (handlers) => ((on = handlers), { stop() {} }), layout: async () => layout, instances: () => fake, onShaders: (s) => seen.push(s), confirmMs: 30 });
    snapshot();
    await settle();
    expect(byKey(now(), i1)!.pool).toBe("pool1");
    expect(byKey(now(), i2)!.pool).toBe("pool2");
    expect(byKey(now(), i3)!.pool).toBe("pool3");
    expect(byKey(now(), "rclamp-5")!.pool).toBeNull();
    expect(seen.at(-1)).toEqual([{ instance: i1, pool: "pool1", shaderId: 3, running: true, respawns: 2, scriptHash: sha(as(i1)) }]);
  });

  it("shows those on their way in where they're to go in, as they're wanted", async () => {
    db.addSketch({ id: "s1", name: "Warm wave", by_id: "rc:1", by_name: "Ada", at: 0 });
    db.addBuild({ id: "b1", sketch_id: "s1", commit_sha: "a".repeat(40), builder: "1", by_id: "rc:1", by_name: "Ada", at: 0 });
    const put = (id: string, at: number, more: Partial<InstanceRow> = {}) =>
      db.addInstance({ id, sketch_id: "s1", build_id: "b1", home: [1], by_id: "rc:1", by_name: "Ada", at, pool_id: `p-${id}`, ...more });
    put("top", 1);
    put("over3", 2, { above: "rclamp-3", muted: true, mask: [5] });
    put("bottom", 3, { above: "" });
    put("overOver3", 4, { above: "over3" });
    // What it was to be above is gone: on top.
    put("lost", 5, { above: "rclamp-99" });
    const fake = { view: (row: InstanceRow) => ({ id: row.id, sketchId: row.sketch_id, sketchName: "Warm wave", commit: "a".repeat(40), home: row.home, state: row.state, error: row.error, by: { id: row.by_id, name: row.by_name }, at: row.at }), forget: () => {} } as unknown as Instances;
    scene = [roomtone, shader(3, "one"), shader(4, "two")];
    start(() => fake);
    snapshot();
    await settle();
    expect(now().shaders.map((s) => s.key)).toEqual(["lost", "top", "rclamp-4", "overOver3", "over3", "rclamp-3", "bottom"]);
    expect(byKey(now(), "over3")).toMatchObject({ stage: "building", muted: true, mask: [5] });
  });

  it("shows what vibes changes at once, ahead of arclamp's events, which have the last word", async () => {
    scene = [roomtone, shader(1, "one"), shader(2, "two"), shader(3, "three")];
    start();
    snapshot();
    await settle();
    const room = feed.noting(writes);
    // Top first.
    const order = (f: SceneFeed) => f.shaders.map((s) => s.key);

    await room.setMuted(2, true);
    await room.setMask(3, [6, 5, 5]);
    await room.moveShader(3, 1);
    let f = (await feed.now())!;
    expect(byKey(f, "rclamp-2")!.muted).toBe(true);
    expect(byKey(f, "rclamp-3")!.mask).toEqual([5, 6]);
    expect(order(f)).toEqual(["rclamp-2", "rclamp-1", "rclamp-3"]);

    // arclamp put it somewhere else after all (someone else moving shaders at
    // once): its events say so for 2 and 3, and 1, which no event says
    // anything of, is asked after.
    changed(shader(3, "three", { position: 3, mask: [5, 6] }));
    changed(shader(2, "two", { position: 2, muted: true }));
    await settle();
    await settle();
    expect(order(now())).toEqual(["rclamp-3", "rclamp-2", "rclamp-1"]);

    await room.setMask(3, []);
    await room.mergeRoomtone({ lights: { "1": { brightness: 0.2 } } });
    await room.createShader("nine");
    await room.deleteShader(1);
    f = (await feed.now())!;
    expect(byKey(f, "rclamp-3")!.mask).toEqual([]);
    expect(f.roomtone).toEqual({ lights: { "1": { brightness: 0.2 } } });
    expect(byKey(f, "rclamp-9")!.scriptHash).toBe(sha("nine"));
    expect(feed.scripts().get(sha("nine"))).toBe("nine");
    expect(order(f)).toEqual(["rclamp-9", "rclamp-3", "rclamp-2"]);
  });

  it("shows a mute put off for a frame when the frame comes, and never one another took the place of first", async () => {
    scene = [roomtone, shader(1, "one"), shader(2, "two")];
    start();
    snapshot();
    await settle();
    // arclamp: each mute put off goes in with the frame it says, in arclamp's
    // time (here, the feed's clock); one emplaced before then never does.
    const due = new Map<string, ReturnType<typeof setTimeout>>();
    const room = feed.noting({
      ...writes,
      setMutedAt: async (id: number, muted: boolean, s: Schedule) => {
        if (s.at <= Date.now()) return null;
        if (s.emplace) clearTimeout(due.get(s.emplace));
        due.set(
          s.id!,
          setTimeout(() => (scene = scene.map((n) => (n.id === id ? { ...n, muted } : n))), s.at - Date.now()),
        );
        return s.at;
      },
    } as unknown as Arclamp);
    const muted = async (id: number) => byKey((await feed.now())!, `rclamp-${id}`)!.muted;

    await room.setMutedAt(1, true, { at: Date.now() + 120, id: "a" });
    expect(await muted(1)).toBe(false);
    await new Promise((r) => setTimeout(r, 180));
    expect(await muted(1)).toBe(true);

    // One put off, then another in its place before its frame: the first is never shown.
    await room.setMutedAt(2, true, { at: Date.now() + 150, id: "b" });
    await room.setMutedAt(2, false, { at: Date.now() + 60, id: "c", emplace: "b" });
    for (const wait of [100, 150]) {
      await new Promise((r) => setTimeout(r, wait));
      expect(await muted(2)).toBe(false);
    }

    // Its time passed already: it went in at once, and shows at once.
    await room.setMutedAt(2, true, { at: Date.now() - 5, id: "d" });
    expect(await muted(2)).toBe(true);
  });

  it("shows nothing of vibes' changes before it's heard the whole scene", async () => {
    start();
    await feed.noting(writes).setMuted(3, true);
    expect(await feed.now()).toBeNull();
  });
});
