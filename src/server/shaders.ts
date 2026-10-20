// Shaders by vibes' keys (ShaderKey, in shared/vibes.ts): an instance's id,
// for a shader put in from a sketch in vibes, or rclamp-<id> for one vibes
// only knows by arclamp's id. The browser only ever has keys, and changes
// shaders by them here; which shader in arclamp a key is, only the server
// knows. Any shader can be muted, masked, moved or taken out, however it was
// put in. One not in the room yet (an instance, building) keeps what's wanted
// of it, and goes in that way (instances.ts).

import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ShaderDescriptor } from "../shared/arclamp.ts";
import type { Arclamp } from "./arclamp.ts";
import type { AuthEnv } from "./auth.ts";
import type { Db, InstanceRow } from "./db.ts";
import type { Config } from "./env.ts";
import type { Instances } from "./instances.ts";
import { sketchOf } from "./stamp.ts";

const RCLAMP = /^rclamp-([1-9][0-9]{0,14})$/;

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

type Status = 400 | 404 | 409;
const refuse = (c: Context, status: Status, error: string, code: string) => c.json({ error, code }, status);

const badBody = (r: { success: boolean }, c: Context) => (r.success ? undefined : refuse(c, 400, "invalid request", "bad_body"));

export interface ShaderDeps {
  config: Pick<Config, "signingKey">;
  arclamp: Pick<Arclamp, "scene" | "shader" | "setMuted" | "setMask" | "moveShader" | "deleteShader">;
  db: Db;
  /** Sketches in the room (null with sketches off). */
  instances: Instances | null;
}

export function shaderRoutes({ config, arclamp, db, instances }: ShaderDeps) {
  /** A shader's name, for the history: its sketch's, or "Shader #<n>". */
  const nameOf = (d: ShaderDescriptor, instance: InstanceRow | null) =>
    (instance ? db.sketch(instance.sketch_id)?.name : sketchOf(d.script, config.signingKey, db)?.name) ?? `Shader #${d.id}`;

  /**
   * A change to a shader that isn't in the room yet, kept for when it goes in
   * (and logged); false if it's in, so the change is arclamp's to make.
   */
  async function wanted(c: Context, key: string, patch: { muted?: boolean; mask?: number[] }): Promise<boolean> {
    const it = shaderOfKey(db, key);
    if (!it?.instance || it.arclampId !== null || !instances) return false;
    if (!(await instances.want(it.instance.id, patch))) return false;
    const action = patch.mask ? "shader.mask" : patch.muted ? "shader.mute" : "shader.unmute";
    db.log({ user: c.get("user"), action, shaderName: db.sketch(it.instance.sketch_id)?.name ?? null, detail: { instance: it.instance.id, ...(patch.mask ? { lights: patch.mask.length } : {}) } });
    return true;
  }

  /** A key's shader, in the room; or why it can't be changed: there's no such shader, or it isn't in yet. */
  async function inRoom(c: Context, key: string): Promise<{ d: ShaderDescriptor; instance: InstanceRow | null } | Response> {
    const it = shaderOfKey(db, key);
    if (!it) return refuse(c, 404, "no such shader", "not_found");
    if (it.arclampId === null) return refuse(c, 409, "it isn't in the room yet", "not_live");
    // Gone from arclamp: its 404 is the answer (handleError).
    const d = await arclamp.shader(it.arclampId);
    if (d.type !== "js") return refuse(c, 404, "no such shader", "not_found");
    return { d, instance: it.instance };
  }

  // Reorders, one at a time: two at once, interleaved, would leave neither.
  let ordering: Promise<unknown> = Promise.resolve();

  return (
    new Hono<AuthEnv>()
      .post("/shaders/:key/muted", zValidator("json", z.object({ muted: z.boolean() }), badBody), async (c) => {
        const { muted } = c.req.valid("json");
        if (await wanted(c, c.req.param("key"), { muted })) return c.body(null, 204);
        const it = await inRoom(c, c.req.param("key"));
        if (it instanceof Response) return it;
        await arclamp.setMuted(it.d.id, muted);
        db.log({ user: c.get("user"), action: muted ? "shader.mute" : "shader.unmute", shaderId: it.d.id, shaderName: nameOf(it.d, it.instance) });
        return c.body(null, 204);
      })

      // The lights a shader may not change: its whole mask ([] clears it).
      .post("/shaders/:key/mask", zValidator("json", z.object({ mask: z.array(z.number().int()).max(2000) }), badBody), async (c) => {
        const asked = [...new Set(c.req.valid("json").mask)].sort((a, b) => a - b);
        if (await wanted(c, c.req.param("key"), { mask: asked })) return c.body(null, 204);
        const it = await inRoom(c, c.req.param("key"));
        if (it instanceof Response) return it;
        // An instance stays masked off everything outside its home.
        const mask = instances ? await instances.within(it.d.id, asked) : asked;
        await arclamp.setMask(it.d.id, mask);
        db.log({ user: c.get("user"), action: "shader.mask", shaderId: it.d.id, shaderName: nameOf(it.d, it.instance), detail: { lights: mask.length } });
        return c.body(null, 204);
      })

      // Out of the room: an instance (building or in), or any other shader,
      // however it was put in. vibes can't put that back, so the browser asks first.
      .delete("/shaders/:key", async (c) => {
        const user = c.get("user");
        const key = c.req.param("key");
        const it = shaderOfKey(db, key);
        if (it?.instance && instances) {
          await instances.remove(it.instance.id, user);
          return c.body(null, 204);
        }
        const there = await inRoom(c, key);
        if (there instanceof Response) return there;
        await arclamp.deleteShader(there.d.id);
        instances?.forget(there.d.id);
        db.log({ user, action: "shader.delete", shaderId: there.d.id, shaderName: nameOf(there.d, there.instance) });
        return c.body(null, 204);
      })

      // The stack in this order, top first. Those in the room are moved; each
      // not in yet is to go in just above the one under it here (or at the
      // bottom); gone ones are passed over. Any in the room it leaves out stay
      // on top (put in since the browser last looked).
      .put("/stack", zValidator("json", z.object({ order: z.array(z.string().min(1).max(100)).max(500) }), badBody), async (c) => {
        const user = c.get("user");
        const shaders = c.req.valid("json").order.map((key) => shaderOfKey(db, key));
        shaders.forEach((it, i) => {
          if (!it?.instance || it.arclampId !== null) return;
          const under = shaders.slice(i + 1).find((s) => s !== null);
          instances?.setAbove(it.instance.id, under ? (under.instance?.id ?? rclampKey(under.arclampId!)) : "");
        });
        const ids = shaders.map((it) => it?.arclampId ?? null);
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
        return c.body(null, 204);
      })
  );
}
