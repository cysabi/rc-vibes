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
//   pools/<pool>/values/<param>/<light>/<part>  one of a color's numbers (a, b, lm, fidelity)
//   layout/lights/<light>/spot        Spot, or null: off the map
//   layout/lights/<light>/type        another orientation (an arclamp type)
//   layout/lights/<light>/tags        its whole set of tags
//   layout/rails/<rail>               RailShape, or null: taken away
//   show/transport                    TransportAction: something done to the show (shared/show.ts)
//   show/apply                        { scene, at }: a scene applied on the show's clock (server/show-apply.ts)
//   scenes/list/<id>                  { name }: a scene made (or renamed); null: taken away (shared/scenes.ts)
//   scenes/list/<id>/name             its name
//   scenes/list/<id>/shaders/<key>    its sketch, with its knobs (SceneKnobs); null: none
//   scenes/list/<id>/shaders/<key>/<param>/<light>  one of its knobs; taken away, back to the default
//   scenes/order                      every scene's id, in order
//
// (show/on, show/clock, show/cue and show/queued are vibes' own: what each
// action makes. Scenes are made at once, whatever the mode: they're the
// room's, never a pending edit.)
//
// Nothing is an array but a value: paths only go through objects.
//
// On the socket, many lights set to one value at once (a drag over every
// light selected) can go as one op, a fan: the path with "*" for the light,
// the value, and which lights, as a bitfield (lightsField). Each end opens a
// fan into its ops as it arrives (unfanOps), so nothing past the socket sees
// one: the tree, drafts, history and last-write-wins are path by path, as
// ever. A page says in its hello that it reads fans; one that doesn't (from
// before them) is sent every op on its own.

import type { Channels, LightInfo, Rail } from "./arclamp.ts";
import type { ParamSpec, ParamValue } from "./params.ts";
import type { Presence } from "./presence.ts";
import { NO_SCENES, type Scenes } from "./scenes.ts";
import { RESTING, type ShowState } from "./show.ts";
import type { Shader, ShaderKey } from "./vibes.ts";

/** Where a value is in the tree: its keys, joined with "/". */
export type Path = string;

/** A change: a path and its new value, or just a path, to take it away. */
export type Op = [path: Path] | [path: Path, value: unknown];

/** Lights set to one value, on the socket: the path with "*" for the light, the value, and the lights (lightsField). */
export type FanOp = [path: Path, value: unknown, lights: string];

/** An op as the socket carries it: on its own, or a fan of them. */
export type WireOp = Op | FanOp;

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
  /** Whether a show's on, and its clock (shared/show.ts). */
  show: ShowState;
  /** The room's scenes (shared/scenes.ts). */
  scenes: Scenes;
}

export const EMPTY_TREE: LiveTree = { roomtone: {}, shaders: {}, stack: [], pools: {}, layout: null, show: RESTING, scenes: NO_SCENES };

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

// The paths with a light in them, that fans are of: "*" where the light is, "?" any one key.
const FANNABLE = [
  ["roomtone", "*", "?"],
  ["pools", "?", "values", "?", "*"],
  ["pools", "?", "values", "?", "*", "?"],
  ["layout", "lights", "*", "?"],
];
// A light's id as a key, as a lights field can say it: at most two bytes (arclamp's id_width).
const LIGHT_KEY = /^[1-9][0-9]{0,4}$/;
const MOST_LIGHT = 0xffff;
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// The longest a lights field can be: every light there can be.
const MOST_FIELD = Math.ceil((((MOST_LIGHT >> 3) + 1) * 8) / 6);

/** A path with a light in it as a fan has it ("*" for the light), and the light; null if it hasn't one. */
function starred(path: Path): { star: Path; light: number } | null {
  const keys = keysOf(path);
  for (const t of FANNABLE) {
    if (t.length !== keys.length) continue;
    const at = t.indexOf("*");
    const light = LIGHT_KEY.test(keys[at]!) ? Number(keys[at]) : 0;
    if (light < 1 || light > MOST_LIGHT) continue;
    if (!t.every((k, i) => k === "*" || (k === "?" ? keys[i] !== "*" : k === keys[i]))) continue;
    return { star: keys.map((k, i) => (i === at ? "*" : k)).join("/"), light };
  }
  return null;
}

/** Whether a path is one with "*" for a light, as a fan has it. */
const fannable = (star: Path) => {
  const keys = keysOf(star);
  return FANNABLE.some((t) => t.length === keys.length && t.every((k, i) => (k === "*" ? keys[i] === "*" : k === "?" ? keys[i] !== "*" && keys[i] !== "" : k === keys[i])));
};

