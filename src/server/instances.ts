// Sketches in the room: shaders made from builds (builds.ts). This is the
// only way vibes makes a shader or changes one's script, and what it sends
// rclamp is always a build's own stamped script, looked up here by the
// build's id: never a script from the browser. So vibes never makes a plain
// shader, or turns someone else's into one; and only vibes' own shaders
// (stamped, edited or not) are its to change or remove.
//
// An instance is a sketch put in the room from vibes, on a home: the lights
// it was put on. It's here from the moment it's asked for, building its
// commit (or using the build there is); once that's built, it's a shader in
// arclamp, on top, masked off every light outside its home, so its home is
// all it can ever light (its code still picks which of those it does).
// Updating it builds a newer commit and swaps that in once built, the old one
// running meanwhile. Its home can move. Taking it out, or its shader going
// some other way, is the end of it.

import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ShaderDescriptor } from "../shared/arclamp.ts";
import type { Instance, Me, Person } from "../shared/vibes.ts";
import type { Arclamp } from "./arclamp.ts";
import type { AuthEnv } from "./auth.ts";
import { plainText, type Builds } from "./builds.ts";
import type { BuildRow, Db, InstanceRow, SketchRow } from "./db.ts";
import type { Config } from "./env.ts";
import { readStamp } from "./stamp.ts";

const fromBuild = z.object({ build: z.string().min(1) });
const idParam = z.object({ id: z.coerce.number().int().positive() });
const home = z.array(z.number().int()).min(1).max(2000);

type Status = 400 | 404 | 409 | 410 | 503;
const refuse = (c: Context, status: Status, error: string, code: string) => c.json({ error, code }, status);

/** Whether a shader is one of vibes' own: its script has vibes' stamp (checked or not). */
const isVibes = (d: ShaderDescriptor) => d.type === "js" && typeof d.script === "string" && readStamp(d.script, null) !== null;

const detail = (b: BuildRow, s: SketchRow) => ({ sketch: s.id, commit: b.commit_sha, build: b.id });

export interface InstanceDeps {
  config: Config;
  db: Db;
  arclamp: Pick<Arclamp, "shader" | "createShader" | "setScript" | "deleteShader" | "setMask">;
  builds: Pick<Builds, "start" | "onFinish">;
  /** Every light arclamp has, by id. */
  lightIds: () => Promise<number[]>;
  /** Told when an instance changes, to show it (the scene feed). */
  changed?: () => void;
}

type Refusal = { refused: string; status: Status; code: string };

