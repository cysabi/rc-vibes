// Sketches in the room: shaders made from builds (builds.ts). This is the
// only way vibes makes a shader or changes one's script, and what it sends
// rclamp is always a build's own stamped script, looked up here by the
// build's id: never a script from the browser. So vibes never makes a plain
// shader, or turns someone else's into one.
//
// An instance is a sketch put in the room from vibes, on a home: the lights
// it was put on, from a branch (main, so far), at a commit (the branch's head
// then, unless asked for another, or a build given). It's here from the moment
// it's asked for, building its commit (or using the build there is); once
// that's built, it's a shader in arclamp, masked off every light outside its
// home, so its home is all it can ever light (its code still picks which of
// those it does). Until then, what's wanted of it is kept (muted, its mask,
// and its place, just above another shader, or on top), and it goes in that
// way: its script stamped as this shader (stampAs), so it's found by its
// stamp if vibes stops between putting it in and noting it. Updating it
// builds a newer commit (its branch's head, unless asked for another) and
// swaps that in once built, the old one running meanwhile. Its home can move.
// Taking it out, or its shader going some other way, is the end of it.
//
// Except for the base Tone (shared/base-color.ts), the one instance vibes puts
// in itself: its home is every light there is, it's always at the bottom (an
// instance put in "at the bottom" goes just above it), it can't be moved
// home, and when its shader's gone it goes back in, as it last was, with its
// pool kept (keepBase, lost). Taken out, it's gone like any other, and vibes
// puts a new one in (base-color.ts). No default sketch (a Tone, a Transition:
// shared/default-sketches.ts) is updated: its code is vibes'.

import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ShaderDescriptor } from "../shared/arclamp.ts";
import { BASE_COLOR, isBaseColor } from "../shared/base-color.ts";
import { isDefaultSketch } from "../shared/default-sketches.ts";
import type { Instance, Me, Person } from "../shared/vibes.ts";
import type { Arclamp } from "./arclamp.ts";
import type { AuthEnv } from "./auth.ts";
import { plainText, type Builds } from "./builds.ts";
import type { BuildRow, Db, InstanceRow, SketchRow } from "./db.ts";
import type { Config } from "./env.ts";
import { branchHead, isBranchName } from "./git.ts";
import type { Pools } from "./pools.ts";
import { shaderOfKey } from "./shaders.ts";
import { readStamp, stampAs } from "./stamp.ts";

const home = z.array(z.number().int()).min(1).max(2000);
const branch = z.string().refine(isBranchName).default("main");

type Status = 400 | 403 | 404 | 409 | 410 | 503;
const refuse = (c: Context, status: Status, error: string, code: string) => c.json({ error, code }, status);

const detail = (b: BuildRow, s: SketchRow) => ({ sketch: s.id, commit: b.commit_sha, build: b.id });

const sorted = (ids: Iterable<number>) => [...new Set(ids)].sort((a, b) => a - b);
const sameIds = (a: Iterable<number>, b: Iterable<number>) => sorted(a).join() === sorted(b).join();

export interface InstanceDeps {
  config: Config;
  db: Db;
  arclamp: Pick<Arclamp, "scene" | "shader" | "createShader" | "setScript" | "deleteShader" | "setMask" | "setMuted">;
  builds: Pick<Builds, "start" | "onFinish">;
  /** Every light arclamp has, by id. */
  lightIds: () => Promise<number[]>;
  /** Told when an instance changes, to show it (the scene feed). */
  changed?: () => void;
  /** Its pool (pools.ts): taken on as it's made, and let go with it. */
  pools?: Pick<Pools, "adopt" | "remove"> | null;
  /** Told when an instance is gone, with its pool, to end its shader's stream of params (params.ts). */
  gone?: (pool: string) => void;
  /** Told when the base Tone has gone in anew, held muted until its params reach it (base-color.ts). */
  wentIn?: (id: string, d: ShaderDescriptor) => void;
}

type Refusal = { refused: string; status: Status; code: string };

