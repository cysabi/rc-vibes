import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LightsResponse, ShaderDescriptor } from "../shared/arclamp.ts";
import type { SceneFeed } from "../shared/vibes.ts";
import { ArclampError } from "./arclamp.ts";
import { openDb, type Db } from "./db.ts";
import { loadConfig } from "./env.ts";
import type { EventHandlers } from "./event-stream.ts";
import type { Instances } from "./instances.ts";
import { createSceneFeed, type SceneFeedSource } from "./scene-feed.ts";

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
// What arclamp has, and how long it takes to say.
let scene: ShaderDescriptor[];
let slow: Promise<void> | null;
let on: EventHandlers;
let feed: SceneFeedSource;

const arclamp = {
  scene: async () => {
    const now = scene;
    await slow;
    return now;
  },
  shader: async (id: number) => {
    const d = scene.find((n) => n.id === id);
    if (!d) throw new ArclampError(404, "not_found", "no such shader");
    return d;
  },
};

beforeEach(() => {
  db = openDb(":memory:");
  scene = [roomtone];
  slow = null;
});
afterEach(() => feed.stop());

const start = (instances: () => Instances | null = () => null) => {
  feed = createSceneFeed({ config, db, arclamp, follow: (handlers) => ((on = handlers), { stop() {} }), layout: async () => layout, instances });
};
const snapshot = () => on.event("snapshot", JSON.stringify(scene.map(sent)), null);
const changed = (n: ShaderDescriptor) => on.event("shader", JSON.stringify(sent(n)), null);
const removed = (id: number) => on.event("removed", JSON.stringify({ id }), null);
// Past the feed gathering events together, and any script fetches.
const settle = () => new Promise((r) => setTimeout(r, 50));
const now = () => feed.current()!.feed;

describe("the scene feed", () => {
  it("follows arclamp: the whole scene, then each shader as it changes, and as it goes", async () => {
    scene = [roomtone, shader(3, "function update(p) { return p; }")];
    start();
    snapshot();
    await settle();
    // Its script fetched once, by its hash, for the preview; left out of the feed.
    expect(now().nodes[1]).not.toHaveProperty("script");
    expect(now().nodes[1]!.scriptHash).toBe(sha("function update(p) { return p; }"));
    expect(feed.scripts().get(sha("function update(p) { return p; }"))).toBe("function update(p) { return p; }");
    expect(now().nodes[0]).not.toHaveProperty("footprint");

    const heard: SceneFeed[] = [];
    feed.subscribe((f) => heard.push(f));
    // What it's changing this second isn't news (footprints come from the light stream).
    changed(shader(3, "function update(p) { return p; }", { changing: [1, 2] }));
    await settle();
    expect(heard).toHaveLength(0);
    changed(shader(3, "function update(p) { return p; }", { muted: true }));
    await settle();
    expect(heard).toHaveLength(1);
    expect(heard[0]!.nodes[1]!.muted).toBe(true);

    removed(3);
    await settle();
    expect(now().nodes.map((n) => n.id)).toEqual([0]);
  });

  it("learns each shader's footprint from what it touches, keeps it, and starts again with a new script", async () => {
    scene = [roomtone, shader(3, "one")];
    start();
    snapshot();
    feed.touched(touching([{ id: 3, touched: [1, 2] }]));
    feed.touched(touching([{ id: 3, touched: [2, 5] }]));
    await settle();
    expect(now().nodes[1]!.footprint).toEqual([1, 2, 5]);
    feed.stop();
    expect(db.footprints()).toEqual([{ shaderId: 3, scriptHash: sha("one"), lights: [1, 2, 5] }]);

    // Kept across vibes restarting.
    start();
    snapshot();
    await settle();
    expect(now().nodes[1]!.footprint).toEqual([1, 2, 5]);

    scene = [roomtone, shader(3, "two")];
    changed(scene[1]!);
    feed.touched(touching([{ id: 3, touched: [6] }]));
    await settle();
    expect(now().nodes[1]!.footprint).toEqual([6]);
    removed(3);
    await settle();
    expect(db.footprints()).toEqual([]);
  });

  it("shows each shader's instance, and the instances not in the room yet; forgets one when arclamp says its shader's gone", async () => {
    db.addSketch({ id: "s1", name: "Warm wave", by_id: "rc:1", by_name: "Ada", at: 0 });
    db.addBuild({ id: "b1", sketch_id: "s1", commit_sha: "a".repeat(40), builder: "1", by_id: "rc:1", by_name: "Ada", at: 0 });
    for (const [id, at] of [["i1", 1], ["i2", 2], ["i3", 3]] as const) db.addInstance({ id, sketch_id: "s1", build_id: "b1", home: [at], by_id: "rc:1", by_name: "Ada", at });
    db.updateInstance("i1", { shader_id: 3, state: "live" });
    db.updateInstance("i3", { shader_id: 4, state: "live" });
    const forgot: number[] = [];
    const fake = {
      view: (row: { id: string; home: number[] }) => ({ id: row.id, home: row.home }),
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
    expect(now().nodes[1]!.instance).toEqual({ id: "i1", home: [1] });
    // 4's shader not heard of yet: still on its way in, not nowhere.
    expect(now().pending).toEqual([
      { id: "i2", home: [2] },
      { id: "i3", home: [3] },
    ]);
    expect(forgot).toEqual([]);

    // 3 removed some other way: its instance goes too. And 4, missing from a scene and from arclamp.
    removed(3);
    scene = [roomtone];
    snapshot();
    await settle();
    expect(forgot).toEqual([3, 4]);
    expect(db.instances().map((i) => i.id)).toEqual(["i2"]);
  });

  it("reads the scene back at once, when vibes has changed it, unless events overtake the read", async () => {
    scene = [roomtone, shader(3, "one")];
    start();
    snapshot();
    await settle();
    scene = [roomtone, shader(3, "one", { muted: true })];
    expect((await feed.refresh())!.nodes[1]!.muted).toBe(true);

    // A read of it unmuted, overtaken by the event of it muted again.
    scene = [roomtone, shader(3, "one")];
    let answer = () => {};
    slow = new Promise((r) => (answer = r));
    const reading = feed.refresh();
    changed(shader(3, "one", { muted: true }));
    answer();
    expect((await reading)!.nodes[1]!.muted).toBe(true);
  });

  it("keeps the last scene while arclamp's away", async () => {
    scene = [roomtone, shader(3, "one")];
    start();
    snapshot();
    await settle();
    slow = Promise.reject(new Error("down"));
    slow.catch(() => {});
    expect((await feed.refresh())!.nodes.map((n) => n.id)).toEqual([0, 3]);
  });
});
