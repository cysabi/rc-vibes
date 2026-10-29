// Scenes applied in a show (shared/scenes.ts), on the show's clock: every
// change one makes goes in with the same frame, the one the show's cue mode
// puts it in (shared/show.ts: cueAt), through arclamp's schedule. Mutes
// (shaders.ts: setMutedAt) and knobs (a statement run before the shader
// renders that frame: timeline.ts' applyCode) both, so the room changes all
// at once, on the beat. vibes' own record of the knobs (the pools) changes
// when the frame comes; the scene waiting for it is in the tree
// (show/queued) till then.
//
// Every change is said whole, not as a difference: a scene says which
// shaders are on (its sketch, and nothing else but Base Color) and what its
// knobs are. So applying another before the first's frame comes takes its
// place, shader by shader (each change emplacing the first's: arclamp's
// §10.1), putting back what only the first would have changed as it was
// before it; and the room ends as the second leaves it whether or not the
// first's frame came meanwhile.

import { randomUUID } from "node:crypto";
import type { LiveTree } from "../shared/live.ts";
import { sameValue, type ChangeEvent, type Changes, type ParamValue } from "../shared/params.ts";
import { isBase, type SceneKnobs } from "../shared/scenes.ts";
import { cueAt } from "../shared/show.ts";
import type { Me, Shader } from "../shared/vibes.ts";
import type { Arclamp } from "./arclamp.ts";
import type { Db } from "./db.ts";
import type { Pools } from "./pools.ts";
import type { ScenesSource } from "./scenes.ts";
import { Refused, type Shaders } from "./shaders.ts";
import type { Show } from "./show.ts";
import { applyCode, frameOf } from "./timeline.ts";

// How far ahead of now the soonest frame is: for every change to get to arclamp before it.
const LEAD_MS = 40;

/** Knobs' values, by param, by light (null: the default). */
type Values = Map<string, Map<string, ParamValue | null>>;

/** A shader's knobs as a scene applied would change them: what they'd be, and what they were before (its pool's, and its eval's schedule id, if it's in arclamp). */
interface KnobChange {
  id: string | null;
  pool: string;
  before: Values;
  after: Values;
}

/** A scene applied, waiting for its frame: each shader's changes, by their schedule ids, and how each was before. */
interface Queued {
  scene: string;
  frame: number;
  mutes: Map<string, { id: string; before: boolean }>;
  knobs: Map<string, KnobChange>;
  timer: ReturnType<typeof setTimeout>;
}

interface Deps {
  show: Pick<Show, "tree" | "queue">;
  scenes: Pick<ScenesSource, "get">;
  /** The room as the live tree has it. */
  room: () => Pick<LiveTree, "shaders" | "stack" | "pools">;
  shaders: Pick<Shaders, "setMutedAt" | "idOf">;
  arclamp: Pick<Arclamp, "evalAt">;
  pools: Pick<Pools, "set">;
  db: Pick<Db, "log">;
  /** arclamp's time now (rclamp-time.ts). */
  rNow: () => number;
}

const same = (a: ParamValue | null, b: ParamValue | null) => (a === null || b === null ? a === b : sameValue(a, b));
const changesOf = (byLight: Map<string, ParamValue | null>): Changes => [...byLight].map(([light, v]) => [v, [Number(light)]]);

/**
 * A shader's knobs as a scene would have them, said whole: for the scene's
 * sketch (`mine`, its knobs), its own; and, for any the scene queued before
 * it (`theirs`) would have changed that this one doesn't say, as they were
 * before that. Null if nothing's to change.
 */
function knobsWanted(s: Shader, values: LiveTree["pools"], mine: SceneKnobs | undefined, theirs: KnobChange | undefined): Omit<KnobChange, "id"> | null {
  const pool = s.pool ? values[s.pool] : undefined;
  if (!s.pool || !pool) return null;
  const after: Values = new Map();
  const before: Values = new Map();
  // As it is, with the scene before it not come in: as it was before that, where that would have changed it.
  const now = (name: string, light: string): ParamValue | null => {
    const was = theirs?.before.get(name);
    return was?.has(light) ? was.get(light)! : (pool.values[name]?.[light] ?? null);
  };
  const put = (name: string, light: string, v: ParamValue | null) => {
    if (!after.has(name)) after.set(name, new Map());
    if (!before.has(name)) before.set(name, new Map());
    after.get(name)!.set(light, v);
    before.get(name)!.set(light, now(name, light));
  };
  for (const spec of mine ? (pool.declared ?? []) : []) {
    const wanted = mine![spec.name];
    if (!wanted) continue;
    const lights = new Set([...Object.keys(pool.values[spec.name] ?? {}), ...Object.keys(wanted), ...(theirs?.after.get(spec.name)?.keys() ?? [])]);
    for (const light of lights) {
      const v = wanted[light] ?? null;
      // Said whole wherever the scene before it would have changed it; elsewhere, only if it's different.
      if (theirs?.after.get(spec.name)?.has(light) || !same(v, now(spec.name, light))) put(spec.name, light, v);
    }
  }
  for (const [name, byLight] of theirs?.before ?? []) {
    for (const [light, v] of byLight) if (!after.get(name)?.has(light)) put(name, light, v);
  }
  return after.size > 0 ? { pool: s.pool, before, after } : null;
}