export function createInstances({ config, db, arclamp, builds, lightIds, changed = () => {}, pools = null, gone = () => {}, wentIn = () => {} }: InstanceDeps) {
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
      branch: row.branch,
      head: config.sketches ? branchHead(config.sketches.dir, row.sketch_id, row.branch) : null,
      home: row.home,
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

  /** Every light outside an instance's home: none for the base Tone, whose home is every light there is, however many that comes to be. */
  const outsideOf = (inst: InstanceRow) => (isBaseColor(inst.id) ? Promise.resolve([]) : outside(inst.home));

  /** An instance gone: its shader's stream of params ended, and its pool let go. */
  const letGo = (inst: InstanceRow) => {
    gone(inst.pool_id);
    pools?.remove(inst.pool_id);
  };

  /**
   * An instance whose shader's gone: forgotten, its pool with it. The base Tone
   * isn't: it goes back in as it last was (its row has what was wanted of it
   * last), its pool and values kept; only its old stream ends.
   */
  function lost(inst: InstanceRow) {
    if (isBaseColor(inst.id)) {
      gone(inst.pool_id);
      db.updateInstance(inst.id, { shader_id: null, state: "building", error: null });
      changed();
      void place(inst.id);
      return;
    }
    db.deleteInstance(inst.id);
    letGo(inst);
    changed();
  }

  const failed = (id: string, error: string) => {
    db.updateInstance(id, { state: "failed", error });
    changed();
  };

  // Each instance is put in once, however many times it's asked; and one at
  // a time, so each goes where it's to go with those before it in already.
  const placing = new Set<string>();
  let placed: Promise<void> = Promise.resolve();

  /** What's wanted of an instance as it goes in: muted or not, and its whole mask. */
  async function wanted(id: string) {
    const inst = db.instance(id)!;
    return { muted: inst.muted, mask: inst.mask ?? (await outsideOf(inst)) };
  }

  /** The bottom of the stack, for everything but Base Tone: just above it, wherever it is now (1 if it isn't in). */
  function bottom(scene: ShaderDescriptor[]): number {
    const base = db.instance(BASE_COLOR.instance);
    const d = base?.shader_id != null ? scene.find((s) => s.id === base.shader_id && s.type === "js") : undefined;
    return d ? d.position + 1 : 1;
  }

  /**
   * Where a shader goes in, just above the one with the key `above` ("" the
   * bottom, above the base Tone; the base Tone itself, under everything): arclamp's
   * position for it; undefined for the top, as when that shader's gone. One
   * that isn't in yet stands for wherever it's to go.
   */
  function positionOf(id: string, above: string | null, scene: ShaderDescriptor[]): number | undefined {
    if (isBaseColor(id)) return 1;
    const seen = new Set<string>();
    for (let key = above; key !== null && !seen.has(key); ) {
      if (key === "") return bottom(scene);
      seen.add(key);
      const it = shaderOfKey(db, key);
      if (!it) return undefined;
      if (it.arclampId !== null) {
        const d = scene.find((s) => s.id === it.arclampId && s.type === "js");
        return d && d.position + 1;
      }
      key = it.instance?.above ?? null;
    }
    return undefined;
  }

  /**
   * A shader in arclamp, made as wanted: muted first, if it's to be, so it
   * never runs where it shouldn't; else masked, then unmuted.
   */
  async function bringTo(d: ShaderDescriptor, want: { muted: boolean; mask: number[] }) {
    if (want.muted && !d.muted) await arclamp.setMuted(d.id, true);
    if (!sameIds(d.mask ?? [], want.mask)) await arclamp.setMask(d.id, want.mask);
    if (!want.muted && d.muted) await arclamp.setMuted(d.id, false);
  }

  /** A just-placed instance's shader, with what's wanted of it, if that changed as it went in. */
  async function catchUp(id: string): Promise<boolean> {
    const inst = db.instance(id);
    if (!inst || inst.shader_id === null) return false;
    await bringTo(await arclamp.shader(inst.shader_id), await wanted(id));
    return true;
  }

  /** A building instance, into the room once its build is built (or failed, if it isn't). */
  function place(id: string): Promise<void> {
    if (placing.has(id)) return placed;
    placing.add(id);
    placed = placed.then(() => putIn(id)).finally(() => placing.delete(id));
    return placed;
  }

  async function putIn(id: string) {
    try {
      const inst = db.instance(id);
      if (inst?.state !== "building") return;
      const build = db.build(inst.build_id);
      if (!build || build.state === "failed") return failed(id, build?.error ?? "its build is gone");
      if (build.state !== "built" || !build.script) return;
      const sketch = db.sketch(inst.sketch_id);
      if (!sketch || sketch.deleted_at !== null) return failed(id, "its sketch was deleted");
      const script = config.signingKey ? stampAs(build.script, id, config.signingKey) : null;
      if (!script) return failed(id, "its stamp doesn't check out (was vibes' key changed?): put it in again");
      const scene = await arclamp.scene();
      // Put in already, by its stamp (vibes stopped before it noted its shader): that's it.
      const found = scene.find((s) => {
        const read = s.type === "js" && s.script !== undefined ? readStamp(s.script, config.signingKey) : null;
        return read?.verified && read.stamp.shader === id;
      });
      // The base Tone going in anew goes in muted, until its params have reached
      // it (held: base-color.ts lets it go): else it would light the room in
      // its defaults until then.
      const held = !found && isBaseColor(id);
      const want = async () => ({ ...(await wanted(id)), ...(held ? { muted: true } : {}) });
      // Muted and masked as it goes in, so its first frame lights only what
      // it may: arclamp's shaders render as soon as they're in.
      const d = found ?? (await arclamp.createShader(script, positionOf(id, inst.above, scene), await want()));
      // Its shader, noted at once, so the scene shows it as this instance (not someone else's shader) from the start.
      db.updateInstance(id, { shader_id: d.id });
      // Any other instance still noted as this shader is long gone: arclamp
      // gave its id to this one (counting again from 1 after it restarted).
      for (const other of db.instances()) if (other.id !== id && other.shader_id === d.id) lost(other);
      // Brought to what's wanted now: anything wanted while it went in (after
      // it's noted, want catches up), or all of it, from an arclamp that
      // doesn't take them on create.
      await bringTo(d, await want());
      // Moved to another build while it went in (the base Tone's, as vibes
      // starts with new code for it): in as this one, and that one swapped in.
      const moved = db.instance(id)?.build_id;
      db.updateInstance(id, { state: "live", error: null, ...(moved !== build.id ? { build_id: build.id, next_build_id: moved ?? null } : {}) });
      if (held) wentIn(id, d);
      db.log({ user: { id: inst.by_id, name: inst.by_name }, action: "shader.create", shaderId: d.id, shaderName: sketch.name, detail: { ...detail(build, sketch), home: inst.home.length } });
      if (moved !== undefined && moved !== build.id) void swap(id);
      changed();
    } catch (err) {
      failed(id, `couldn't put it in: ${(err as Error).message}`);
    }
  }

  /** A live instance's newer build, swapped in once built. */
  async function swap(id: string) {
    const inst = db.instance(id);
    if (inst?.state !== "live" || !inst.next_build_id || inst.shader_id === null) return;
    const build = db.build(inst.next_build_id);
    if (!build || build.state === "building") return;
    if (build.state === "failed" || !build.script) return changed();
    const script = config.signingKey ? stampAs(build.script, id, config.signingKey) : null;
    if (!script) {
      db.updateInstance(id, { next_build_id: null, error: "couldn't update it: its stamp doesn't check out (was vibes' key changed?)" });
      return changed();
    }
    try {
      await arclamp.setScript(inst.shader_id, script);
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

  type From = { branch: string; commit?: string; build?: string };
  /** What's wanted of it as it goes in: muted, its mask (outside its home is added), its place. */
  type Want = { muted?: boolean; mask?: number[]; above?: string | null };
  type Made = { instance: Instance } | Refusal;

  /** The build to put in: the one given, if it's this sketch's and didn't fail; else a commit's, or the branch head's. */
  async function buildFor(sketchId: string, from: From, user: Me) {
    const given = from.build ? db.build(from.build) : undefined;
    if (given && given.sketch_id === sketchId && given.state !== "failed") return { id: given.id, building: given.state === "building" };
    // vibes' own sketch, with no repo to build: its latest build (default-sketches.ts makes it as vibes starts).
    if (isDefaultSketch(sketchId)) {
      const made = db.buildsOf(sketchId, 1).find((b) => b.state === "built");
      return made ? { id: made.id, building: false } : { refused: "it isn't built yet", status: 503 as const };
    }
    const started = await builds.start(sketchId, from.commit ?? from.branch, user);
    if ("refused" in started) return started;
    return { id: started.build.id, building: started.build.state === "building" };
  }

  async function make(sketchId: string, from: From, homeLights: number[], user: Me, key: string | null, want: Want, pool: string | undefined): Promise<Made> {
    const sketch = db.sketch(sketchId);
    if (!sketch) return refusal("no such sketch", 404, "not_found");
    if (sketch.deleted_at !== null) return refusal("its sketch was deleted", 410, "deleted");
    const bad = await badHome(homeLights);
    if (bad) return refusal(bad, 400, "bad_home");
    const build = await buildFor(sketchId, from, user);
    if ("refused" in build) return refusal(build.refused, build.status, "cant_build");
    const id = randomUUID();
    const home = sorted(homeLights);
    const poolId = pool ?? randomUUID();
    db.addInstance({
      id,
      sketch_id: sketchId,
      branch: from.branch,
      build_id: build.id,
      home,
      by_id: user.id,
      by_name: user.name,
      at: Date.now(),
      client_key: key,
      muted: want.muted ?? false,
      mask: sorted([...(want.mask ?? []), ...(await outside(home))]),
      above: want.above ?? null,
      pool_id: poolId,
    });
    // Its params: in the pool it was previewed with (and its values set then), or a new one.
    pools?.adopt(poolId, `instance:${id}`);
    changed();
    if (!build.building) await place(id);
    return { instance: view(db.instance(id)!) };
  }

  // Being put in now, by whose key: asked again meanwhile, it's the same one.
  const making = new Map<string, Promise<Made>>();

  return {
    view,

    /**
     * A sketch from a branch, put in the room on `home`: at a commit (the
     * branch's head, if none is given), building first if it isn't built.
     * With a key (the browser's, for its pending edit), it's put in once:
     * asked again with the same key, by the same person, it's the instance
     * that was made, so a browser that sends an edit twice can't put it in
     * twice. Muted, masked or placed as `want` says, if it says. Its params
     * in `pool`, if one's given (the one it was previewed with), with
     * whatever's in it.
     */
    async create(sketchId: string, from: From, homeLights: number[], user: Me, key?: string, want: Want = {}, pool?: string): Promise<Made> {
      if (!key) return make(sketchId, from, homeLights, user, null, want, pool);
      const made = db.instanceOfKey(user.id, key);
      if (made) return { instance: view(made) };
      const id = `${user.id}\0${key}`;
      const already = making.get(id);
      if (already) return already;
      const putting = make(sketchId, from, homeLights, user, key, want, pool).finally(() => making.delete(id));
      making.set(id, putting);
      return putting;
    },

    /** A live instance, moved on to another commit (its branch's head by default): built, then swapped in. */
    async update(id: string, rev: string | undefined, user: Me): Promise<{ instance: Instance } | Refusal> {
      const inst = db.instance(id);
      if (!inst) return refusal("no such instance", 404, "not_found");
      if (isDefaultSketch(inst.sketch_id)) return refusal("its code is vibes' own: it changes with vibes", 403, "base_color");
      if (inst.state !== "live") return refusal("it isn't in the room yet", 409, "not_live");
      const started = await builds.start(inst.sketch_id, rev ?? inst.branch, user);
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
      if (isBaseColor(id)) return refusal("Base Tone's home is every light", 403, "base_color");
      const bad = await badHome(homeLights);
      if (bad) return refusal(bad, 400, "bad_home");
      const next = sorted(homeLights);
      const live = inst.state === "live" && inst.shader_id !== null;
      const wasMasked = new Set(live ? ((await arclamp.shader(inst.shader_id!)).mask ?? []) : (inst.mask ?? (await outside(inst.home))));
      const wasHome = new Set(inst.home);
      const nowHome = new Set(next);
      const mask = (await lightIds()).filter((l) => !nowHome.has(l) || (wasHome.has(l) && wasMasked.has(l)));
      // Not in yet, it goes in with it.
      if (live) await arclamp.setMask(inst.shader_id!, mask);
      db.updateInstance(id, { home: next, ...(live ? {} : { mask }) });
      db.log({ user, action: "shader.home", ...(inst.shader_id !== null ? { shaderId: inst.shader_id } : {}), shaderName: db.sketch(inst.sketch_id)?.name ?? null, detail: { lights: next.length } });
      changed();
      return { instance: view(db.instance(id)!) };
    },

    /**
     * What's wanted of an instance that isn't in the room yet, kept to put it
     * in that way: muted, or its whole mask (every light outside its home
     * added). False if it's in (or gone) by now: then it's arclamp's to change.
     */
    async want(id: string, patch: { muted?: boolean; mask?: number[] }): Promise<boolean> {
      const inst = db.instance(id);
      if (!inst || inst.shader_id !== null) return false;
      const mask = patch.mask && sorted([...patch.mask, ...(await outsideOf(inst))]);
      db.updateInstance(id, { ...(patch.muted !== undefined ? { muted: patch.muted } : {}), ...(mask ? { mask } : {}) });
      changed();
      // Gone in meanwhile, after place looked at what's wanted: caught up now.
      return db.instance(id)?.shader_id === null || (await catchUp(id));
    },

    /** An instance that isn't in yet, to go just above the shader with this key ("" the bottom; null the top). */
    setAbove(id: string, above: string | null) {
      const inst = db.instance(id);
      if (!inst || inst.shader_id !== null || inst.above === above) return;
      db.updateInstance(id, { above });
      changed();
    },

    /**
     * An instance out of the room: its shader removed, if it's there, and it
     * forgotten. The base Tone too: its shader let go of first, so its going
     * isn't taken for it lost (and put back meanwhile); vibes puts a new one in.
     */
    async remove(id: string, user: Person): Promise<boolean> {
      const inst = db.instance(id);
      if (!inst) return false;
      if (isBaseColor(id) && inst.shader_id !== null) db.updateInstance(id, { shader_id: null });
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
      letGo(inst);
      changed();
      return true;
    },

    /** A mask for a shader, with every light outside its instance's home added: its home stays all it can light. */
    async within(shaderId: number, mask: number[]): Promise<number[]> {
      const inst = db.instanceOfShader(shaderId);
      return inst ? sorted([...mask, ...(await outsideOf(inst))]) : mask;
    },

    /** A shader's gone (removed through vibes or not): so is its instance (the base Tone goes back in). */
    forget(shaderId: number) {
      const inst = db.instanceOfShader(shaderId);
      if (inst) lost(inst);
    },

    /**
     * The base Tone (shared/base-color.ts) in the room, on this build: made, if
     * it hasn't been, on every light and at the bottom, its pool its own;
     * moved on to this build, if it's on another (a vibes with other code for
     * it); put in, if it isn't, or tried again, if it couldn't go in. Made
     * just now, its pool's first values are `seed`'s to set, before it goes in.
     */
    async keepBase(buildId: string, by: Person, seed: () => Promise<void> = async () => {}): Promise<void> {
      const id = BASE_COLOR.instance;
      const inst = db.instance(id);
      if (!inst) {
        db.addInstance({ id, sketch_id: BASE_COLOR.sketch, build_id: buildId, home: await lightIds(), by_id: by.id, by_name: by.name, at: Date.now(), muted: false, mask: [], above: "", pool_id: BASE_COLOR.pool });
        pools?.adopt(BASE_COLOR.pool, `instance:${id}`);
        await seed();
        changed();
      } else if (inst.build_id !== buildId) {
        if (inst.state === "live" && inst.shader_id !== null) {
          db.updateInstance(id, { next_build_id: buildId, error: null });
          await swap(id);
        } else db.updateInstance(id, { build_id: buildId });
      }
      // Its home is every light: kept so as lights come and go (it can light them all anyway).
      const all = await lightIds();
      if (!sameIds(db.instance(id)!.home, all)) db.updateInstance(id, { home: sorted(all) });
      if (db.instance(id)!.state === "failed") db.updateInstance(id, { state: "building", error: null });
      if (db.instance(id)!.state === "building") await place(id);
    },
  };
}

export type Instances = ReturnType<typeof createInstances>;

export function instanceRoutes(instances: Instances) {
  const badInstance = (r: { success: boolean }, c: Context) => (r.success ? undefined : refuse(c, 400, "say which sketch, and its home: the lights to put it on", "bad_body"));
  const answer = (c: Context, made: { instance: Instance } | Refusal, status: 200 | 202 = 200) =>
    "refused" in made ? refuse(c, made.status, made.refused, made.code) : c.json(made.instance, status);

  // Taken out, it's a shader like any other: DELETE /shaders/:key (shaders.ts).
  return (
    new Hono<AuthEnv>()
      // A sketch, put in the room on the lights given (its home): from a
      // branch (main, unless it says), at a commit (the branch's head, unless
      // it says), or as a build of it (the one previewed, built or building).
      // With a key, put in once however often it's asked. Muted, masked, and
      // just above another shader ("" the bottom), if it says; else on top.
      .post(
        "/instances",
        zValidator(
          "json",
          z.object({
            sketch: z.string().min(1),
            branch,
            commit: z.string().min(1).optional(),
            build: z.string().min(1).max(100).optional(),
            home,
            key: z.string().min(1).max(100).optional(),
            muted: z.boolean().optional(),
            mask: z.array(z.number().int()).max(2000).optional(),
            above: z.string().max(100).nullable().optional(),
          }),
          badInstance,
        ),
        async (c) => {
          const { sketch, branch, commit, build, home, key, muted, mask, above } = c.req.valid("json");
          const from = { branch, ...(commit ? { commit } : {}), ...(build ? { build } : {}) };
          return answer(c, await instances.create(sketch, from, home, c.get("user"), key, { muted, mask, above }), 202);
        },
      )

      .post("/instances/:id/update", zValidator("json", z.object({ commit: z.string().min(1).optional() }), badInstance), async (c) => {
        return answer(c, await instances.update(c.req.param("id"), c.req.valid("json").commit, c.get("user")), 202);
      })

      .put("/instances/:id/home", zValidator("json", z.object({ home }), badInstance), async (c) => {
        return answer(c, await instances.setHome(c.req.param("id"), c.req.valid("json").home, c.get("user")));
      })
  );
}
