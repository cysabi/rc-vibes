// Updates: a page's changes to the live state (shared/live.ts lists the
// paths it can change), made here. Each update is checked as it comes, all of
// it, before any of it's made: refused whole if any of it's wrong. Then made,
// one at a time for each page (its socket's session), area by area, in an
// order that keeps the room right as it goes: room tone; shaders taken out;
// sketches put in (their pools first); each shader's home, mute and mask (its
// mask before it's unmuted, so it never runs where it shouldn't); params; the
// stack's order; the map's layout. Updates that come while one's being made
// are made next, together, the latest of each path winning. Each is answered
// (done) once the tree shows it.
//
// Room tone, each shader, and the stack are each changed in arclamp one call
// at a time (latest): changes from anyone that come while a call's out are
// merged and sent as the next, so the room keeps up with the latest without
// a queue, and arclamp's never asked more often than it answers. (Waiting
// longer between calls only made a drag reach the lights later: 10 ms more
// apart took room tone from 51 ms to 75 ms, pointer to light.) Pools and the
// layout are vibes' own, changed at once.
//
// A shader that's gone meanwhile has nothing left to change, so changing it
// (or taking it out) isn't refused. arclamp isn't all or nothing, so an
// update failing there part way leaves what was made before it made: it's
// refused, with the shaders it added (made) so far.

import { z } from "zod";
import type { Channels } from "../shared/arclamp.ts";
import { isBaseColor } from "../shared/base-color.ts";
import { keysOf, POOL_ID, type AddSpec, type Op, type RoomMessage } from "../shared/live.ts";
import { COLOR_PARTS, PARAM_NAME, type ColorPart, type ParamSpec } from "../shared/params.ts";
import { RAIL_ID, type RailShape } from "../shared/rails.ts";
import { MAX_TAGS, TAG } from "../shared/tags.ts";
import type { Me, Placement, ShaderKey, Spot } from "../shared/vibes.ts";
import { ArclampError } from "./arclamp.ts";
import { isBranchName } from "./git.ts";
import type { Instances } from "./instances.ts";
import type { LayoutEdits } from "./layout.ts";
import { declarationsOf } from "./params.ts";
import { anyValue, ColorPatch, laterChange, type LightChange, type Pools } from "./pools.ts";
import { Refused, type Shaders } from "./shaders.ts";

/** The most changes an update can carry. */
export const MAX_OPS = 20_000;

const LIGHT = /^[1-9][0-9]{0,8}$/;
const WORD = /^[A-Za-z][\w-]{0,39}$/;
const keyText = z.string().min(1).max(100);
const ids = z.array(z.number().int()).max(2000);
const point = z.object({ mm_x: z.number().finite(), mm_y: z.number().finite() });
const addSpec: z.ZodType<AddSpec> = z.object({
  sketch: z.string().min(1).max(100),
  branch: z.string().refine(isBranchName),
  build: keyText.optional(),
  home: ids.min(1),
  muted: z.boolean(),
  mask: ids,
  above: z.string().max(100).optional(),
  pool: z.string().regex(POOL_ID).optional(),
});
const spot: z.ZodType<Spot | null> = z
  .union([
    z.object({ coords: z.object({ mm_x: z.number().finite(), mm_y: z.number().finite(), floor: z.number().int() }) }),
    z.object({ rail: z.object({ id: z.string().regex(RAIL_ID), mm_along: z.number().finite() }) }),
  ])
  .nullable();
const railShape: z.ZodType<RailShape | null> = z.object({ floor: z.number().int(), from: point, to: point }).nullable();

/** An update, as made: what it changes, by area, each path's latest. */
export interface Batch {
  roomtone: Record<string, Channels>;
  removes: Set<ShaderKey>;
  adds: Map<ShaderKey, AddSpec>;
  shaders: Map<ShaderKey, { muted?: boolean; mask?: number[]; home?: number[] }>;
  stack: ShaderKey[] | null;
  declared: Map<string, ParamSpec[]>;
  values: Map<string, Map<string, Map<number, LightChange>>>;
  spots: Map<number, Spot | null>;
  types: Map<number, string>;
  tags: Map<number, string[]>;
  rails: Map<string, RailShape | null>;
  note: string | undefined;
  /** Nothing to change: just answered once the tree's up to date (a page that wants to be sure it is). */
  sync: boolean;
}

