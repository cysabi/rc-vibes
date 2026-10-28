// Base Color in the room (shared/base-color.ts). As vibes starts: its sketch
// and its build (its own script, stamped as a build of that sketch) made, and
// its instance (instances.ts' keepBase), its first values the room tone's, so
// nothing looks different the moment it goes in. From then on, kept: at the
// bottom (moved back there whenever something's put under it), and what it
// last was (muted, its mask) noted, so when it's gone (instances.ts' lost),
// it's back in as it was. Gone in anew, it's held muted until its params
// have reached it, so it never shows its defaults; and while it can't go in
// (arclamp away), it's tried again now and then.

import { createHash } from "node:crypto";
import type { ShaderDescriptor } from "../shared/arclamp.ts";
import { BASE_COLOR, BASE_COLOR_SPECS } from "../shared/base-color.ts";
import { LUMENS_PER_BRIGHTNESS } from "../../packages/vibes/src/lemtone.ts";
import type { ColorValue } from "../shared/params.ts";
import type { Person } from "../shared/vibes.ts";
import type { Arclamp } from "./arclamp.ts";
import type { Db } from "./db.ts";
import type { Instances } from "./instances.ts";
import type { Pools } from "./pools.ts";
import { stamp } from "./stamp.ts";

/** Who vibes is, in the history, for what it does itself. */
export const VIBES: Person = { id: "vibes", name: "vibes" };

// Its builds are vibes' own, not the builder's.
const BUILDER = "vibes";
// Gone in anew, it's held muted this long at most for its params to reach it.
const HOLD_MS = 10_000;
const HOLD_LOOK_MS = 50;
// While it couldn't go in, it's tried again this often.
const RETRY_MS = 5_000;

const sha = (algo: string, s: string) => createHash(algo).update(s).digest("hex");
const sameIds = (a: readonly number[], b: readonly number[]) => [...a].sort((x, y) => x - y).join() === [...b].sort((x, y) => x - y).join();

/** A shader in the scene, as the feed sees it each time it's made. */
export interface SceneShader {
  id: number;
  position: number;
  muted: boolean;
  mask: number[];
}

export interface BaseColorDeps {
  signingKey: string;
  db: Db;
  instances: Pick<Instances, "keepBase">;
  pools: Pick<Pools, "adopt" | "declare" | "set">;
  arclamp: Pick<Arclamp, "shader" | "setMuted" | "moveShader">;
  /** Its script, built (base-color-script.ts). */
  script: () => Promise<string>;
  /** Whether its pool's stream is open, so its params have reached it (params.ts); null with no params to wait for. */
  linked: ((pool: string) => boolean) | null;
  retryMs?: number;
  holdMs?: number;
}

