// Scenes: looks for the room, one set for everyone, kept by vibes
// (server/scenes.ts) and in the live tree (scenes/list, scenes/order). A
// scene is a sketch in the room, by its key, with its knobs as the scene
// keeps them, in its pool's own form (by param, by light; only lights not at
// the default). One sketch, for now; it keeps them by key so it can hold
// more. Its knobs are the scene's own: turning them in the room doesn't
// change the scene, and applying it puts them back.
//
// Applied, a scene's sketches go on, with its knobs, and every other shader
// off but Base Color, which is always left as it is. Outside a show that's
// just an edit to the room (the page makes it, as any other: previewed
// unless in live mode); in a show, vibes makes it on the show's clock
// (show/apply). Which scene is on isn't kept: it's whichever the room looks
// like (onScene), however it got that way.

import { BASE_COLOR } from "./base-color.ts";
import type { Pool } from "./live.ts";
import { sameValue, type ParamValue } from "./params.ts";
import type { Person, Shader, ShaderKey } from "./vibes.ts";

/** A scene's knobs for one sketch: its pool's values as the scene keeps them, by param, by light id. */
export type SceneKnobs = Record<string, Record<string, ParamValue>>;

export interface Scene {
  name: string;
  /** Its sketches, by key, each with its knobs. */
  shaders: Record<ShaderKey, SceneKnobs>;
  by: Person;
  at: number;
}

/** Every scene, by id, and their order (number keys follow it). */
export interface Scenes {
  list: Record<string, Scene>;
  order: string[];
}

export const NO_SCENES: Scenes = { list: {}, order: [] };

export const MAX_SCENES = 100;
export const MAX_SCENE_NAME = 60;

/** Something done to the scenes (a page's, at scenes/…; server/scenes.ts makes it). */
export type SceneOp =
  | { op: "create"; id: string; name: string }
  | { op: "remove"; id: string }
  | { op: "name"; id: string; name: string }
  /** Its sketch (with its knobs), or not (null). */
  | { op: "sketch"; id: string; key: ShaderKey; knobs: SceneKnobs | null }
  /** One of its sketch's knobs, on one light: back to the default with null. */
  | { op: "knob"; id: string; key: ShaderKey; param: string; light: string; value: ParamValue | null }
  | { op: "order"; ids: string[] };

/** Whether a shader is Base Color, which scenes leave alone. */
export const isBase = (s: Pick<Shader, "pool" | "instance">) => s.pool === BASE_COLOR.pool || s.instance?.id === BASE_COLOR.instance;

/** A knob's change, as a pool takes it: each light's value (null, back to the default). */
export interface KnobChange {
  key: ShaderKey;
  pool: string;
  param: string;
  set: [light: string, value: ParamValue | null][];
}

/** What applying a scene changes in the room as it is: which shaders go on and off, and which knobs move. */
export interface Applying {
  on: ShaderKey[];
  off: ShaderKey[];
  knobs: KnobChange[];
}

/**
 * What applying `scene` changes in a room of these shaders (top first) and
 * pools: its sketches on, every other shader off but Base Color (and any
 * that failed), and its sketches' knobs to the scene's, for the params their
 * sketches still declare (any other left as it is). A sketch of the scene's
 * that's gone from the room is passed over.
 */
export function applyingOf(scene: Scene, shaders: readonly Shader[], pools: Record<string, Pool>): Applying {
  const out: Applying = { on: [], off: [], knobs: [] };
  for (const s of shaders) {
    if (s.stage === "failed" || isBase(s)) continue;
    const knobs = scene.shaders[s.key];
    if (!knobs) {
      if (!s.muted) out.off.push(s.key);
      continue;
    }
    if (s.muted) out.on.push(s.key);
    const pool = s.pool ? pools[s.pool] : undefined;
    if (!pool) continue;
    for (const spec of pool.declared ?? []) {
      if (!Object.hasOwn(knobs, spec.name)) continue;
      const want = knobs[spec.name]!;
      const now = pool.values[spec.name] ?? {};
      const set: KnobChange["set"] = [];
      for (const light of Object.keys(now)) if (!Object.hasOwn(want, light)) set.push([light, null]);
      for (const [light, v] of Object.entries(want)) if (!Object.hasOwn(now, light) || !sameValue(now[light]!, v)) set.push([light, v]);
      if (set.length > 0) out.knobs.push({ key: s.key, pool: s.pool!, param: spec.name, set });
    }
  }
  return out;
}

/** Whether applying `scene` would change nothing: the room looks like it. */
export function looksLike(scene: Scene, shaders: readonly Shader[], pools: Record<string, Pool>): boolean {
  if (Object.keys(scene.shaders).length === 0 || !shaders.some((s) => Object.hasOwn(scene.shaders, s.key))) return false;
  const a = applyingOf(scene, shaders, pools);
  return a.on.length === 0 && a.off.length === 0 && a.knobs.length === 0;
}

/** The scene the room looks like, if any (the first, in order). */
export function onScene(scenes: Scenes, shaders: readonly Shader[], pools: Record<string, Pool>): string | null {
  return scenes.order.find((id) => scenes.list[id] && looksLike(scenes.list[id], shaders, pools)) ?? null;
}

/** A sketch's knobs as the room has them now: its pool's values (none, with no pool). */
export const knobsOf = (shader: Pick<Shader, "pool">, pools: Record<string, Pool>): SceneKnobs => (shader.pool ? structuredClone(pools[shader.pool]?.values ?? {}) : {});