const emptyBatch = (): Batch => ({
  roomtone: {},
  removes: new Set(),
  adds: new Map(),
  shaders: new Map(),
  stack: null,
  declared: new Map(),
  values: new Map(),
  spots: new Map(),
  types: new Map(),
  tags: new Map(),
  rails: new Map(),
  note: undefined,
  sync: false,
});

/** What vibes won't make of an update, and why. */
export class Unmade extends Error {
  readonly code: string;
  readonly made: Record<string, ShaderKey>;
  constructor(code: string, message: string, made: Record<string, ShaderKey> = {}) {
    super(message);
    this.code = code;
    this.made = made;
  }
}

/** The changes in an update, by area, each checked; Unmade if any isn't one a page can make. */
export function parseOps(ops: readonly Op[], note?: string): Batch {
  if (ops.length > MAX_OPS) throw new Unmade("too_big", `an update carries at most ${MAX_OPS} changes`);
  const b = emptyBatch();
  b.note = note;
  b.sync = ops.length === 0;
  const bad = (path: string, why = "isn't a change a page can make") => new Unmade("bad_update", `${path} ${why}`);
  const check = <T>(schema: z.ZodType<T>, v: unknown, path: string): T => {
    const r = schema.safeParse(v);
    if (!r.success) throw bad(path, `can't be ${JSON.stringify(v)?.slice(0, 80)}`);
    return r.data;
  };
  for (const op of ops) {
    if (!Array.isArray(op) || typeof op[0] !== "string" || op.length < 1 || op.length > 2) throw new Unmade("bad_update", "a change is [path] or [path, value]");
    const [path] = op;
    const k = keysOf(path);
    const set = op.length === 2;
    const v = op[1];
    switch (k[0]) {
      case "roomtone": {
        if (k.length !== 3 || !LIGHT.test(k[1]!) || !WORD.test(k[2]!) || !set) throw bad(path);
        if (typeof v !== "number" || !Number.isFinite(v)) throw bad(path, "is a number");
        (b.roomtone[k[1]!] ??= {})[k[2]!] = v;
        break;
      }
      case "shaders": {
        const key = k[1];
        if (!key || !keyText.safeParse(key).success) throw bad(path);
        if (k.length === 2) {
          if (!set) {
            b.removes.add(key);
            b.adds.delete(key);
          } else {
            if (!key.startsWith("+")) throw bad(path, "is a shader in the room: it's put in under its pending edit's key (+…)");
            b.adds.set(key, check(addSpec, v, path));
            b.removes.delete(key);
          }
        } else if (k.length === 3 && set && (k[2] === "muted" || k[2] === "mask")) {
          const s = b.shaders.get(key) ?? {};
          if (k[2] === "muted") s.muted = check(z.boolean(), v, path);
          else s.mask = check(ids, v, path);
          b.shaders.set(key, s);
        } else if (k.length === 4 && set && k[2] === "instance" && k[3] === "home") {
          b.shaders.set(key, { ...b.shaders.get(key), home: check(ids.min(1), v, path) });
        } else throw bad(path);
        break;
      }
      case "stack":
        if (k.length !== 1 || !set) throw bad(path);
        b.stack = check(z.array(keyText).max(500), v, path);
        break;
      case "pools": {
        const pool = k[1];
        if (!pool || !POOL_ID.test(pool)) throw bad(path, "isn't a pool");
        if (k.length === 3 && k[2] === "declared" && set) {
          if (!Array.isArray(v)) throw bad(path, "is a list of params");
          b.declared.set(pool, declarationsOf(v).specs);
        } else if ((k.length === 5 || k.length === 6) && k[2] === "values" && PARAM_NAME.test(k[3]!) && LIGHT.test(k[4]!)) {
          let change: LightChange;
          if (k.length === 6) {
            // One of a color's numbers: over the light's color as it is (pools.ts).
            if (!set || !COLOR_PARTS.includes(k[5] as ColorPart) || typeof v !== "number" || !Number.isFinite(v)) throw bad(path, "is one of a color's numbers");
            change = new ColorPatch({ [k[5]!]: v });
          } else {
            change = set ? anyValue(v) : null;
            if (set && change === null) throw bad(path, "is a number, true or false, or a color");
          }
          const byParam = b.values.get(pool) ?? new Map<string, Map<number, LightChange>>();
          const byLight = byParam.get(k[3]!) ?? new Map<number, LightChange>();
          const light = Number(k[4]);
          byLight.set(light, laterChange(byLight.get(light), change));
          byParam.set(k[3]!, byLight);
          b.values.set(pool, byParam);
        } else throw bad(path);
        break;
      }
      case "layout": {
        if (k[1] === "lights" && k.length === 4 && LIGHT.test(k[2]!) && set) {
          const id = Number(k[2]);
          if (k[3] === "spot") b.spots.set(id, check(spot, v, path));
          else if (k[3] === "type") b.types.set(id, check(z.string().min(1).max(40), v, path));
          else if (k[3] === "tags") b.tags.set(id, check(z.array(z.string().regex(TAG)).max(MAX_TAGS), v, path));
          else throw bad(path);
        } else if (k[1] === "rails" && k.length === 3 && RAIL_ID.test(k[2]!) && set) {
          b.rails.set(k[2]!, check(railShape, v, path));
        } else throw bad(path);
        break;
      }
      default:
        throw bad(path);
    }
  }
  return b;
}

