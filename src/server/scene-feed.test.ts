import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ShaderDescriptor } from "../shared/arclamp.ts";
import type { SceneFeed } from "../shared/vibes.ts";
import { openDb, type Db } from "./db.ts";
import { loadConfig } from "./env.ts";
import type { Instances } from "./instances.ts";
import { createSceneFeed, type SceneFeedSource } from "./scene-feed.ts";

const config = loadConfig({ ARCLAMP_BASE_URL: "http://127.0.0.1:1", ARCLAMP_KEY: "k", SESSION_SECRET: "s".repeat(32), VIBES_SIGNING_KEY: "k".repeat(32), VIBES_DEV_LOGIN: "1" });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const roomtone: ShaderDescriptor = { id: 0, type: "roomtone", position: 0, template: { lights: {} }, state: "running", muted: false, created_by: "system", modified_by: "system" };
const shader = (id: number, script: string, changing: number[]): ShaderDescriptor => ({
  id,
  type: "js",
  position: 1,
  script,
  changing,
  state: "running",
  muted: false,
  created_by: "x",
  modified_by: "x",
});

let db: Db;
let scene: ShaderDescriptor[];
let feed: SceneFeedSource;

beforeEach(() => {
  db = openDb(":memory:");
  scene = [roomtone];
});
afterEach(() => feed.stop());

const start = (instances: () => Instances | null = () => null) => {
  feed = createSceneFeed({ config, db, arclamp: { scene: async () => scene }, instances, everyMs: 60_000 });
};

describe("the scene feed", () => {
  it("leaves scripts out, saying which by hash, and keeps them for the preview", async () => {
    scene = [roomtone, shader(3, "function update(p) { return p; }", [])];
    start();
    const now = (await feed.refresh())!;
    expect(now.nodes[1]).not.toHaveProperty("script");
    expect(now.nodes[1]!.scriptHash).toBe(sha("function update(p) { return p; }"));
    expect(feed.scripts().get(sha("function update(p) { return p; }"))).toBe("function update(p) { return p; }");
    expect(now.nodes[0]).not.toHaveProperty("footprint");
  });

  it("learns each shader's footprint, keeps it, and starts again with a new script", async () => {
    scene = [roomtone, shader(3, "one", [1, 2])];
    start();
    await feed.refresh();
    scene = [roomtone, shader(3, "one", [2, 5])];
    expect((await feed.refresh())!.nodes[1]!.footprint).toEqual([1, 2, 5]);
    expect(db.footprints()).toEqual([{ shaderId: 3, scriptHash: sha("one"), lights: [1, 2, 5] }]);

    // Kept across vibes restarting.
    feed.stop();
    start();
    scene = [roomtone, shader(3, "one", [])];
    expect((await feed.refresh())!.nodes[1]!.footprint).toEqual([1, 2, 5]);

    scene = [roomtone, shader(3, "two", [6])];
    expect((await feed.refresh())!.nodes[1]!.footprint).toEqual([6]);
    scene = [roomtone];
    await feed.refresh();
    expect(db.footprints()).toEqual([]);
  });

  it("tells its subscribers only when something's different", async () => {
    scene = [roomtone, shader(3, "one", [1])];
    start();
    await feed.refresh();
    const heard: SceneFeed[] = [];
    feed.subscribe((f) => heard.push(f));
    await feed.refresh();
    expect(heard).toHaveLength(0);
    scene = [roomtone, { ...shader(3, "one", [1]), muted: true }];
    await feed.refresh();
    expect(heard).toHaveLength(1);
    expect(heard[0]!.nodes[1]!.muted).toBe(true);
  });

  it("shows each shader's instance, and the instances not in the room yet", async () => {
    db.addSketch({ id: "s1", name: "Warm wave", by_id: "rc:1", by_name: "Ada", at: 0 });
    db.addBuild({ id: "b1", sketch_id: "s1", commit_sha: "a".repeat(40), builder: "1", by_id: "rc:1", by_name: "Ada", at: 0 });
    db.addInstance({ id: "i1", sketch_id: "s1", build_id: "b1", home: [1, 2], by_id: "rc:1", by_name: "Ada", at: 1 });
    db.addInstance({ id: "i2", sketch_id: "s1", build_id: "b1", home: [3], by_id: "rc:1", by_name: "Ada", at: 2 });
    db.updateInstance("i1", { shader_id: 3, state: "live" });
    const forgot: number[] = [];
    const fake = {
      view: (row: { id: string; home: number[] }) => ({ id: row.id, home: row.home }),
      forget: (id: number) => {
        forgot.push(id);
        db.deleteInstance(db.instanceOfShader(id)!.id);
      },
    } as unknown as Instances;
    scene = [roomtone, shader(3, "one", [1])];
    start(() => fake);
    const now = (await feed.refresh())!;
    expect(now.nodes[1]!.instance).toEqual({ id: "i1", home: [1, 2] });
    expect(now.pending).toEqual([{ id: "i2", home: [3] }]);

    // Its shader gone from arclamp (removed some other way): so is the instance.
    scene = [roomtone];
    await feed.refresh();
    expect(forgot).toEqual([3]);
    expect(db.instances().map((i) => i.id)).toEqual(["i2"]);
  });

  it("keeps the last scene while arclamp's away", async () => {
    scene = [roomtone, shader(3, "one", [])];
    start();
    await feed.refresh();
    feed.stop();
    feed = createSceneFeed({ config, db, arclamp: { scene: async () => Promise.reject(new Error("down")) }, everyMs: 60_000 });
    expect(await feed.refresh()).toBeNull();
  });
});
