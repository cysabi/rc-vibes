// Shaders by vibes' keys (ShaderKey, in shared/vibes.ts): an instance's id,
// for a shader put in from a sketch in vibes, or rclamp-<id> for one vibes
// only knows by arclamp's id; and, from whoever's adding it, the key of their
// pending edit that put it in ("+…"). The browser only ever has keys, and
// changes shaders by them here (by route, or in an update: updates.ts); which
// shader in arclamp a key is, only the server knows. Any shader can be muted,
// masked, moved or taken out, however it was put in. One not in the room yet
// (an instance, building) keeps what's wanted of it, and goes in that way
// (instances.ts). An instance's params are in its pool (pools.ts).

import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ShaderDescriptor } from "../shared/arclamp.ts";
import { BASE_COLOR, isBaseColor } from "../shared/base-color.ts";
import { cleanValue, PARAM_NAME, type Changes } from "../shared/params.ts";
import type { Me, Person } from "../shared/vibes.ts";
import type { Arclamp } from "./arclamp.ts";
import type { AuthEnv } from "./auth.ts";
import type { Db, InstanceRow } from "./db.ts";
import type { Config } from "./env.ts";
import type { Instances } from "./instances.ts";
import { changesBody } from "./params.ts";
import type { Pools } from "./pools.ts";
import { sketchOf } from "./stamp.ts";

const RCLAMP = /^rclamp-([1-9][0-9]{0,14})$/;
// A run of changes to one param (a slider dragged) logs as one entry.
const PARAM_LOG_WINDOW_MS = 15_000;

/** The key of a shader vibes only knows by arclamp's id. */
export const rclampKey = (id: number) => `rclamp-${id}`;

/**
 * What a key is: an instance (with its shader in arclamp, once it's there),
 * or a shader in arclamp (an instance's, if it's one, though its key is the
 * instance's); null if it's neither.
 */
export function shaderOfKey(db: Pick<Db, "instance" | "instanceOfShader">, key: string): { instance: InstanceRow | null; arclampId: number | null } | null {
  const m = RCLAMP.exec(key);
  if (m) {
    const id = Number(m[1]);
    return { instance: db.instanceOfShader(id) ?? null, arclampId: id };
  }
  const instance = db.instance(key);
  return instance ? { instance, arclampId: instance.shader_id } : null;
}

/** A change vibes won't make, and why: as an HTTP status, a code and a message. */
export class Refused extends Error {
  readonly status: 400 | 403 | 404 | 409 | 410 | 503;
  readonly code: string;

