// The live state: everything vibes has of the room that a page shows or
// changes, as one tree of values (LiveTree), each at a path ("roomtone/24/
// brightness"). vibes holds it; each page keeps a copy, kept in step by the
// room socket (/api/scene/ws): the whole tree to start (state), then each
// change as it's made (delta), numbered (rev), so a page that reconnects
// says the last it had and gets what it missed.
//
// A page changes it by sending an update: some ops, each a path and its new
// value, or just a path to take it away. vibes checks all of an update before
// making any of it, makes it (each area of the tree in its own way: room tone
// and the stack in arclamp, params in their pools, the layout in vibes'
// database), and says it's done once the tree shows it. Last write wins, path
// by path. What a page has changed and vibes hasn't shown yet, the page shows
// over its copy meanwhile (its draft: web/draft.ts).
//
// The paths a page can change (anything else is vibes' own to say):
//
//   roomtone/<light>/<channel>        a number
//   shaders/<key>                     taken away: out of the room
//   shaders/<+key>                    AddSpec: a sketch put in, under its pending edit's key
//   shaders/<key>/muted               true or false
//   shaders/<key>/mask                the lights it may not change
//   shaders/<key>/instance/home       the lights it was put on (an instance's)
//   stack                             every shader's key, top first
//   pools/<pool>/declared             ParamSpec[], by whoever runs its code
//   pools/<pool>/values/<param>/<light>  a value; taken away, back to the default
//   layout/lights/<light>/spot        Spot, or null: off the map
//   layout/lights/<light>/type        another orientation (an arclamp type)
//   layout/lights/<light>/tags        its whole set of tags
//   layout/rails/<rail>               RailShape, or null: taken away
//
// Nothing is an array but a value: paths only go through objects.

import type { Channels, LightInfo, Rail } from "./arclamp.ts";
import type { ParamSpec, ParamValue } from "./params.ts";
import type { Shader, ShaderKey } from "./vibes.ts";

/** Where a value is in the tree: its keys, joined with "/". */
export type Path = string;

/** A change: a path and its new value, or just a path, to take it away. */
export type Op = [path: Path] | [path: Path, value: unknown];

/**
 * A pool: params as some running code declares them, and their values, light
 * by light. Each shader put in from a sketch has one (Shader.pool); so does a
 * sketch being added, and each preview of one. Its id is anyone's to mint.
 */
export interface Pool {
  /** What the code running with it says it declares; null until something has. */
  declared: ParamSpec[] | null;
  /** Each param's values, by light id: only lights not at the default. */
  values: Record<string, Record<string, ParamValue>>;
}

/** The lights and rails, keyed, as the tree has them. */
export interface Layout {
  id_width: 1 | 2;
  /** The lights' ids in arclamp's order: the light stream's. */
  order: number[];
  lights: Record<string, LightInfo>;
  /** The rails' ids, in the order they were drawn. */
  railOrder: string[];
  rails: Record<string, Rail>;
  /** How many lights and rails differ from arclamp's lights.json. */
  changed: number;
}

export interface LiveTree {
  /** Room tone's channel values, by light id. */
  roomtone: Record<string, Channels>;
  /** Every shader in the stack, by key. */
  shaders: Record<ShaderKey, Shader>;
  /** Their order, top first. */
  stack: ShaderKey[];
  pools: Record<string, Pool>;
  /** Null until vibes has had the lights from arclamp. */
  layout: Layout | null;
}

export const EMPTY_TREE: LiveTree = { roomtone: {}, shaders: {}, stack: [], pools: {}, layout: null };

/** A sketch put in the room, as an update says it (at shaders/<+key>, its pending edit's key). */
export interface AddSpec {
  sketch: string;
  branch: string;
  /** The build previewed (or building); without one, its branch's head is built. */
  build?: string;
  home: number[];
  muted: boolean;
  mask: number[];
  /** Just above this shader ("" the bottom); on top without one. */
  above?: ShaderKey;
  /** Its pool: its params' values as they were set before it went in, and what it declares. */
  pool?: string;
}