/** Two updates as one: the later's changes over the earlier's, path by path. */
export function mergeBatches(a: Batch, b: Batch): Batch {
  const out = emptyBatch();
  out.roomtone = { ...a.roomtone };
  for (const [id, ch] of Object.entries(b.roomtone)) out.roomtone[id] = { ...out.roomtone[id], ...ch };
  out.removes = new Set([...[...a.removes].filter((k) => !b.adds.has(k)), ...b.removes]);
  out.adds = new Map([...[...a.adds].filter(([k]) => !b.removes.has(k)), ...b.adds]);
  out.shaders = new Map(a.shaders);
  for (const [k, s] of b.shaders) out.shaders.set(k, { ...out.shaders.get(k), ...s });
  out.stack = b.stack ?? a.stack;
  out.declared = new Map([...a.declared, ...b.declared]);
  out.values = new Map([...a.values].map(([p, m]) => [p, new Map([...m].map(([n, l]) => [n, new Map(l)]))]));
  for (const [p, m] of b.values) {
    const into = out.values.get(p) ?? new Map<string, Map<number, LightChange>>();
    for (const [n, l] of m) {
      const byLight = new Map(into.get(n));
      for (const [light, change] of l) byLight.set(light, laterChange(byLight.get(light), change));
      into.set(n, byLight);
    }
    out.values.set(p, into);
  }
  out.spots = new Map([...a.spots, ...b.spots]);
  out.types = new Map([...a.types, ...b.types]);
  out.tags = new Map([...a.tags, ...b.tags]);
  out.rails = new Map([...a.rails, ...b.rails]);
  out.note = b.note ?? a.note;
  out.sync = a.sync && b.sync;
  return out;
}

/**
 * Changes to one thing, made one call at a time: whatever comes while one's
 * out is merged into the next (the latest last), and made together once it's
 * back. Each change's promise is settled by the call that made it.
 */
function latest<V>(make: (v: V, user: Me, note?: string) => Promise<void>, merge: (a: V, b: V) => V) {
  let next: { v: V; user: Me; note?: string; waiters: { resolve: () => void; reject: (err: unknown) => void }[] } | null = null;
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    while (next) {
      const now = next;
      next = null;
      try {
        await make(now.v, now.user, now.note);
        for (const w of now.waiters) w.resolve();
      } catch (err) {
        for (const w of now.waiters) w.reject(err);
      }
    }
    running = false;
  }
  return (v: V, user: Me, note?: string) =>
    new Promise<void>((resolve, reject) => {
      if (next) {
        next.v = merge(next.v, v);
        next.user = user;
        next.note = note ?? next.note;
        next.waiters.push({ resolve, reject });
      } else next = { v, user, note, waiters: [{ resolve, reject }] };
      void run();
    });
}

/** Gone already: nothing left to change. */
const gone = (err: unknown) => (err instanceof Refused || err instanceof ArclampError) && err.status === 404;

export interface UpdateDeps {
  shaders: Shaders;
  /** Sketches in the room (null with sketches off: nothing can be added). */
  instances: Instances | null;
  pools: Pools;
  layout: LayoutEdits;
  /** Room tone, merged into arclamp's and noted in the history. */
  setRoomtone: (lights: Record<string, Channels>, user: Me, code?: string) => Promise<unknown>;
  /** Once the tree shows the scene as it is now: at once, or (soon) paced, for a run of changes. */
  shown: (soon: boolean) => Promise<unknown>;
  /** A param's values changed in a pool, by someone, on this many lights: for the history. */
  logParam?: (pool: string, name: string, lights: number, user: Me) => void;
}