export function createInstances({ config, db, arclamp, builds, lightIds, changed = () => {} }: InstanceDeps) {
  const refusal = (refused: string, status: Status, code: string): Refusal => ({ refused, status, code });

  function view(row: InstanceRow): Instance {
    const build = db.build(row.build_id);
    const next = row.next_build_id ? db.build(row.next_build_id) : undefined;
    return {
      id: row.id,
      sketchId: row.sketch_id,
      sketchName: db.sketch(row.sketch_id)?.name ?? null,
      commit: build?.commit_sha ?? "",
      buildId: row.build_id,
      home: row.home,
      shaderId: row.shader_id,
      state: row.state,
      error: row.error && plainText(row.error),
      // Once it's built it's swapped in (swap), so only one building or failed is news.
      next: next && next.state !== "built" ? { commit: next.commit_sha, buildId: next.id, state: next.state, error: next.error && plainText(next.error) } : null,
      by: { id: row.by_id, name: row.by_name },
      at: row.at,
    };
  }

  /** Every light outside a home. */
  async function outside(home: readonly number[]) {
    const inside = new Set(home);
    return (await lightIds()).filter((id) => !inside.has(id));
  }

  const failed = (id: string, error: string) => {
    db.updateInstance(id, { state: "failed", error });
    changed();
  };

  // Each instance is put in once, however many times it's asked.
  const placing = new Set<string>();

  /** A building instance, into the room once its build is built (or failed, if it isn't). */
  async function place(id: string) {
    if (placing.has(id)) return;
    placing.add(id);
    try {
      const inst = db.instance(id);
      if (inst?.state !== "building") return;
      const build = db.build(inst.build_id);
      if (!build || build.state === "failed") return failed(id, build?.error ?? "its build is gone");
      if (build.state !== "built" || !build.script) return;
      const sketch = db.sketch(inst.sketch_id);
      if (!sketch || sketch.deleted_at !== null) return failed(id, "its sketch was deleted");
      if (!readStamp(build.script, config.signingKey)?.verified) return failed(id, "its stamp doesn't check out (was vibes' key changed?): put it in again");
      const mask = await outside(inst.home);
      const d = await arclamp.createShader(build.script);
      // Masked at once: its sandbox takes longer than this to start, so it
      // never lights anything outside its home.
      if (mask.length > 0) await arclamp.setMask(d.id, mask);
      db.updateInstance(id, { shader_id: d.id, state: "live", error: null });
      db.log({ user: { id: inst.by_id, name: inst.by_name }, action: "shader.create", shaderId: d.id, shaderName: sketch.name, detail: { ...detail(build, sketch), home: inst.home.length } });
      changed();
    } catch (err) {
      failed(id, `couldn't put it in: ${(err as Error).message}`);
    } finally {
      placing.delete(id);
    }
  }

  /** A live instance's newer build, swapped in once built. */
  async function swap(id: string) {
    const inst = db.instance(id);
    if (inst?.state !== "live" || !inst.next_build_id || inst.shader_id === null) return;
    const build = db.build(inst.next_build_id);
    if (!build || build.state === "building") return;
    if (build.state === "failed" || !build.script) return changed();
    try {
      await arclamp.setScript(inst.shader_id, build.script);
      db.updateInstance(id, { build_id: build.id, next_build_id: null, error: null });
      const sketch = db.sketch(inst.sketch_id);
      if (sketch) db.log({ user: { id: build.by_id, name: build.by_name }, action: "shader.edit", shaderId: inst.shader_id, shaderName: sketch.name, detail: detail(build, sketch) });
    } catch (err) {
      db.updateInstance(id, { next_build_id: null, error: `couldn't update it: ${(err as Error).message}` });
    }
    changed();
  }

  builds.onFinish((buildId) => {
    for (const inst of db.instances()) {
      if (inst.state === "building" && inst.build_id === buildId) void place(inst.id);
      else if (inst.state === "live" && inst.next_build_id === buildId) void swap(inst.id);
    }
  });
  // Any whose builds ended while vibes wasn't here to hear it.
  for (const inst of db.instances()) {
    if (inst.state === "building") void place(inst.id);
    else if (inst.state === "live" && inst.next_build_id) void swap(inst.id);
  }

  /** Why these lights can't be a home, if they can't: they must all be arclamp's. */
  async function badHome(lights: number[]): Promise<string | null> {
    const known = new Set(await lightIds());
    const unknown = lights.find((id) => !known.has(id));
    return unknown === undefined ? null : `no light ${unknown}`;
  }

  const sorted = (ids: Iterable<number>) => [...new Set(ids)].sort((a, b) => a - b);

  return {
    view,

    /** A sketch, at a commit (main's latest by default), put in the room on `home`: building first, if it isn't built. */
    async create(sketchId: string, rev: string, homeLights: number[], user: Me): Promise<{ instance: Instance } | Refusal> {
      const sketch = db.sketch(sketchId);
      if (!sketch) return refusal("no such sketch", 404, "not_found");
      if (sketch.deleted_at !== null) return refusal("its sketch was deleted", 410, "deleted");
      const bad = await badHome(homeLights);
      if (bad) return refusal(bad, 400, "bad_home");
      const started = await builds.start(sketchId, rev, user);
      if ("refused" in started) return refusal(started.refused, started.status, "cant_build");
      const id = randomUUID();
      db.addInstance({ id, sketch_id: sketchId, build_id: started.build.id, home: sorted(homeLights), by_id: user.id, by_name: user.name, at: Date.now() });
      changed();
      if (started.build.state !== "building") await place(id);
      return { instance: view(db.instance(id)!) };
    },

    /** A live instance, moved on to another commit (main's latest by default): built, then swapped in. */
    async update(id: string, rev: string, user: Me): Promise<{ instance: Instance } | Refusal> {
      const inst = db.instance(id);
      if (!inst) return refusal("no such instance", 404, "not_found");
      if (inst.state !== "live") return refusal("it isn't in the room yet", 409, "not_live");
      const started = await builds.start(inst.sketch_id, rev, user);
      if ("refused" in started) return refusal(started.refused, started.status, "cant_build");
      if (started.build.id !== inst.build_id) {
        db.updateInstance(id, { next_build_id: started.build.id, error: null });
        changed();
        if (started.build.state !== "building") await swap(id);
      }
      return { instance: view(db.instance(id)!) };
    },

    /**
     * An instance on another home. Lights still in it keep whether they're
     * switched off; lights new to it start on; the rest are masked off.
     */
    async setHome(id: string, homeLights: number[], user: Me): Promise<{ instance: Instance } | Refusal> {
      const inst = db.instance(id);
      if (!inst) return refusal("no such instance", 404, "not_found");
      const bad = await badHome(homeLights);
      if (bad) return refusal(bad, 400, "bad_home");
      const next = sorted(homeLights);
      if (inst.state === "live" && inst.shader_id !== null) {
        const wasMasked = new Set((await arclamp.shader(inst.shader_id)).mask ?? []);
        const wasHome = new Set(inst.home);
        const nowHome = new Set(next);
        const mask = (await lightIds()).filter((l) => !nowHome.has(l) || (wasHome.has(l) && wasMasked.has(l)));
        await arclamp.setMask(inst.shader_id, mask);
      }
      db.updateInstance(id, { home: next });
      db.log({ user, action: "shader.home", ...(inst.shader_id !== null ? { shaderId: inst.shader_id } : {}), shaderName: db.sketch(inst.sketch_id)?.name ?? null, detail: { lights: next.length } });
      changed();
      return { instance: view(db.instance(id)!) };
    },

    /** An instance out of the room: its shader removed, if it's there, and it forgotten. */
    async remove(id: string, user: Person): Promise<boolean> {
      const inst = db.instance(id);
      if (!inst) return false;
      if (inst.shader_id !== null) {
        try {
          await arclamp.deleteShader(inst.shader_id);
        } catch (err) {
          // Gone already is as good as removed.
          if ((err as { status?: number }).status !== 404) throw err;
        }
      }
      db.deleteInstance(id);
      db.log({ user, action: "shader.delete", ...(inst.shader_id !== null ? { shaderId: inst.shader_id } : {}), shaderName: db.sketch(inst.sketch_id)?.name ?? null, detail: { instance: id } });
      changed();
      return true;
    },

    /** A mask for a shader, with every light outside its instance's home added: its home stays all it can light. */
    async within(shaderId: number, mask: number[]): Promise<number[]> {
      const inst = db.instanceOfShader(shaderId);
      return inst ? sorted([...mask, ...(await outside(inst.home))]) : mask;
    },

    /** A shader's gone (removed through vibes or not): so is its instance. */
    forget(shaderId: number) {
      const inst = db.instanceOfShader(shaderId);
      if (!inst) return;
      db.deleteInstance(inst.id);
      changed();
    },
  };
}