/** A pool's id: a UUID, minted by whoever needs one. */
export const POOL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A key that can be in a path: no slashes, and not empty. */
const KEY = /^[^/]+$/;

export const pathOf = (...keys: (string | number)[]): Path => {
  const parts = keys.map(String);
  if (!parts.every((k) => KEY.test(k))) throw new Error(`not a path: ${JSON.stringify(parts)}`);
  return parts.join("/");
};

export const keysOf = (path: Path): string[] => (path === "" ? [] : path.split("/"));

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The value at a path, or undefined if there's none. */
export function valueAt(tree: unknown, path: Path): unknown {
  let at = tree;
  for (const k of keysOf(path)) {
    if (!isObject(at) || !Object.hasOwn(at, k)) return undefined;
    at = at[k];
  }
  return at;
}

/**
 * The tree with one change made, copied along the path (the rest shared, so
 * whatever didn't change is the same object it was). Setting a path through
 * something that isn't an object makes objects of the way there.
 */
export function withOp<T>(tree: T, op: Op): T {
  const keys = keysOf(op[0]);
  const remove = op.length === 1;
  const go = (node: unknown, i: number): unknown => {
    if (i === keys.length) return remove ? undefined : op[1];
    const k = keys[i]!;
    const here = isObject(node) ? node : {};
    if (remove && !Object.hasOwn(here, k)) return node;
    const next = go(here[k], i + 1);
    if (next === here[k] && Object.hasOwn(here, k)) return node;
    const out = { ...here };
    if (next === undefined) delete out[k];
    else out[k] = next;
    return out;
  };
  if (keys.length === 0) return (remove ? {} : op[1]) as T;
  return go(tree, 0) as T;
}

export const withOps = <T>(tree: T, ops: readonly Op[]): T => ops.reduce(withOp, tree);

/** Whether two values are the same, all the way down. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bs = b as unknown[];
    return a.length === bs.length && a.every((v, i) => same(v, bs[i]));
  }
  const ak = Object.keys(a);
  const bo = b as Record<string, unknown>;
  return ak.length === Object.keys(bo).length && ak.every((k) => Object.hasOwn(bo, k) && same((a as Record<string, unknown>)[k], bo[k]));
}

/**
 * The changes that turn `a` into `b`, under `prefix`: objects gone into key
 * by key, anything else (arrays too) given whole where it differs, keys `b`
 * hasn't taken away. None, if they're the same.
 */
export function diff(a: unknown, b: unknown, prefix: Path = ""): Op[] {
  if (same(a, b)) return [];
  if (!isObject(a) || !isObject(b)) return [[prefix, b]];
  const at = (k: string) => (prefix === "" ? k : `${prefix}/${k}`);
  const out: Op[] = [];
  for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) out.push([at(k)]);
  for (const [k, v] of Object.entries(b)) out.push(...diff(a[k], v, at(k)));
  return out;
}

/** Whether `path` is `prefix` or under it. */
export const under = (path: Path, prefix: Path) => path === prefix || path.startsWith(`${prefix}/`);

/** The room socket: what a page says (after `auth`, from another of vibes' addresses), and what vibes says. */
export type RoomRequest =
  | { type: "auth"; token: string }
  /** Ready for the tree: from scratch (null), or what's changed since `rev` (of vibes' run `epoch`, as the tree it had said). */
  | { type: "hello"; rev: number | null; epoch?: string }
  /** Changes, all or none; `note` says what for, for the history (a room tone choice's name). */
  | { type: "update"; id: string; ops: Op[]; note?: string };

export type RoomMessage =
  /** The whole tree, as of change `rev` of this run of vibes (`epoch`: its changes count from 0 again when it starts again). */
  | { type: "state"; rev: number; epoch: string; tree: LiveTree }
  | { type: "delta"; rev: number; ops: Op[] }
  /** An update made, and shown in the tree; the shaders it added, by the keys of the edits that added them. */
  | { type: "done"; id: string; made: Record<string, ShaderKey> }
  /** An update not made (all of it, or, failing part way in arclamp, the rest of it), and why. */
  | { type: "refused"; id: string; error: string; code: string; made: Record<string, ShaderKey> }
  | { type: "ping" };
