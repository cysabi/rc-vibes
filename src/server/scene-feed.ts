// The scene, as vibes pushes it to browsers (/api/scene/events): arclamp's,
// looked at twice a second (arclamp has no change notifications yet), with
// each shader's sketch, footprint and instance, and the instances not in
// arclamp yet; sent whenever it's different. Scripts are left out (the
// preview fetches the ones it needs, by hash: /api/scene/scripts), so it's
// small.
//
// A footprint is every light a shader has changed since its script last did,
// before its mask or mute: where its code lights. arclamp's `changing` is
// what each changed in the last second, so looking more often than that
// misses nothing; the union is kept, in the database, and starts again with
// each new script.

import { createHash } from "node:crypto";
import type { ShaderDescriptor } from "../shared/arclamp.ts";
import type { SceneFeed, SceneNode, ShaderSketch } from "../shared/vibes.ts";
import type { Arclamp } from "./arclamp.ts";
import type { Db } from "./db.ts";
import type { Config } from "./env.ts";
import type { Instances } from "./instances.ts";
import { sketchOf } from "./stamp.ts";

const LOOK_MS = 500;

export interface FeedDeps {
  config: Config;
  db: Db;
  arclamp: Pick<Arclamp, "scene">;
  /** Instances, while sketches are on. */
  instances?: () => Instances | null;
  everyMs?: number;
}

export function createSceneFeed({ config, db, arclamp, instances = () => null, everyMs = LOOK_MS }: FeedDeps) {
  // By shader: its script's hash and sketch, worked out once per script.
  const known = new Map<number, { script: string; hash: string; sketch: ShaderSketch | undefined }>();
  const footprints = new Map(db.footprints().map((f) => [f.shaderId, { hash: f.scriptHash, lights: new Set(f.lights) }]));
  const listeners = new Set<(feed: SceneFeed, json: string) => void>();
  let latest: { feed: SceneFeed; json: string } | null = null;
  let scripts = new Map<string, string>();
  let looking: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function scriptOf(n: ShaderDescriptor) {
    const script = n.script ?? "";
    const k = known.get(n.id);
    if (k && k.script === script) return k;
    const next = { script, hash: createHash("sha256").update(script).digest("hex"), sketch: sketchOf(script, config.signingKey, db) };
    known.set(n.id, next);
    return next;
  }

  /** Adds what a shader changed lately to its footprint; true if that's news. */
  function learn(n: ShaderDescriptor, hash: string): boolean {
    let f = footprints.get(n.id);
    let grew = false;
    if (!f || f.hash !== hash) {
      f = { hash, lights: new Set() };
      footprints.set(n.id, f);
      grew = true;
    }
    for (const id of n.changing ?? []) {
      if (f.lights.has(id)) continue;
      f.lights.add(id);
      grew = true;
    }
    if (grew) db.setFootprint(n.id, hash, [...f.lights].sort((a, b) => a - b));
    return grew;
  }

  async function look() {
    let scene: ShaderDescriptor[];
    try {
      scene = await arclamp.scene();
    } catch {
      // arclamp's away: the last scene stands (the banners say so).
      return;
    }
    const live = instances();
    const here = new Set(scene.map((n) => n.id));
    // Shaders gone: their footprints, and instances, too.
    for (const id of [...footprints.keys()]) {
      if (here.has(id)) continue;
      footprints.delete(id);
      known.delete(id);
      db.deleteFootprint(id);
    }
    for (const inst of db.instances()) {
      if (inst.state === "live" && inst.shader_id !== null && !here.has(inst.shader_id)) live?.forget(inst.shader_id);
    }

    const byShader = new Map(db.instances().flatMap((i) => (i.shader_id !== null && i.state === "live" ? [[i.shader_id, i] as const] : [])));
    const nextScripts = new Map<string, string>();
    const nodes: SceneNode[] = scene.map((n) => {
      const { script: _script, ...rest } = n;
      if (n.type !== "js") return rest;
      const { script, hash, sketch } = scriptOf(n);
      nextScripts.set(hash, script);
      learn(n, hash);
      const inst = byShader.get(n.id);
      return {
        ...rest,
        scriptHash: hash,
        footprint: [...(footprints.get(n.id)?.lights ?? [])].sort((a, b) => a - b),
        ...(sketch ? { sketch } : {}),
        ...(inst && live ? { instance: live.view(inst) } : {}),
      };
    });
    scripts = nextScripts;
    const pending = live ? db.instances().filter((i) => i.state !== "live").map((i) => live.view(i)) : [];
    const feed: SceneFeed = { nodes, pending };
    const json = JSON.stringify(feed);
    if (json === latest?.json) return;
    latest = { feed, json };
    for (const listener of listeners) listener(feed, json);
  }

  // One look at a time; asked for while one's going, one more after it.
  function run(): Promise<void> {
    clearTimeout(timer);
    looking = look()
      .catch((err) => console.error("couldn't look at the scene:", err))
      .finally(() => {
        looking = null;
        if (!stopped && !queued) timer = setTimeout(() => void refresh(), everyMs);
      });
    return looking;
  }
  function next(): Promise<void> {
    if (queued) return queued;
    if (!looking) return run();
    queued = looking.then(() => {
      queued = null;
      return run();
    });
    return queued;
  }

  /** Looks now (or just after the look going, if one is), and then on every everyMs. */
  async function refresh(): Promise<SceneFeed | null> {
    await next();
    return latest?.feed ?? null;
  }

  void refresh();

  return {
    /** The scene as last seen, if it's been seen. */
    current: () => latest,
    refresh,
    /** Each shader's script, by hash (for the preview). */
    scripts: () => scripts,
    /** Tells `listener` of each new scene; returns a way to stop. */
    subscribe(listener: (feed: SceneFeed, json: string) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Something's changed (through vibes): look again now rather than later. */
    poke: () => void next(),
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

export type SceneFeedSource = ReturnType<typeof createSceneFeed>;