export function createUpdates({ shaders, instances, pools, layout, setRoomtone, shown, logParam = () => {} }: UpdateDeps) {
  const roomtone = latest<Record<string, Channels>>(
    async (lights, user, note) => void (await setRoomtone(lights, user, note)),
    (a, b) => {
      const out = { ...a };
      for (const [id, ch] of Object.entries(b)) out[id] = { ...out[id], ...ch };
      return out;
    },
  );
  const stack = latest<ShaderKey[]>(
    (order, user) => shaders.reorder(order, user),
    (_a, b) => b,
  );
  // Each shader's home, mute and mask, by its key as vibes keeps it.
  type Setting = { muted?: boolean; mask?: number[]; home?: number[] };
  const settings = new Map<ShaderKey, (s: Setting, user: Me) => Promise<void>>();
  const settingsOf = (key: ShaderKey) => {
    let s = settings.get(key);
    if (!s) {
      s = latest<Setting>(
        async (want, user) => {
          try {
            if (want.home) await shaders.setHome(key, want.home, user);
            // Unmuting, the mask goes first, so it never runs on lights it's meant to stay off; muting, the mute does.
            const mute = want.muted === undefined ? null : () => shaders.setMuted(key, want.muted!, user);
            const mask = want.mask === undefined ? null : () => shaders.setMask(key, want.mask!, user);
            for (const step of want.muted === false ? [mask, mute] : [mute, mask]) if (step) await step();
          } catch (err) {
            if (!gone(err)) throw err;
          }
        },
        (a, b) => ({ ...a, ...b }),
      );
      settings.set(key, s);
    }
    return s;
  };

  /**
   * Whether a sketch being added (by its pending edit's key) may go in with
   * this pool: one its page minted (not on vibes yet, or this person's), or
   * the one it went in with already (the same add, sent again). Never
   * another's: that would take its params over.
   */
  const mayTake = (pool: string, key: ShaderKey, user: Me) => {
    if (pools.mayDeclare(pool, `user:${user.id}`)) return true;
    const made = shaders.keyOf(key, user);
    return made !== null && pools.get(pool)?.owner === `instance:${made}`;
  };

  /** A batch, made: the shaders it added, by their pending edits' keys; whether the scene needs to be shown for it. Unmade, failing part way. */
  async function make(b: Batch, user: Me): Promise<{ made: Record<string, ShaderKey>; scene: boolean }> {
    const made: Record<string, ShaderKey> = {};
    const owner = `user:${user.id}`;
    // Pools only come to be with a sketch put in with one (or a preview, in its
    // box): changes to any other pool vibes doesn't have are passed over.
    const adding = new Set([...b.adds.values()].flatMap((a) => (a.pool ? [a.pool] : [])));
    const known = (pool: string) => adding.has(pool) || pools.get(pool) !== undefined;
    let scene = false;
    const step = async (what: () => Promise<unknown>, passGone = false) => {
      try {
        await what();
      } catch (err) {
        if (passGone && gone(err)) return;
        const why = err instanceof Refused || err instanceof ArclampError ? err : null;
        if (!why) console.error(err);
        throw new Unmade(why?.code ?? "internal", why?.message ?? "internal error", made);
      }
    };

    if (Object.keys(b.roomtone).length > 0) {
      scene = true;
      await step(() => roomtone(b.roomtone, user, b.note));
    }
    for (const key of b.removes) {
      scene = true;
      await step(() => shaders.remove(key, user), true);
    }
    for (const [key, add] of b.adds) {
      scene = true;
      if (!instances) throw new Unmade("no_sketches", "sketches are off here", made);
      // Its pool first: what it was previewed declaring, and the values set on it then.
      if (add.pool) {
        if (!mayTake(add.pool, key, user)) throw new Unmade("not_owner", "that pool is another shader's", made);
        const declared = b.declared.get(add.pool);
        if (declared && pools.mayDeclare(add.pool, owner)) pools.declare(add.pool, declared, owner);
        else pools.ensure(add.pool, owner);
      }
      await step(async () => {
        const above = add.above === undefined ? null : add.above === "" ? "" : shaders.keyOf(add.above, user);
        const from = { branch: add.branch, ...(add.build ? { build: add.build } : {}) };
        const it = await instances.create(add.sketch, from, add.home, user, key, { muted: add.muted, mask: add.mask, above }, add.pool);
        if ("refused" in it) throw new Refused(it.status, it.code, it.refused);
        made[key] = it.instance.id;
      });
    }
    for (const [key, s] of b.shaders) {
      const at = shaders.keyOf(key, user);
      if (!at) continue;
      scene = true;
      await step(() => settingsOf(at)(s, user));
    }
    for (const [pool, specs] of b.declared) {
      if (adding.has(pool) || !known(pool)) continue;
      if (!pools.mayDeclare(pool, owner)) throw new Unmade("not_owner", "what a pool declares is for the code running with it to say", made);
      pools.declare(pool, specs, owner);
    }
    for (const [pool, byParam] of b.values) {
      if (!known(pool)) continue;
      for (const [name, byLight] of byParam) {
        if (await pools.set(pool, name, [...byLight], owner)) logParam(pool, name, byLight.size, user);
      }
    }
    if (b.stack) {
      scene = true;
      await step(() => stack(b.stack!, user));
    }
    if (b.rails.size > 0) await step(() => layout.setRails([...b.rails].map(([id, rail]) => ({ id, rail })), user));
    if (b.spots.size > 0) {
      const placements = [...b.spots].map(([id, s]): Placement => (s && "rail" in s ? { id, rail: s.rail } : { id, coords: s?.coords ?? null }));
      await step(() => layout.place(placements, user));
    }
    if (b.types.size > 0) await step(() => layout.turn([...b.types].map(([id, type]) => ({ id, type })), user));
    if (b.tags.size > 0) await step(() => layout.tag([...b.tags].map(([id, tags]) => ({ id, tags })), user));
    return { made, scene: scene || b.sync };
  }

  return {
    /**
     * One page's updates (its socket's): each checked as it comes, then made
     * in order, those waiting made together; each answered (say) once the
     * tree shows it, in the order they came.
     */
    session(user: Me, say: (m: RoomMessage) => void) {
      let closed = false;
      const waiting: { id: string; batch: Batch }[] = [];
      let making = false;
      let answering: Promise<void> = Promise.resolve();

      async function makeWaiting() {
        if (making) return;
        making = true;
        while (waiting.length > 0 && !closed) {
          const run = waiting.splice(0);
          const batch = run.map((r) => r.batch).reduce(mergeBatches);
          let said: Omit<Extract<RoomMessage, { type: "done" }>, "id"> | Omit<Extract<RoomMessage, { type: "refused" }>, "id">;
          let scene = true;
          try {
            const out = await make(batch, user);
            said = { type: "done", made: out.made };
            scene = out.scene;
          } catch (err) {
            const why = err instanceof Unmade ? err : new Unmade("internal", "internal error");
            if (!(err instanceof Unmade)) console.error(err);
            said = { type: "refused", error: why.message, code: why.code, made: why.made };
          }
          // Answered once the tree shows it: a page's own run of changes (live
          // mode's) paced; the next is made meanwhile.
          const showing: Promise<unknown> = scene ? shown(!batch.sync) : Promise.resolve();
          answering = answering
            .then(() => showing)
            .catch(() => {})
            .then(() => {
              for (const { id } of run) say({ ...said, id });
            });
        }
        making = false;
      }

      return {
        take(id: string, ops: Op[], note?: string) {
          let batch: Batch;
          try {
            batch = parseOps(ops, note);
          } catch (err) {
            const why = err instanceof Unmade ? err : new Unmade("bad_update", "invalid update");
            say({ type: "refused", id, error: why.message, code: why.code, made: {} });
            return;
          }
          // A sketch put in with another's pool, or declaring for a pool
          // someone else's code runs with: all of it refused. (A sketch put
          // in again, the same add sent twice, keeps the pool it went in with.)
          const owner = `user:${user.id}`;
          const refuse = (error: string) => say({ type: "refused", id, error, code: "not_owner", made: {} });
          const taking = new Set<string>();
          for (const [key, add] of batch.adds) {
            if (!add.pool) continue;
            if (!mayTake(add.pool, key, user)) return refuse("that pool is another shader's");
            taking.add(add.pool);
          }
          for (const pool of batch.declared.keys()) {
            if (!taking.has(pool) && !pools.mayDeclare(pool, owner)) return refuse("what a pool declares is for the code running with it to say");
          }
          // The base Tone is on every light: moving its home refuses all of it.
          const base = (key: string) => isBaseColor(shaders.keyOf(key, user));
          for (const [key, s] of batch.shaders) {
            if (s.home && base(key)) return say({ type: "refused", id, error: "Base Tone's home is every light", code: "base_color", made: {} });
          }
          waiting.push({ id, batch });
          void makeWaiting();
        },
        close() {
          closed = true;
        },
      };
    },
  };
}

export type Updates = ReturnType<typeof createUpdates>;
