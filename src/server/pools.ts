// Pools: params as some running code declares them (a sketch's, put in the
// room, being added, or previewed), and their values, light by light. Each
// is in the live tree (pools/<id>: shared/live.ts), held here, and saved a
// second after it last changed (so a knob dragged for a while is saved once,
// as it was left). Its id is whoever made it's own to mint.
//
// Anyone may set a pool's values; only its owner may say what it declares:
// for a shader put in from a sketch, its instance (vibes, for the shader in
// the room: params.ts); otherwise whoever made it (someone adding a sketch,
// who previewed it; a box's preview). A pool an instance takes on is its from
// then on. A value is kept if it's one of its param's kind (cleanValue), or,
// before anything's said what's declared, any value a param could have. What
// isn't its param's (declared since as another kind, or for lights it's no
// longer for) stays as it was, passed over wherever it's read.

import type { LightInfo } from "../shared/arclamp.ts";
import { pathOf, type Op, type Pool } from "../shared/live.ts";
import { cleanValue, colorValue, groupsOf, lightsFor, sameValue, type Changes, type ParamSpec, type ParamTable, type ParamValue } from "../shared/params.ts";
import type { Db, PoolRow } from "./db.ts";

const SAVE_MS = 1000;
// A pool no instance has, untouched this long, is let go (a preview closed, a sketch never put in).
const IDLE_MS = 24 * 60 * 60 * 1000;
const SWEEP_MS = 10 * 60 * 1000;

/** A value any param could have: a number, true or false, or a color. */
export const anyValue = (v: unknown): ParamValue | null =>
  typeof v === "number" ? (Number.isFinite(v) ? v : null) : typeof v === "boolean" ? v : colorValue(v);

/** A change to one param's values, light by light: each light's new value, or null back to the default. */
export type LightChanges = [light: number, value: ParamValue | null][];

export interface PoolDeps {
  db: Pick<Db, "pools" | "savePool" | "deletePool">;
  /** Each change, as ops on the live tree. */
  publish: (ops: Op[]) => void;
  /** Every light, for which lights a param's for. */
  lights: () => Promise<LightInfo[]>;
  now?: () => number;
}