/** Lights as a fan has them: a bitfield (light n is byte n >> 3's bit n & 7), as unpadded base64url. */
export function lightsField(ids: Iterable<number>): string {
  const list = [...ids];
  const bytes = new Uint8Array(list.length === 0 ? 0 : (Math.max(...list) >> 3) + 1);
  for (const id of list) bytes[id >> 3] = bytes[id >> 3]! | (1 << (id & 7));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(3, bytes.length - i) + 1;
    for (let j = 0; j < chars; j++) out += BASE64URL[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}

/** The lights a lights field says, lowest first; null if it isn't one. */
export function lightsOf(field: string): number[] | null {
  if (field.length > MOST_FIELD || field.length % 4 === 1) return null;
  const ids: number[] = [];
  let buffer = 0;
  let bits = 0;
  let byte = 0;
  for (const c of field) {
    const v = BASE64URL.indexOf(c);
    if (v < 0) return null;
    buffer = ((buffer << 6) | v) & 0x3fff;
    bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    const b = (buffer >> bits) & 0xff;
    for (let k = 0; k < 8; k++) if (b & (1 << k)) ids.push(byte * 8 + k);
    byte += 1;
  }
  // There's no light 0.
  return ids[0] === 0 ? null : ids;
}

/**
 * Ops for the socket: in each run of ops in a row setting lights' values at
 * one path but for the light, each light once, those set to the same value
 * as one fan, where there's more than one. Opened (unfanOps), they're the
 * same changes: each light in a run has its own path, so their order within
 * it doesn't matter.
 */
export function fanOps(ops: readonly Op[]): WireOp[] {
  const out: WireOp[] = [];
  for (let i = 0; i < ops.length; ) {
    const op = ops[i]!;
    const first = op.length === 2 ? starred(op[0]) : null;
    if (!first) {
      out.push(op);
      i += 1;
      continue;
    }
    const groups = new Map<string | undefined, { value: unknown; lights: number[] }>();
    const seen = new Set<number>();
    for (; i < ops.length; i++) {
      const o = ops[i]!;
      if (o.length !== 2) break;
      const s = starred(o[0]);
      if (!s || s.star !== first.star || seen.has(s.light)) break;
      seen.add(s.light);
      const key = JSON.stringify(o[1]);
      const g = groups.get(key);
      if (g) g.lights.push(s.light);
      else groups.set(key, { value: o[1], lights: [s.light] });
    }
    for (const { value, lights } of groups.values()) {
      out.push(lights.length > 1 ? [first.star, value, lightsField(lights)] : [first.star.replace("*", String(lights[0])), value]);
    }
  }
  return out;
}

/**
 * Ops off the socket, each fan opened into its ops, lowest light first: or
 * "bad", if a fan isn't of lights' paths, or "too_big", if there'd be more
 * than `most` (found before making more than one fan's past it).
 */
export function unfanOps(ops: readonly WireOp[], most = Infinity): Op[] | "bad" | "too_big" {
  const out: Op[] = [];
  for (const op of ops) {
    if (op.length !== 3) {
      out.push(op);
    } else {
      const [star, value, field] = op;
      const lights = typeof star === "string" && typeof field === "string" && fannable(star) ? lightsOf(field) : null;
      if (!lights || lights.length === 0) return "bad";
      if (out.length + lights.length > most) return "too_big";
      for (const light of lights) out.push([star.replace("*", String(light)), value]);
    }
    if (out.length > most) return "too_big";
  }
  return out;
}

/** The room socket: what a page says (after `auth`, from another of vibes' addresses), and what vibes says. */
export type RoomRequest =
  | { type: "auth"; token: string }
  /** Ready for the tree: from scratch (null), or what's changed since `rev` (of vibes' run `epoch`, as the tree it had said); `fans`, if it reads them in deltas. */
  | { type: "hello"; rev: number | null; epoch?: string; fans?: boolean }
  /** Changes, all or none (fans among them); `note` says what for, for the history (a room tone choice's name). */
  | { type: "update"; id: string; ops: WireOp[]; note?: string }
  /** What time arclamp's clock says it is (web/rtime.ts): answered at once. */
  | { type: "time"; id: number }
  /** Where this page is, for everyone else's (shared/presence.ts): the floor it's looking at, and the lights it has selected. */
  | { type: "presence"; floor: number | null; selected: number[] };

export type RoomMessage =
  /** The whole tree, as of change `rev` of this run of vibes (`epoch`: its changes count from 0 again when it starts again). */
  | { type: "state"; rev: number; epoch: string; tree: LiveTree }
  /** Changes made: with fans, to a page that said it reads them. */
  | { type: "delta"; rev: number; ops: WireOp[] }
  /** An update made, and shown in the tree; the shaders it added, by the keys of the edits that added them. */
  | { type: "done"; id: string; made: Record<string, ShaderKey> }
  /** An update not made (all of it, or, failing part way in arclamp, the rest of it), and why. */
  | { type: "refused"; id: string; error: string; code: string; made: Record<string, ShaderKey> }
  /** Every page open on the room, this one too, as of now (shared/presence.ts). */
  | { type: "presence"; people: Presence[] }
  | { type: "ping" }
  /** arclamp's time as vibes reckons it (`r`, ms), as it answered; and how far off vibes might be from arclamp's own (`e`, ms; null till arclamp's answered vibes). */
  | { type: "time"; id: number; r: number; e: number | null };
