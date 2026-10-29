// Scenes (shared/scenes.ts): kept here, saved, and in the live tree
// (scenes/list, scenes/order). Pages change them (scenes/…, made by
// updates.ts), each change made at once, whatever the mode: scenes are the
// room's, never a pending edit (applying one is: shared/scenes.ts). Each is
// told to every page (the tree) and noted in the history, a run of changes
// to one scene from one person as one entry.
//
// A knob is checked as a pool's value is (cleanValue), against what its
// sketch declares now, so a scene keeps only knobs its sketch has. A sketch
// a scene keeps may leave the room: the scene keeps it, and applying it
// passes it over.

import { cleanValue, type ParamValue } from "../shared/params.ts";
import type { Op, Pool } from "../shared/live.ts";
import { MAX_SCENES, NO_SCENES, type Scene, type SceneKnobs, type SceneOp, type Scenes } from "../shared/scenes.ts";
import type { Me, Shader } from "../shared/vibes.ts";
import type { Db } from "./db.ts";
import { Refused } from "./shaders.ts";

// A run of changes to one scene from one person is one entry in the history.
const LOG_WINDOW_MS = 15_000;

interface Deps {
  db: Pick<Db, "scenes" | "saveScene" | "removeScene" | "orderScenes" | "logCoalesced">;
  /** Changes to the live tree (live.ts). */
  publish: (ops: Op[]) => void;
  /** The room as the live tree has it: its shaders and pools, for checking knobs. */
  room: () => { shaders: Record<string, Shader>; pools: Record<string, Pool> };
  now?: () => number;
}

export function createScenes({ db, publish, room, now = Date.now }: Deps) {
  const list = new Map<string, Scene>();
  for (const { id, ...scene } of db.scenes()) list.set(id, scene);
  let order = [...list.keys()];

  const tree = (): Scenes => (list.size === 0 ? NO_SCENES : { list: Object.fromEntries(list), order });

  /** A scene's sketch's spec for a param, from its pool as its sketch declares it now. */
  function specOf(key: string, param: string) {
    const { shaders, pools } = room();
    const pool = shaders[key]?.pool;
    return pool ? pools[pool]?.declared?.find((p) => p.name === param) : undefined;
  }

  /** Knobs for a sketch, as its sketch declares them now: each value cleaned; any param it doesn't declare, or value it won't take, is refused. */
  function cleanKnobs(key: string, knobs: SceneKnobs): SceneKnobs {
    const out: SceneKnobs = {};
    for (const [param, byLight] of Object.entries(knobs)) {
      const spec = specOf(key, param);
      if (!spec) throw new Refused(400, "no_such_knob", `${key}'s sketch has no knob ${param}`);
      out[param] = {};
      for (const [light, v] of Object.entries(byLight)) {
        const clean = cleanValue(spec, v);
        if (clean === null) throw new Refused(400, "bad_knob", `${JSON.stringify(v)?.slice(0, 40)} isn't a value for ${param}`);
        out[param][light] = clean;
      }
    }
    return out;
  }

  function scene(id: string): Scene {
    const s = list.get(id);
    if (!s) throw new Refused(404, "no_such_scene", "there's no such scene");
    return s;
  }

  function save(id: string, next: Scene) {
    list.set(id, next);
    db.saveScene(id, next);
    publish([[`scenes/list/${id}`, next]]);
  }

  return {
    tree,

    /** A scene, by id, if there is one. */
    get: (id: string) => list.get(id),

    /** Something done to the scenes, by `user`: made, saved and told to everyone; Refused if it isn't one vibes can make. */
    act(o: SceneOp, user: Me) {
      const by = { id: user.id, name: user.name };
      const at = now();
      switch (o.op) {
        case "create": {
          if (list.has(o.id)) {
            save(o.id, { ...scene(o.id), name: o.name, by, at });
            break;
          }
          if (list.size >= MAX_SCENES) throw new Refused(400, "too_many_scenes", `there can be ${MAX_SCENES} scenes`);
          save(o.id, { name: o.name, shaders: {}, by, at });
          order = [...order, o.id];
          publish([["scenes/order", order]]);
          break;
        }
        case "remove": {
          const was = scene(o.id);
          list.delete(o.id);
          db.removeScene(o.id);
          order = order.filter((id) => id !== o.id);
          publish([[`scenes/list/${o.id}`], ["scenes/order", order]]);
          db.logCoalesced({ user, action: "scenes.change", detail: { do: "remove", scene: was.name } }, 0, () => false);
          return;
        }
        case "name":
          save(o.id, { ...scene(o.id), name: o.name, by, at });
          break;
        case "sketch": {
          const s = scene(o.id);
          const { [o.key]: _, ...rest } = s.shaders;
          // One sketch a scene, for now: a new one takes the place of what it had.
          save(o.id, { ...s, shaders: o.knobs ? { [o.key]: cleanKnobs(o.key, o.knobs) } : rest, by, at });
          break;
        }
        case "knob": {
          const s = scene(o.id);
          const knobs = s.shaders[o.key];
          if (!knobs) throw new Refused(400, "not_in_scene", "that sketch isn't in the scene");
          const values: Record<string, ParamValue> = { ...knobs[o.param] };
          if (o.value === null) delete values[o.light];
          else values[o.light] = cleanKnobs(o.key, { [o.param]: { [o.light]: o.value } })[o.param]![o.light]!;
          save(o.id, { ...s, shaders: { ...s.shaders, [o.key]: { ...knobs, [o.param]: values } }, by, at });
          break;
        }
        case "order": {
          // Every scene, once each: a page that's behind can't drop one.
          if (o.ids.length !== list.size || new Set(o.ids).size !== o.ids.length || !o.ids.every((id) => list.has(id))) {
            throw new Refused(409, "scenes_changed", "the scenes changed: try again");
          }
          order = [...o.ids];
          db.orderScenes(order);
          publish([["scenes/order", order]]);
          break;
        }
      }
      const name = o.op === "order" ? null : list.get(o.id)?.name;
      db.logCoalesced({ user, action: "scenes.change", detail: { do: o.op, ...(name ? { scene: name } : {}) } }, LOG_WINDOW_MS, (last) => last?.do === o.op && last?.scene === name);
    },
  };
}

export type ScenesSource = ReturnType<typeof createScenes>;