export type Instances = ReturnType<typeof createInstances>;

export function instanceRoutes(config: Config, arclamp: Pick<Arclamp, "shader" | "createShader" | "setScript" | "deleteShader">, db: Db, instances: Instances | null = null) {
  /** A build that can go in the room: built, its sketch not deleted, its stamp good. */
  function usable(c: Context, id: string): { build: BuildRow & { script: string }; sketch: SketchRow } | Response {
    const build = db.build(id);
    if (!build || build.state !== "built" || !build.script) return refuse(c, 404, "no such build, or it didn't build", "no_build");
    const sketch = db.sketch(build.sketch_id);
    if (!sketch || sketch.deleted_at !== null) return refuse(c, 410, "its sketch was deleted", "deleted");
    if (!readStamp(build.script, config.signingKey)?.verified) return refuse(c, 409, "its stamp doesn't check out (was vibes' key changed?): build it again", "bad_stamp");
    return { build: build as BuildRow & { script: string }, sketch };
  }

  const badBody = (r: { success: boolean }, c: Context) => (r.success ? undefined : refuse(c, 400, "say which build", "bad_body"));
  const badId = (r: { success: boolean }, c: Context) => (r.success ? undefined : refuse(c, 404, "no such shader", "not_found"));
  const badInstance = (r: { success: boolean }, c: Context) => (r.success ? undefined : refuse(c, 400, "say which sketch, and its home: the lights to put it on", "bad_body"));
  const answer = (c: Context, made: { instance: Instance } | Refusal, status: 200 | 202 = 200) =>
    "refused" in made ? refuse(c, made.status, made.refused, made.code) : c.json(made.instance, status);

  const routes = new Hono<AuthEnv>()
    // A build, in the room: a new shader, on top.
    .post("/shaders", zValidator("json", fromBuild, badBody), async (c) => {
      const it = usable(c, c.req.valid("json").build);
      if (it instanceof Response) return it;
      const d = await arclamp.createShader(it.build.script);
      db.log({ user: c.get("user"), action: "shader.create", shaderId: d.id, shaderName: it.sketch.name, detail: detail(it.build, it.sketch) });
      return c.json(d, 201);
    })

    // One of vibes' shaders, running another build instead (another commit, or another sketch).
    .put("/shaders/:id/build", zValidator("param", idParam, badId), zValidator("json", fromBuild, badBody), async (c) => {
      const { id } = c.req.valid("param");
      const it = usable(c, c.req.valid("json").build);
      if (it instanceof Response) return it;
      if (!isVibes(await arclamp.shader(id))) return refuse(c, 409, "that shader isn't one vibes made", "not_vibes");
      const d = await arclamp.setScript(id, it.build.script);
      db.log({ user: c.get("user"), action: "shader.edit", shaderId: id, shaderName: it.sketch.name, detail: detail(it.build, it.sketch) });
      return c.json(d);
    })

    // One of vibes' shaders, out of the room (and the instance it was, if it was one).
    .delete("/shaders/:id", zValidator("param", idParam, badId), async (c) => {
      const { id } = c.req.valid("param");
      const d = await arclamp.shader(id);
      if (!isVibes(d)) return refuse(c, 409, "that shader isn't one vibes made", "not_vibes");
      await arclamp.deleteShader(id);
      instances?.forget(id);
      db.log({ user: c.get("user"), action: "shader.delete", shaderId: id, shaderName: `Shader #${id}` });
      return c.body(null, 204);
    });

  if (!instances) return routes;
  return (
    routes
      // A sketch, put in the room on the lights given (its home).
      .post("/instances", zValidator("json", z.object({ sketch: z.string().min(1), commit: z.string().min(1).optional(), home }), badInstance), async (c) => {
        const { sketch, commit, home } = c.req.valid("json");
        return answer(c, await instances.create(sketch, commit ?? "main", home, c.get("user")), 202);
      })

      .post("/instances/:id/update", zValidator("json", z.object({ commit: z.string().min(1).optional() }), badInstance), async (c) => {
        return answer(c, await instances.update(c.req.param("id"), c.req.valid("json").commit ?? "main", c.get("user")), 202);
      })

      .put("/instances/:id/home", zValidator("json", z.object({ home }), badInstance), async (c) => {
        return answer(c, await instances.setHome(c.req.param("id"), c.req.valid("json").home, c.get("user")));
      })

      .delete("/instances/:id", async (c) =>
        (await instances.remove(c.req.param("id"), c.get("user"))) ? c.body(null, 204) : refuse(c, 404, "no such instance", "not_found"),
      )
  );
}