  constructor(status: 400 | 403 | 404 | 409 | 410 | 503, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badBody = (r: { success: boolean }, c: Context) => (r.success ? undefined : c.json({ error: "invalid request", code: "bad_body" }, 400));

export interface ShaderDeps {
  config: Pick<Config, "signingKey">;
  arclamp: Pick<Arclamp, "scene" | "shader" | "setMuted" | "setMask" | "moveShader" | "deleteShader">;
  db: Db;
  /** Sketches in the room (null with sketches off). */
  instances: Instances | null;
  /** Params, in their pools. */
  pools?: Pools | null;
}

/** Changes to shaders, by key, as someone makes them: each refuses (Refused) what it won't do. */
export function createShaders({ config, arclamp, db, instances, pools = null }: ShaderDeps) {
  /** A shader's name, for the history: its sketch's, or "Shader #<n>". */
  const nameOf = (d: ShaderDescriptor, instance: InstanceRow | null) =>
    (instance ? db.sketch(instance.sketch_id)?.name : sketchOf(d.script, config.signingKey, db)?.name) ?? `Shader #${d.id}`;

  /** What a key is, to `user`: theirs ("+…") is the instance their pending edit put in. */
  const resolve = (key: string, user: Person) => {
    if (!key.startsWith("+")) return shaderOfKey(db, key);
    const instance = db.instanceOfKey(user.id, key);
    return instance ? { instance, arclampId: instance.shader_id } : null;
  };

  /**
   * A change to a shader that isn't in the room yet, kept for when it goes in
   * (and logged); false if it's in, so the change is arclamp's to make.
   */
  async function wanted(key: string, patch: { muted?: boolean; mask?: number[] }, user: Person): Promise<boolean> {
    const it = resolve(key, user);
    if (!it?.instance || it.arclampId !== null || !instances) return false;
    if (!(await instances.want(it.instance.id, patch))) return false;
    const action = patch.mask ? "shader.mask" : patch.muted ? "shader.mute" : "shader.unmute";
    db.log({ user, action, shaderName: db.sketch(it.instance.sketch_id)?.name ?? null, detail: { instance: it.instance.id, ...(patch.mask ? { lights: patch.mask.length } : {}) } });
    return true;
  }

  /** A key's shader, in the room; refused if there's no such shader, or it isn't in yet. */
  async function inRoom(key: string, user: Person): Promise<{ d: ShaderDescriptor; instance: InstanceRow | null }> {
    const it = resolve(key, user);
    if (!it) throw new Refused(404, "not_found", "no such shader");
    if (it.arclampId === null) throw new Refused(409, "not_live", "it isn't in the room yet");
    // Gone from arclamp: its 404 is the answer (handleError).
    const d = await arclamp.shader(it.arclampId);
    if (d.type !== "js") throw new Refused(404, "not_found", "no such shader");
    return { d, instance: it.instance };
  }

  // Reorders, one at a time: two at once, interleaved, would leave neither.
  let ordering: Promise<unknown> = Promise.resolve();

  return {
    /** A key as vibes keeps it (an instance's id, or rclamp-<id>), to `user`; null if it's no shader. */
    keyOf(key: string, user: Person): string | null {
      const it = resolve(key, user);
      return it && (it.instance?.id ?? rclampKey(it.arclampId!));
    },

    async setMuted(key: string, muted: boolean, user: Person) {
      if (await wanted(key, { muted }, user)) return;
      const it = await inRoom(key, user);
      await arclamp.setMuted(it.d.id, muted);
      db.log({ user, action: muted ? "shader.mute" : "shader.unmute", shaderId: it.d.id, shaderName: nameOf(it.d, it.instance) });
    },

    /** The lights a shader may not change: its whole mask ([] clears it). */
    async setMask(key: string, mask: number[], user: Person) {
      const asked = [...new Set(mask)].sort((a, b) => a - b);
      if (await wanted(key, { mask: asked }, user)) return;
      const it = await inRoom(key, user);
      // An instance stays masked off everything outside its home.
      const whole = instances ? await instances.within(it.d.id, asked) : asked;
      await arclamp.setMask(it.d.id, whole);
      db.log({ user, action: "shader.mask", shaderId: it.d.id, shaderName: nameOf(it.d, it.instance), detail: { lights: whole.length } });
    },

    /**
     * Out of the room: an instance (building or in), or any other shader,
     * however it was put in. vibes can't put that back, so the browser asks first.
     */
    async remove(key: string, user: Person) {
      const it = resolve(key, user);
      if (it?.instance && instances) {
        await instances.remove(it.instance.id, user);
        return;
      }
      const there = await inRoom(key, user);
      await arclamp.deleteShader(there.d.id);
      instances?.forget(there.d.id);
      db.log({ user, action: "shader.delete", shaderId: there.d.id, shaderName: nameOf(there.d, there.instance) });
    },

    /**
     * A param of a shader put in from a sketch: its values changed (each value
     * with its lights; null back to the default), in its pool, and so sent to
     * it. Only an instance has params; one its sketch doesn't say it declares
     * (once it's said what it does) is gone.
     */
    async setParam(key: string, name: string, set: Changes, user: Person) {
      const it = resolve(key, user);
      if (!it) throw new Refused(404, "not_found", "no such shader");
      if (!it.instance || !pools) throw new Refused(404, "no_param", "it wasn't put in from a sketch, so it has no params");
      const declared = pools.get(it.instance.pool_id)?.declared;
      const spec = declared?.find((p) => p.name === name);
      if (!spec) {
        throw new Refused(404, "no_param", declared ? `its sketch has no param ${name}` : "it hasn't said what params it has yet");
      }
      for (const [v] of set) if (v !== null && cleanValue(spec, v) === null) throw new Refused(400, "bad_value", `${spec.label} is a ${spec.kind}`);
      const byLight = set.flatMap(([v, ids]) => ids.map((id): [number, typeof v] => [id, v]));
      // None of the lights it's for, or nothing different: nothing to note.
      if (!(await pools.set(it.instance.pool_id, name, byLight, `user:${user.id}`))) return;
      db.logCoalesced(
        {
          user,
          action: "shader.param",
          ...(it.arclampId !== null ? { shaderId: it.arclampId } : {}),
          shaderName: db.sketch(it.instance.sketch_id)?.name ?? null,
          detail: { instance: it.instance.id, param: name, lights: byLight.length },
        },
        PARAM_LOG_WINDOW_MS,
        (last) => last?.instance === it.instance!.id && last?.param === name,
      );
    },

    /** An instance's home moved: what it can light (its mask follows). */
    async setHome(key: string, home: number[], user: Me) {
      const it = resolve(key, user);
      if (!it) throw new Refused(404, "not_found", "no such shader");
      if (!it.instance || !instances) throw new Refused(400, "no_home", "it wasn't put in from a sketch, so it has no home");
      if (isBaseColor(it.instance.id)) throw new Refused(403, "base_color", "Base Tone's home is every light");
      const moved = await instances.setHome(it.instance.id, home, user);
      if ("refused" in moved) throw new Refused(moved.status, moved.code, moved.refused);
    },

    /**
     * The stack in this order, top first. Those in the room are moved; each
     * not in yet is to go in just above the one under it here (or at the
     * bottom); gone ones are passed over. Any in the room it leaves out stay
     * on top (put in since whoever asked last looked). The base Tone stays at
     * the bottom, wherever the order puts it, or if it leaves it out.
     */
    async reorder(order: string[], user: Person) {
      const base = db.instance(BASE_COLOR.instance);
      const shaders = order.map((key) => resolve(key, user)).filter((it) => !isBaseColor(it?.instance?.id));
      shaders.forEach((it, i) => {
        if (!it?.instance || it.arclampId !== null) return;
        const under = shaders.slice(i + 1).find((s) => s !== null);
        instances?.setAbove(it.instance.id, under ? (under.instance?.id ?? rclampKey(under.arclampId!)) : "");
      });
      const ids = [...shaders.map((it) => it?.arclampId ?? null), ...(base?.shader_id != null ? [base.shader_id] : [])];
      const reorder = ordering.then(async () => {
        const now = (await arclamp.scene()).filter((d) => d.type === "js").sort((a, b) => b.position - a.position);
        const byId = new Map(now.map((d) => [d.id, d]));
        const want = [...new Set(ids.filter((id) => id !== null && byId.has(id)))] as number[];
        const current = now.map((d) => d.id).filter((id) => want.includes(id));
        if (want.join() === current.join()) return;
        // Positions count up from the bottom (the room tone is 0); placing
        // them bottom first leaves each one where it belongs.
        for (let i = want.length - 1; i >= 0; i--) {
          const d = byId.get(want[i]!)!;
          const to = want.length - i;
          await arclamp.moveShader(d.id, to);
          if (d.position !== to) {
            db.log({ user, action: "shader.move", shaderId: d.id, shaderName: nameOf(d, db.instanceOfShader(d.id) ?? null), detail: { from: d.position, to } });
          }
        }
      });
      ordering = reorder.catch(() => {});
      await reorder;
    },
  };
}

export type Shaders = ReturnType<typeof createShaders>;

/** The changes, as routes (a refusal is answered by handleError). */
export function shaderRoutes(shaders: Shaders) {
  return (
    new Hono<AuthEnv>()
      .post("/shaders/:key/muted", zValidator("json", z.object({ muted: z.boolean() }), badBody), async (c) => {
        await shaders.setMuted(c.req.param("key"), c.req.valid("json").muted, c.get("user"));
        return c.body(null, 204);
      })
      .post("/shaders/:key/mask", zValidator("json", z.object({ mask: z.array(z.number().int()).max(2000) }), badBody), async (c) => {
        await shaders.setMask(c.req.param("key"), c.req.valid("json").mask, c.get("user"));
        return c.body(null, 204);
      })
      // A param's values (its sketch says which it has): { set: [[value, [lights]], …] }, null back to the default; other lights' kept.
      .put("/shaders/:key/params/:name", zValidator("json", z.object({ set: changesBody }), badBody), async (c) => {
        const name = c.req.param("name");
        if (!PARAM_NAME.test(name)) throw new Refused(400, "bad_param", "a param's name is a word");
        await shaders.setParam(c.req.param("key"), name, c.req.valid("json").set, c.get("user"));
        return c.body(null, 204);
      })
      .delete("/shaders/:key", async (c) => {
        await shaders.remove(c.req.param("key"), c.get("user"));
        return c.body(null, 204);
      })
      .put("/stack", zValidator("json", z.object({ order: z.array(z.string().min(1).max(100)).max(500) }), badBody), async (c) => {
        await shaders.reorder(c.req.valid("json").order, c.get("user"));
        return c.body(null, 204);
      })
  );
}