export function createPools({ db, publish, lights, now = Date.now }: PoolDeps) {
  const pools = new Map(db.pools().map((p) => [p.id, p]));
  const unsaved = new Map<string, ReturnType<typeof setTimeout>>();
  // Told of each change to a pool's values (the shader in the room, a preview), and of its declarations.
  const changeListeners = new Set<(id: string, name: string, set: Changes) => void>();

  function save(p: PoolRow) {
    p.touched = now();
    clearTimeout(unsaved.get(p.id));
    const t = setTimeout(() => {
      unsaved.delete(p.id);
      if (pools.get(p.id) === p) db.savePool(p);
    }, SAVE_MS);
    t.unref?.();
    unsaved.set(p.id, t);
  }

  const asTree = (p: PoolRow): Pool => ({ declared: p.declared, values: p.values });

  /** A pool, made (owned by `owner`) if there isn't one. */
  function ensure(id: string, owner: string): PoolRow {
    let p = pools.get(id);
    if (p) return p;
    const at = now();
    p = { id, owner, declared: null, values: {}, link_epoch: 0, at, touched: at };
    pools.set(id, p);
    db.savePool(p);
    publish([[pathOf("pools", id), asTree(p)]]);
    return p;
  }

  /** Each param's values as the stream to code running with it has them: grouped by value. */
  function table(p: PoolRow): ParamTable {
    const out: ParamTable = {};
    for (const [name, byLight] of Object.entries(p.values)) {
      const spec = p.declared?.find((s) => s.name === name);
      const values = new Map<number, ParamValue>();
      for (const [id, v] of Object.entries(byLight)) {
        const clean = spec ? cleanValue(spec, v) : anyValue(v);
        if (clean !== null) values.set(Number(id), clean);
      }
      // Without a declaration, there's no default to leave out: each value's given.
      out[name] = spec ? groupsOf(spec, values) : [...values].map(([id, v]) => [v, [id]]);
    }
    return out;
  }

  const sweep = setInterval(() => {
    for (const p of pools.values()) {
      if (!p.owner.startsWith("instance:") && now() - p.touched > IDLE_MS) remove(p.id);
    }
  }, SWEEP_MS);
  sweep.unref?.();

  function remove(id: string) {
    if (!pools.delete(id)) return;
    clearTimeout(unsaved.get(id));
    unsaved.delete(id);
    db.deletePool(id);
    publish([[pathOf("pools", id)]]);
  }

  return {
    get: (id: string) => pools.get(id),

    /** Every pool, as the live tree has them. */
    tree: (): Record<string, Pool> => Object.fromEntries([...pools.values()].map((p) => [p.id, asTree(p)])),

    ensure,

    /** A pool taken on by `owner` (an instance, of one its pending edit made): its declarations are its owner's to say from then on. */
    adopt(id: string, owner: string) {
      const p = ensure(id, owner);
      if (p.owner === owner) return;
      p.owner = owner;
      save(p);
    },

    /** Whether `who` may say what a pool declares: its owner, or anyone, for one that isn't made yet. */
    mayDeclare: (id: string, who: string) => (pools.get(id)?.owner ?? who) === who,

    /** What the code running with a pool says it declares. Its values stay as they are. */
    declare(id: string, specs: ParamSpec[], owner: string) {
      const p = ensure(id, owner);
      if (JSON.stringify(p.declared) === JSON.stringify(specs)) return;
      p.declared = specs;
      save(p);
      publish([[pathOf("pools", id, "declared"), specs]]);
    },

    /**
     * Some lights' values of a param changed (null, back to the default), as
     * its declaration allows: the lights it's for (of these), and values of
     * its kind; before it's declared, any light, and any value a param could
     * have. A param its code doesn't declare (when it's said what it does) is
     * passed over, as one its sketch no longer has. Whether anything changed.
     */
    async set(id: string, name: string, changes: LightChanges, owner: string): Promise<boolean> {
      const isFor = lightsFor(await lights());
      // Read and written with nothing awaited between: nothing since is lost.
      const p = ensure(id, owner);
      const spec = p.declared ? p.declared.find((s) => s.name === name) : null;
      if (spec === undefined) return false;
      const allowed = spec ? isFor(spec) : () => true;
      const byLight = { ...p.values[name] };
      const ops: Op[] = [];
      const set: Changes = [];
      for (const [light, raw] of changes) {
        if (!Number.isInteger(light) || light <= 0 || !allowed(light)) continue;
        const value = raw === null ? null : spec ? cleanValue(spec, raw) : anyValue(raw);
        if (raw !== null && value === null) continue;
        const was = byLight[String(light)];
        // Back to the default is the same as not being listed.
        const next = value !== null && spec && sameValue(value, spec.default) ? null : value;
        if (next === null ? was === undefined : was !== undefined && sameValue(was, next)) continue;
        if (next === null) delete byLight[String(light)];
        else byLight[String(light)] = next;
        ops.push(next === null ? [pathOf("pools", id, "values", name, light)] : [pathOf("pools", id, "values", name, light), next]);
        const g = set.find(([v]) => (v === null || next === null ? v === next : sameValue(v, next)));
        if (g) g[1].push(light);
        else set.push([next, [light]]);
      }
      if (ops.length === 0) return false;
      p.values = { ...p.values, [name]: byLight };
      save(p);
      publish(ops);
      for (const l of changeListeners) l(id, name, set);
      return true;
    },

    /** Each param's values, as the stream to code running with the pool has them. */
    table: (id: string): ParamTable => {
      const p = pools.get(id);
      return p ? table(p) : {};
    },

    /** A new link to a pool from the room: its number, counted up, so older links' tokens stop working. */
    relink(id: string): number {
      const p = pools.get(id);
      if (!p) return 0;
      p.link_epoch += 1;
      db.savePool(p);
      return p.link_epoch;
    },

    /** Told of each change to any pool's values. */
    onChange(listener: (id: string, name: string, set: Changes) => void) {
      changeListeners.add(listener);
      return () => void changeListeners.delete(listener);
    },

    remove,

    /** Everything changed lately, saved now (vibes stopping). */
    stop() {
      clearInterval(sweep);
      for (const [id, t] of unsaved) {
        clearTimeout(t);
        const p = pools.get(id);
        if (p) db.savePool(p);
      }
      unsaved.clear();
    },
  };
}

export type Pools = ReturnType<typeof createPools>;
