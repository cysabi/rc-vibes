// The Base Tone in the room (shared/base-color.ts). As vibes starts: Tone's
// build (default-sketches.ts, as every default sketch's is made), and the
// base Tone's instance (instances.ts' keepBase), at its params' defaults (it
// copies nothing in from anywhere, so nothing it has is ever hidden from
// view). From then on, kept: at the bottom (moved back there whenever
// something's put under it), and what it last was (muted, its mask) noted,
// so when its shader's gone (instances.ts' lost), it's back in as it was.
// Taken out (its instance and pool with it), a new one goes in, at its
// defaults. Gone in anew, it's held muted until its params have reached it;
// and while it can't go in (arclamp away), it's tried again now and then.
//
// Its build is every Tone's, so any Tone added to the room runs the base's
// code.

import type { ShaderDescriptor } from "../shared/arclamp.ts";
import { BASE_COLOR, BASE_COLOR_SPECS } from "../shared/base-color.ts";
import type { Arclamp } from "./arclamp.ts";
import type { Db } from "./db.ts";
import type { DefaultSketches } from "./default-sketches.ts";
import { VIBES } from "./default-sketches.ts";
import type { Instances } from "./instances.ts";
import type { Pools } from "./pools.ts";

export { VIBES };

// Gone in anew, it's held muted this long at most for its params to reach it.
const HOLD_MS = 10_000;
const HOLD_LOOK_MS = 50;
// While it couldn't go in, it's tried again this often.
const RETRY_MS = 5_000;

const sameIds = (a: readonly number[], b: readonly number[]) => [...a].sort((x, y) => x - y).join() === [...b].sort((x, y) => x - y).join();

/** A shader in the scene, as the feed sees it each time it's made. */
export interface SceneShader {
  id: number;
  position: number;
  muted: boolean;
  mask: number[];
}

export interface BaseColorDeps {
  db: Db;
  /** Tone's build, as every default sketch's is made. */
  defaults: Pick<DefaultSketches, "build">;
  instances: Pick<Instances, "keepBase">;
  pools: Pick<Pools, "adopt" | "declare">;
  arclamp: Pick<Arclamp, "setMuted" | "moveShader">;
  /** Whether its pool's stream is open, so its params have reached it (params.ts); null with no params to wait for. */
  linked: ((pool: string) => boolean) | null;
  retryMs?: number;
  holdMs?: number;
}

export function createBaseColor({ db, defaults, instances, pools, arclamp, linked, retryMs = RETRY_MS, holdMs = HOLD_MS }: BaseColorDeps) {
  const owner = `instance:${BASE_COLOR.instance}`;
  // Held muted, gone in anew, until its params reach it: its shader's id.
  let holding: number | null = null;
  let moving = false;
  let stopped = false;

  /** In the room, as it's to be. */
  async function keep() {
    try {
      const buildId = await defaults.build(BASE_COLOR.sketch);
      pools.adopt(BASE_COLOR.pool, owner);
      // Its knobs, from the start: what its code says once it runs.
      pools.declare(BASE_COLOR.pool, BASE_COLOR_SPECS, owner);
      await instances.keepBase(buildId, VIBES);
    } catch (err) {
      console.warn(`Base Tone: couldn't put it in: ${(err as Error).message}`);
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
      console.warn(`Base Tone: couldn't unmute it: ${(err as Error).message}`);
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
        .catch((err: Error) => console.warn(`Base Tone: couldn't move it back to the bottom: ${err.message}`))
        .finally(() => (moving = false));
    },

    stop() {
      stopped = true;
      clearInterval(retry);
    },
  };
}

export type BaseColor = ReturnType<typeof createBaseColor>;