export function createShowApply({ show, scenes, room, shaders, arclamp, pools, db, rNow }: Deps) {
  let queued: Queued | null = null;

  return {
    /** Scene `id` applied by `user`, pressed at `at` (arclamp's time): the frame it goes in with. Refused with no show on, or no such scene, or none of its sketches in the room. */
    async apply(id: string, at: number, user: Me): Promise<number> {
      const state = show.tree();
      if (!state.on) throw new Refused(409, "no_show", "a scene goes on the show's clock only while a show's on");
      const scene = scenes.get(id);
      if (!scene) throw new Refused(404, "no_such_scene", "there's no such scene");
      const tree = room();
      const here = tree.stack.flatMap((k) => (tree.shaders[k] ? [tree.shaders[k]] : [])).filter((s) => s.stage !== "failed" && !isBase(s));
      if (!here.some((s) => Object.hasOwn(scene.shaders, s.key))) throw new Refused(400, "no_sketch", "none of its sketches are in the room");
      const frame = frameOf(cueAt(state.cue, state.clock, at, rNow() + LEAD_MS));
      const theirs = queued;
      if (theirs) clearTimeout(theirs.timer);
      queued = null;
      const tag = randomUUID().slice(0, 8);

      // Each shader as the scene would have it: on (its sketch), or off.
      const mutes: Queued["mutes"] = new Map();
      const knobs: Queued["knobs"] = new Map();
      const sends: Promise<unknown>[] = [];
      for (const s of here) {
        const was = theirs?.mutes.get(s.key);
        const muted = !Object.hasOwn(scene.shaders, s.key);
        // Said whole wherever the scene before it would have changed it; elsewhere, only if it's different.
        if (muted === s.muted && !was) continue;
        const scheduleId = `m:${tag}:${s.key}`;
        mutes.set(s.key, { id: scheduleId, before: was ? was.before : s.muted });
        sends.push(shaders.setMutedAt(s.key, muted, { at: frame, id: scheduleId, emplace: was?.id }, user));
      }
      // And its sketch's knobs (and any the scene before it would have changed, as they were).
      for (const s of here) {
        const wanted = knobsWanted(s, tree.pools, scene.shaders[s.key], theirs?.knobs.get(s.key));
        if (!wanted) continue;
        const shaderId = shaders.idOf(s.key, user);
        // Not in arclamp yet: its stream gives it every value as it starts, the pool's by then.
        const scheduleId = shaderId === null ? null : `k:${tag}:${s.key}`;
        knobs.set(s.key, { id: scheduleId, ...wanted });
        if (shaderId === null || !scheduleId) continue;
        const events: ChangeEvent[] = [...wanted.after].map(([name, byLight]) => ({ name, set: changesOf(byLight) }));
        sends.push(arclamp.evalAt(shaderId, applyCode(events), { at: frame, id: scheduleId, emplace: theirs?.knobs.get(s.key)?.id ?? undefined }));
      }
      try {
        await Promise.all(sends);
      } catch (err) {
        show.queue(null);
        throw err;
      }

      // vibes' record of the knobs, and the queue, as the frame comes.
      const timer = setTimeout(
        () => {
          if (queued?.timer !== timer) return;
          queued = null;
          show.queue(null);
          for (const k of knobs.values()) {
            for (const [name, byLight] of k.after) void pools.set(k.pool, name, [...byLight].map(([l, v]) => [Number(l), v]), `user:${user.id}`);
          }
        },
        Math.max(0, frame - rNow()),
      );
      queued = { scene: id, frame, mutes, knobs, timer };
      show.queue({ scene: id, frame });
      db.log({ user, action: "scenes.apply", detail: { scene: scene.name, cue: state.cue } });
      return frame;
    },

    stop() {
      if (queued) clearTimeout(queued.timer);
    },
  };
}

export type ShowApply = ReturnType<typeof createShowApply>;