export function createBaseColor({ signingKey, db, instances, pools, arclamp, script, linked, retryMs = RETRY_MS, holdMs = HOLD_MS }: BaseColorDeps) {
  const owner = `instance:${BASE_COLOR.instance}`;
  let buildId: string | null = null;
  // Held muted, gone in anew, until its params reach it: its shader's id.
  let holding: number | null = null;
  let moving = false;
  let stopped = false;

  /** Its sketch, and a build of it that's its script: made, if they aren't. */
  async function made(): Promise<string> {
    const body = await script();
    const stamped = stamp(body, { sketch: BASE_COLOR.sketch, commit: sha("sha1", body), builder: BUILDER }, signingKey);
    const sketch = db.sketch(BASE_COLOR.sketch);
    if (!sketch) db.addSketch({ id: BASE_COLOR.sketch, name: BASE_COLOR.name, by_id: VIBES.id, by_name: VIBES.name, at: Date.now() });
    else if (sketch.deleted_at !== null) db.restoreSketch(BASE_COLOR.sketch);
    // A build for each script and key: vibes with other code for it, or another key, makes another.
    const id = `base-color-${sha("sha256", stamped).slice(0, 16)}`;
    if (!db.build(id)) {
      db.addBuild({ id, sketch_id: BASE_COLOR.sketch, commit_sha: sha("sha1", body), builder: BUILDER, by_id: VIBES.id, by_name: VIBES.name, at: Date.now() });
      db.finishBuild(id, { state: "built", finished_at: Date.now(), plan: "vibes' own (src/base-color)", error: null, log: "", script: stamped });
    }
    return id;
  }

  /** Its first values, the room tone's, light by light: so it looks as the room did. */
  async function seed() {
    const template = (await arclamp.shader(0)).template?.lights ?? {};
    const colors: [number, ColorValue][] = [];
    const ons: [number, boolean][] = [];
    for (const [key, ch] of Object.entries(template)) {
      const id = Number(key);
      if (ch.on !== undefined) ons.push([id, ch.on >= 0.5]);
      if (ch.a !== undefined && ch.b !== undefined && ch.brightness !== undefined) {
        colors.push([id, { a: ch.a, b: ch.b, lm: ch.brightness * LUMENS_PER_BRIGHTNESS, fidelity: ch.fidelity ?? 1 }]);
      }
    }
    await pools.set(BASE_COLOR.pool, "color", colors, owner);
    await pools.set(BASE_COLOR.pool, "on", ons, owner);
  }

  /** In the room, as it's to be. */
  async function keep() {
    try {
      buildId ??= await made();
      pools.adopt(BASE_COLOR.pool, owner);
      // Its knobs, from the start: what its code says once it runs.
      pools.declare(BASE_COLOR.pool, BASE_COLOR_SPECS, owner);
      await instances.keepBase(buildId, VIBES, seed);
    } catch (err) {
      console.warn(`Base Color: couldn't put it in: ${(err as Error).message}`);
    }
  }

  const retry = setInterval(() => {
    const inst = db.instance(BASE_COLOR.instance);
    if (!inst || inst.state === "failed") void keep();
  }, retryMs);
  retry.unref();

  /** Gone in anew, held muted: let go once its params have reached it (or it's waited long enough), as it's wanted. */
  async function hold(d: ShaderDescriptor) {
    holding = d.id;
    const until = Date.now() + holdMs;
    while (!stopped && holding === d.id && linked && !linked(BASE_COLOR.pool) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, HOLD_LOOK_MS));
    }
    if (holding !== d.id) return;
    holding = null;
    const inst = db.instance(BASE_COLOR.instance);
    if (stopped || !inst || inst.shader_id !== d.id || inst.muted) return;
    try {
      await arclamp.setMuted(d.id, false);
    } catch (err) {
      console.warn(`Base Color: couldn't unmute it: ${(err as Error).message}`);
    }
  }

  return {
    /** Made and put in: as vibes starts. */
    start: keep,

    /** Gone in anew (instances.ts' putIn): held muted until its params reach it. */
    wentIn(id: string, d: ShaderDescriptor) {
      if (id === BASE_COLOR.instance) void hold(d);
    },

    /** The scene, as the feed has made it (js shaders): it's noted as it is now, and moved back to the bottom if it's not there. */
    scene(shaders: SceneShader[]) {
      const inst = db.instance(BASE_COLOR.instance);
      if (!inst || inst.shader_id === null) return;
      const d = shaders.find((s) => s.id === inst.shader_id);
      if (!d) return;
      // What it is now, to go back in as, if it goes: not while it's held (muted only for now).
      if (holding !== d.id && (inst.muted !== d.muted || !sameIds(inst.mask ?? [], d.mask))) {
        db.updateInstance(BASE_COLOR.instance, { muted: d.muted, mask: d.mask });
      }
      if (d.position === 1 || moving) return;
      moving = true;
      arclamp
        .moveShader(d.id, 1)
        .catch((err: Error) => console.warn(`Base Color: couldn't move it back to the bottom: ${err.message}`))
        .finally(() => (moving = false));
    },

    stop() {
      stopped = true;
      clearInterval(retry);
    },
  };
}

export type BaseColor = ReturnType<typeof createBaseColor>;
