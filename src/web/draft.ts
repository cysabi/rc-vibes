// Pending edits: changes made in vibes that haven't been applied to the room:
// this page's layer over its copy of the live state (scene.ts). While there
// are any, vibes is in simulated mode: the map shows what the room would do
// with them (sim.ts), Apply sends them as one update, and Discard throws them
// away. In live mode, they're sent as they're made. Either way they stay here,
// shown over the copy, until vibes says it's made them. Each browser has its
// own; others keep seeing the live room.
//
// A draft records only what you changed, on top of whatever is live, so
// changes others make meanwhile still show through: room tone, each shader's
// mute, mask, home, params and place in the stack, the shaders taken out of it, and
// the sketches being put in (each on its home, previewed once built, with a
// pool of its own for its params, which goes in with it). A shader on its way
// in, or one you're adding, is switched and moved like any other: vibes puts
// it in that way. It knows shaders by vibes' keys; which shader in arclamp
// each is, only vibes' server knows.

import { useSyncExternalStore } from "react";
import type { Channels } from "../shared/arclamp.ts";
import { BASE_TONE_NAME, isBaseColor } from "../shared/base-color.ts";
import { keysOf, pathOf, type AddSpec, type Op, type Pool } from "../shared/live.ts";
import {
  changedParts,
  cleanValue,
  sameValue,
  tableOf,
  withChanges,
  type Changes,
  type ColorPart,
  type ColorValue,
  type ParamSpec,
  type ParamValue,
  type ShaderParams,
} from "../shared/params.ts";
import type { Instance, ShaderKey, ShaderSketch } from "../shared/vibes.ts";
import { invalidateScene, sendUpdate, UpdateError, type Scene, type SceneShader } from "./scene.ts";

/** A shader in the stack: vibes' key, for one in the room or on its way; "+…" for a sketch you're adding. */
export type LayerKey = ShaderKey;

export interface ShaderPatch {
  muted?: boolean;
  /** The lights it may not change: its whole mask. */
  mask?: number[];
  /** An instance's (or a sketch being added's) home: all it can light. */
  home?: number[];
  /** Its params' values, by name: each light's, by id, over the live ones (null back to the default). */
  params?: Record<string, Record<string, ParamValue | null>>;
}

export interface Draft {
  /** Room tone channel values, by light id, over the live template. */
  roomtone: Record<string, Channels>;
  /** The last room tone choice's code, for the history. */
  roomtoneCode: string | null;
  edits: Record<LayerKey, ShaderPatch>;
  /** The stack's order, top first, once you've reordered it. */
  order: LayerKey[] | null;
  /** Shaders to take out of the room. */
  removed: LayerKey[];
  /** Sketches to put in, on top, each on its home. */
  added: Adding[];
}

/**
 * A sketch being added to the room, on a home (the lights it was added on):
 * its main built on the server (adding.ts), then previewed on the map, then,
 * applied, put in (an instance, POST /api/instances).
 */
export interface Adding {
  /** "+" and an id of its own. */
  key: LayerKey;
  sketchId: string;
  sketchName: string;
  /** The branch it's from (main, so far): built at its head, and built again there on trying again. */
  branch: string;
  home: number[];
  /** Every light outside its home, which the preview keeps it off, as the room will. */
  mask: number[];
  /** Its build, once asked for. */
  build: { id: string; commit: string; state: "building" | "built" | "failed"; error: string | null } | null;
  /** Its params' pool: minted here, it goes in with it, values set meanwhile and all. */
  pool: string;
  /** What it declares, as the preview of it says (sim.ts), once it's run there. */
  declared: ParamSpec[] | null;
}

export const EMPTY: Draft = { roomtone: {}, roomtoneCode: null, edits: {}, order: null, removed: [], added: [] };

// The shader each sketch you added became, by its key in the draft: so
// what's open on one stays open on it, once it's in.
const madeAs = new Map<LayerKey, ShaderKey>();

/** A shader's key now: the shader a sketch you added became, if it's gone in. */
export const keyNow = (key: LayerKey): LayerKey => madeAs.get(key) ?? key;

// Built scripts of sketches being added, by build: kept here, not in the
// draft, which is saved on every change (a room tone drag included).
const addedScripts = new Map<string, string>();

/** A sketch being added's built script, if it's here yet. */
export const scriptOfBuild = (buildId: string) => addedScripts.get(buildId);

/** A shader as the stack shows it: as vibes has it, with the draft's edits. */
export interface Layer {
  key: LayerKey;
  /**
   * In the room (live); on its way in (building), or that couldn't go in
   * (failed); or a sketch you're adding (only in your draft, until you apply).
   */
  stage: "adding" | SceneShader["stage"];
  /** The shader as vibes has it, before the draft's edits (for its state and errors); null for one you're adding. */
  shader: SceneShader | null;
  name: string;
  /** The sketch it's built from, if it's a sketch's. */
  sketch: ShaderSketch | null;
  /** Its script, once it's here (what the preview runs); "" till then. */
  script: string;
  muted: boolean;
  /** The lights it may not change (there its output is its input), sorted. */
  mask: number[];
  /** Who made it, as arclamp has it (the name of the key it was made with); before it's in, who put it in. */
  by: string;
  /** The instance it is, if it was put in from a sketch in vibes: its home is all it can light. */
  instance: Instance | null;
  /** Where its code has lit: every light it's changed, before its mask or mute. */
  footprint: number[];
  /** If it's a sketch being added (not in the room yet): which. */
  adding: Adding | null;
  /** Its params, if it was put in from a sketch (or is being): what the sketch declares, and their values, pending edits over the live ones. */
  params: ShaderParams | null;
  /** Its params' pool, if it has one. */
  pool: string | null;
}

/** A sketch being added, as a layer on top of the stack: for the preview (once built), and the list. */
function layerOfAdding(a: Adding, d: Draft): Layer {
  const script = a.build ? (addedScripts.get(a.build.id) ?? "") : "";
  const commit = a.build?.commit ?? "";
  const patch = d.edits[a.key] ?? {};
  const instance: Instance = {
    id: a.key,
    sketchId: a.sketchId,
    sketchName: a.sketchName,
    commit,
    buildId: a.build?.id ?? "",
    branch: a.branch,
    head: null,
    home: patch.home ?? a.home,
    state: a.build?.state === "failed" ? "failed" : "building",
    error: a.build?.error ?? null,
    next: null,
    by: { id: "", name: "" },
    at: 0,
  };
  const sketch: ShaderSketch = { id: a.sketchId, name: a.sketchName, commit, edited: false, deleted: false };
  // Its params as its preview says it declares them, with whatever's been set on them meanwhile.
  const params = a.declared ? paramsWith({ declared: a.declared, values: {} }, patch.params) : null;
  return {
    key: a.key,
    stage: "adding",
    shader: null,
    name: a.sketchName,
    sketch,
    script,
    muted: patch.muted ?? false,
    mask: patch.mask ?? a.mask,
    by: "",
    instance,
    footprint: [],
    adding: a,
    params,
    pool: a.pool,
  };
}

/** Whether a shader can be switched and moved: any but one that couldn't go in. */
export const changeable = (layer: Pick<Layer, "stage">) => layer.stage !== "failed";

/**
 * The lights a shader is about: its instance's home, or, with none (put in
 * some other way), where its code has lit. A selection lists the shaders it
 * shares a light with.
 */
export const reachOf = (layer: Layer): readonly number[] => layer.instance?.home ?? layer.footprint;

/** Whether a shader's on for some lights: for all of them, none (or it's muted), or some. */
export type SwitchState = "on" | "off" | "mixed";

const sortedIds = (ids: Iterable<number>) => [...new Set(ids)].sort((a, b) => a - b);

/** Whether a shader's on for the lights in `ids` it's about (all of its reach, if none are given). */
export function switchState(layer: Layer, ids?: readonly number[]): SwitchState {
  const reach = new Set(reachOf(layer));
  const here = (ids ?? [...reach]).filter((id) => reach.has(id));
  if (layer.muted || here.length === 0) return "off";
  const mask = new Set(layer.mask);
  const off = here.filter((id) => mask.has(id)).length;
  return off === 0 ? "on" : off === here.length ? "off" : "mixed";
}

/**
 * A shader switched on or off for some lights (of the ones it can light: its
 * home's, for an instance), as a draft edit. Off on everything it's about is
 * off, so that's a mute, its mask left as it was; on, when it's muted, is on
 * for just these.
 */
export function switchFor(layer: Layer, ids: readonly number[], on: boolean, all: readonly number[]): ShaderPatch {
  const home = layer.instance ? new Set(layer.instance.home) : null;
  const these = home ? ids.filter((id) => home.has(id)) : [...ids];
  const mask = new Set(layer.mask);
  if (on) {
    if (layer.muted) {
      const chosen = new Set(these);
      return { muted: false, mask: sortedIds(all.filter((id) => !chosen.has(id))) };
    }
    for (const id of these) mask.delete(id);
    return { mask: sortedIds(mask) };
  }
  for (const id of these) mask.add(id);
  if (reachOf(layer).every((id) => mask.has(id))) return { muted: true };
  return { mask: sortedIds(mask) };
}

/** A shader on for everything it can light (all of its home, for an instance), or off. */
export function switchEverywhere(layer: Layer, on: boolean, all: readonly number[]): ShaderPatch {
  if (!on) return { muted: true };
  const home = layer.instance ? new Set(layer.instance.home) : null;
  return { muted: false, mask: home ? all.filter((id) => !home.has(id)) : [] };
}

/** Whether two masks name the same lights. */
export function sameMask(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a);
  return b.every((id) => ids.has(id));
}

/** Whether a home pending for a shader isn't the one its instance has (false for one that isn't an instance). */
const homeDiffers = (shader: Pick<SceneShader, "instance">, home: readonly number[] | undefined): boolean =>
  !!home && !!shader.instance && !sameMask(home, shader.instance.home);

/** The lights a shader's on: of those it reaches, the ones it isn't switched off for (none, muted). */
export function domainOf(layer: Layer): number[] {
  if (layer.muted) return [];
  const masked = new Set(layer.mask);
  return reachOf(layer).filter((id) => !masked.has(id));
}

/**
 * A shader on just these lights, as a draft edit: on none, it's muted (its
 * mask left as it was); otherwise unmuted and masked from every other light.
 * An instance (or a sketch being added) can only light its home, so lights
 * outside it are added to it; one put in some other way has no home, its
 * mask is all there is. The base Tone's home is every light, and nobody moves
 * it (vibes refuses to): just its mask, for it.
 */
export function domainPatch(layer: Layer, ids: Iterable<number>, all: readonly number[]): ShaderPatch {
  const on = new Set(ids);
  if (on.size === 0) return { muted: true };
  const mask = sortedIds(all.filter((id) => !on.has(id)));
  const home = isBaseColor(layer.key) ? null : layer.instance?.home;
  if (home && [...on].some((id) => !home.includes(id))) return { muted: false, mask, home: sortedIds([...home, ...on]) };
  return { muted: false, mask };
}

/** The room tone template with the draft's values over the live one. */
export function templateOf(scene: Scene, d: Draft): Record<string, Channels> {
  const base = scene.roomtone?.lights ?? {};
  const out: Record<string, Channels> = { ...base };
  for (const [id, ch] of Object.entries(d.roomtone)) out[id] = { ...out[id], ...ch };
  return out;
}

/** Lights' values (null: back to the default) as a change: each value with its lights. */
function changesOf(byLight: Iterable<[number, ParamValue | null]>): Changes {
  const out: Changes = [];
  for (const [id, v] of byLight) {
    const g = out.find(([w]) => (v === null || w === null ? v === w : sameValue(v, w)));
    if (g) g[1].push(id);
    else out.push([v, [id]]);
  }
  return out;
}

/** What's pending for a param, as a change. */
const pendingChanges = (pending: Record<string, ParamValue | null>): Changes => changesOf(Object.entries(pending).map(([id, v]) => [Number(id), v]));

/** A shader's params with what's pending over its live values. */
function paramsWith(params: ShaderParams | null, pending: ShaderPatch["params"]): ShaderParams | null {
  if (!params?.declared || !pending) return params;
  const values = { ...params.values };
  for (const spec of params.declared) {
    const p = pending[spec.name];
    if (p) values[spec.name] = withChanges(spec, values[spec.name], pendingChanges(p));
  }
  return { declared: params.declared, values };
}

/** A pool's params as a page shows them: what's declared, and their values (null if there's no such pool yet). */
function paramsOfPool(pool: Pool | undefined): ShaderParams | null {
  if (!pool) return null;
  return { declared: pool.declared, values: pool.declared ? tableOf(pool.declared, pool.values) : {} };
}

/**
 * Of what's pending for a pool's params, what isn't what it has already
 * (each light's value, or the default), as changes to it: a value, or, back
 * to the default, the value taken away; or, for a color with only some of
 * its numbers changed (a brightness dragged over lights of different
 * colors), just those, each number's lights together, so they go as one fan
 * (shared/live.ts).
 */
function paramOps(pool: string, declared: readonly ParamSpec[] | null, live: Pool["values"] | undefined, pending: ShaderPatch["params"]): Op[] {
  if (!declared || !pending) return [];
  const ops: Op[] = [];
  for (const [name, byLight] of Object.entries(pending)) {
    const spec = declared.find((s) => s.name === name);
    if (!spec) continue;
    const parts = new Map<ColorPart, Op[]>();
    for (const [id, v] of Object.entries(byLight)) {
      const kept = live?.[name]?.[id];
      const was = (kept !== undefined ? cleanValue(spec, kept) : null) ?? spec.default;
      if (sameValue(v ?? spec.default, was)) continue;
      const changed = v === null ? null : changedParts(kept ?? spec.default, v);
      if (!changed) {
        const at = pathOf("pools", pool, "values", name, id);
        ops.push(v === null ? [at] : [at, v]);
        continue;
      }
      for (const k of changed) {
        if (!parts.has(k)) parts.set(k, []);
        parts.get(k)!.push([pathOf("pools", pool, "values", name, id, k), (v as ColorValue)[k]]);
      }
    }
    for (const each of parts.values()) ops.push(...each);
  }
  return ops;
}

/** The light a param op is for: pools/<pool>/values/<param>/<light>, and maybe a color's number after it. */
const lightOfParamOp = (op: Op): number => Number(keysOf(op[0])[4]);

/** Whether what's pending changes a shader's params at all. */
function paramsDiffer(scene: Scene, shader: SceneShader, pending: ShaderPatch["params"]): boolean {
  const pool = shader.pool ? scene.pools[shader.pool] : undefined;
  return shader.pool !== null && paramOps(shader.pool, pool?.declared ?? null, pool?.values, pending).length > 0;
}

function layerOfShader(scene: Scene, shader: SceneShader, d: Draft): Layer {
  const patch = changeable(shader) ? (d.edits[shader.key] ?? {}) : {};
  return {
    key: shader.key,
    stage: shader.stage,
    shader,
    // The base Tone is a Tone set as the base: called so everywhere.
    name: isBaseColor(shader.key) ? BASE_TONE_NAME : shader.name,
    sketch: shader.sketch,
    script: shader.script ?? "",
    muted: patch.muted ?? shader.muted,
    mask: patch.mask ?? shader.mask,
    by: shader.by,
    instance: shader.instance && patch.home ? { ...shader.instance, home: patch.home } : shader.instance,
    footprint: shader.footprint,
    adding: null,
    params: shader.pool ? paramsWith(paramsOfPool(scene.pools[shader.pool]), patch.params) : null,
    pool: shader.pool,
  };
}

/** One shader with the draft's edits (even one the draft takes out), or one you're adding; null if there's no such shader. */
export function layerOf(scene: Scene, d: Draft, key: LayerKey): Layer | null {
  const shader = scene.shaders.find((s) => s.key === key);
  if (shader) return layerOfShader(scene, shader, d);
  const adding = d.added.find((a) => a.key === key);
  return adding ? layerOfAdding(adding, d) : null;
}

/** The stack as vibes has it, top first, without what the draft takes out. */
const sceneKeys = (scene: Scene, d: Draft) => scene.shaders.map((s) => s.key).filter((k) => !d.removed.includes(k));

/** The stack with the draft applied, top first: without the shaders it takes out. */
export function layersOf(scene: Scene, d: Draft): Layer[] {
  const removed = new Set(d.removed);
  const layers = new Map<LayerKey, Layer>();
  // Sketches being added go in on top, the latest topmost (unless you moved them).
  for (const a of [...d.added].reverse()) layers.set(a.key, layerOfAdding(a, d));
  for (const s of scene.shaders) if (!removed.has(s.key)) layers.set(s.key, layerOfShader(scene, s, d));
  // Your order where you set one; anything that turned up since keeps its
  // place relative to the top.
  const all = [...layers.keys()];
  const ordered = (d.order ?? all).filter((k) => layers.has(k));
  const missing = all.filter((k) => !ordered.includes(k));
  return [...missing, ...ordered].map((k) => layers.get(k)!);
}

/**
 * The whole stack's order (top first) with just `some` of its shaders
 * rearranged, into the places those shaders already hold; the rest stay put.
 */
export function reorderWithin(all: LayerKey[], some: LayerKey[]): LayerKey[] {
  const moving = new Set(some);
  const next = [...some];
  return all.map((key) => (moving.has(key) ? next.shift()! : key));
}

/** How many separate changes the draft makes to what's live. */
export function pendingCount(scene: Scene, d: Draft): number {
  // A sketch being added is one change, however it's switched or placed.
  const layers = layersOf(scene, d).filter((l) => l.shader);
  let n = Object.keys(roomtoneChanges(scene, d)).length > 0 ? 1 : 0;
  n += removedOf(scene, d).length;
  n += d.added.length;
  for (const l of layers) {
    const patch = d.edits[l.key];
    if (
      l.muted !== l.shader!.muted ||
      !sameMask(l.mask, l.shader!.mask) ||
      homeDiffers(l.shader!, patch?.home) ||
      paramsDiffer(scene, l.shader!, patch?.params)
    )
      n++;
  }
  if (layers.map((l) => l.key).join() !== sceneKeys(scene, d).join()) n++;
  return n;
}

/**
 * Each shader the draft changes anything about, if it were saved, and the
 * lights that changes: one switched on or off (all it reaches), or for some
 * lights (those); moved to another home (the lights in one but not the
 * other); its params' values for any; one taken out, put
 * in, or moved in the stack (all it reaches). Each sorted; a shader with
 * nothing changed isn't in it.
 */
export function changesByLayer(scene: Scene, d: Draft): Map<LayerKey, number[]> {
  const out = new Map<LayerKey, Set<number>>();
  /** A change to a shader, and the lights it changes (maybe none). */
  const touch = (key: LayerKey, ids: Iterable<number>) => {
    let s = out.get(key);
    if (!s) out.set(key, (s = new Set()));
    for (const id of ids) s.add(id);
  };
  /** The lights in one of these but not the other. */
  const differ = (a: readonly number[], b: readonly number[]) => {
    const was = new Set(a);
    const now = new Set(b);
    return [...a.filter((id) => !now.has(id)), ...b.filter((id) => !was.has(id))];
  };
  const layers = layersOf(scene, d);
  for (const l of layers) {
    if (l.adding) {
      touch(l.key, reachOf(l));
      continue;
    }
    const shader = l.shader;
    if (!shader) continue;
    if (l.muted !== shader.muted) touch(l.key, reachOf(l));
    if (shader.instance && homeDiffers(shader, d.edits[l.key]?.home)) touch(l.key, differ(shader.instance.home, reachOf(l)));
    if (!sameMask(shader.mask, l.mask)) touch(l.key, differ(shader.mask, l.mask));
    const pool = shader.pool ? scene.pools[shader.pool] : undefined;
    const params = shader.pool ? paramOps(shader.pool, pool?.declared ?? null, pool?.values, d.edits[l.key]?.params) : [];
    if (params.length > 0) touch(l.key, params.map(lightOfParamOp));
  }
  for (const key of removedOf(scene, d)) {
    const l = layerOf(scene, d, key);
    touch(key, l ? reachOf(l) : []);
  }
  // Moved: each one in the room no longer over the same ones as it was.
  const was = sceneKeys(scene, d);
  const now = layers.filter((l) => l.shader).map((l) => l.key);
  if (was.join() !== now.join()) {
    for (const l of layers) {
      if (!l.shader) continue;
      const before = was.slice(was.indexOf(l.key) + 1).join();
      const after = now.slice(now.indexOf(l.key) + 1).join();
      if (before !== after) touch(l.key, reachOf(l));
    }
  }
  return new Map([...out].map(([key, ids]) => [key, [...ids].sort((a, b) => a - b)]));
}

/**
 * The lights the draft changes anything for, if it were saved: their room
 * tone, and whatever it changes about any shader (changesByLayer). Sorted.
 */
export function changedLights(scene: Scene, d: Draft): number[] {
  const out = new Set<number>(Object.keys(roomtoneChanges(scene, d)).map(Number));
  for (const ids of changesByLayer(scene, d).values()) ids.forEach((id) => out.add(id));
  return [...out].sort((a, b) => a - b);
}

/** The shaders the draft takes out that are still there. */
export function removedOf(scene: Scene, d: Draft): LayerKey[] {
  const here = new Set(scene.shaders.map((s) => s.key));
  return d.removed.filter((k) => here.has(k));
}

// arclamp keeps channels as float32, so that's as close as a value can match.
const same = (a: number | undefined, b: number) => a !== undefined && Math.fround(a) === Math.fround(b);

/** Of channel values over others, the ones that are different. */
function colorChanges(base: Record<string, Channels>, over: Record<string, Channels>): Record<string, Channels> {
  const out: Record<string, Channels> = {};
  for (const [id, ch] of Object.entries(over)) {
    const diff = Object.fromEntries(Object.entries(ch).filter(([name, v]) => !same(base[id]?.[name], v)));
    if (Object.keys(diff).length > 0) out[id] = diff;
  }
  return out;
}

/** The room tone values the draft actually changes. */
export const roomtoneChanges = (scene: Scene, d: Draft): Record<string, Channels> => colorChanges(scene.roomtone?.lights ?? {}, d.roomtone);

// ---- the store --------------------------------------------------------------

const STORAGE = "vibes.draft";
let draft: Draft = load();
const listeners = new Set<() => void>();

function load(): Draft {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return EMPTY;
    const saved = { ...EMPTY, ...(JSON.parse(raw) as Partial<Draft>) };
    // Saved before shaders had vibes' keys (by arclamp's ids: "#12"): those edits are let go.
    const old = (key: string) => key.startsWith("#");
    return {
      ...saved,
      edits: Object.fromEntries(Object.entries(saved.edits).filter(([key]) => !old(key))),
      order: saved.order?.some(old) ? null : saved.order,
      removed: saved.removed.filter((key) => !old(key)),
      // Saved before sketches being added had a branch (all of them were main), or a pool.
      added: saved.added.map((a) => ({ ...a, branch: a.branch ?? "main", pool: a.pool ?? crypto.randomUUID(), declared: a.declared ?? null })),
    };
  } catch {
    return EMPTY;
  }
}

function set(next: Draft) {
  draft = next;
  try {
    if (next === EMPTY) localStorage.removeItem(STORAGE);
    else localStorage.setItem(STORAGE, JSON.stringify(next));
  } catch {
    // Pending edits just won't survive a reload.
  }
  for (const l of listeners) l();
}

export function useDraft(): Draft {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => draft,
  );
}

export const currentDraft = () => draft;

export const drafts = {
  setRoomtone(lights: Record<string, Channels>, code: string | null) {
    const roomtone = { ...draft.roomtone };
    for (const [id, ch] of Object.entries(lights)) roomtone[id] = { ...roomtone[id], ...ch };
    set({ ...draft, roomtone, roomtoneCode: code });
  },
  /** Change a shader's mute or mask. */
  patchShader(key: LayerKey, patch: ShaderPatch) {
    set({ ...draft, edits: { ...draft.edits, [key]: { ...draft.edits[key], ...patch } } });
  },
  /** Change a param of a shader on some lights (null: back to its default), over whatever's pending for it already. */
  setParam(key: LayerKey, name: string, changes: readonly [number, ParamValue | null][]) {
    const was = draft.edits[key]?.params?.[name] ?? {};
    const now = { ...was, ...Object.fromEntries(changes.map(([id, v]) => [String(id), v])) };
    set({ ...draft, edits: { ...draft.edits, [key]: { ...draft.edits[key], params: { ...draft.edits[key]?.params, [name]: now } } } });
  },
  /** Every one of these params back to its default, for these lights (each name's), in one change. */
  resetParams(key: LayerKey, params: readonly { name: string; ids: readonly number[] }[]) {
    const was = draft.edits[key]?.params ?? {};
    const now = { ...was };
    for (const { name, ids } of params) now[name] = { ...now[name], ...Object.fromEntries(ids.map((id) => [String(id), null])) };
    set({ ...draft, edits: { ...draft.edits, [key]: { ...draft.edits[key], params: now } } });
  },
  reorder(keysTopFirst: LayerKey[]) {
    set({ ...draft, order: keysTopFirst });
  },
  /** Take a shader out of the room. */
  remove(key: LayerKey) {
    if (!draft.removed.includes(key)) set({ ...draft, removed: [...draft.removed, key] });
  },
  /** Keep a shader you were taking out. */
  keep(key: LayerKey) {
    set({ ...draft, removed: draft.removed.filter((k) => k !== key) });
  },
  /**
   * A sketch to put in, on `home`, its build asked for next (adding.ts); its
   * key, which vibes is sent with it, to put it in once however often it's
   * sent. Its params get a pool of their own, here, from the start.
   */
  add(a: Pick<Adding, "sketchId" | "sketchName" | "branch" | "home" | "mask">): LayerKey {
    const key = `+${crypto.randomUUID()}`;
    set({ ...draft, added: [...draft.added, { ...a, key, build: null, pool: crypto.randomUUID(), declared: null }] });
    return key;
  },
  /** What a sketch being added declares, as its preview says (sim.ts). */
  declared(key: LayerKey, specs: ParamSpec[]) {
    const a = draft.added.find((x) => x.key === key);
    if (!a || JSON.stringify(a.declared) === JSON.stringify(specs)) return;
    set({ ...draft, added: draft.added.map((x) => (x.key === key ? { ...x, declared: specs } : x)) });
  },
  /**
   * How a sketch being added's build is going; with its script, once it's
   * built. The draft only changes when that does (it's looked at every second).
   */
  built(key: LayerKey, build: NonNullable<Adding["build"]>, script?: string) {
    if (script !== undefined) addedScripts.set(build.id, script);
    const was = draft.added.find((a) => a.key === key)?.build;
    const same = was && was.id === build.id && was.commit === build.commit && was.state === build.state && was.error === build.error;
    if (same && script === undefined) return;
    set({ ...draft, added: draft.added.map((a) => (a.key === key ? { ...a, build } : a)) });
  },
  /** A sketch being added, built again (after its build failed), at its branch's head. */
  rebuild(key: LayerKey) {
    set({ ...draft, added: draft.added.map((a) => (a.key === key ? { ...a, build: null } : a)) });
  },
  /** Not adding a sketch after all. */
  unadd(key: LayerKey) {
    set({ ...draft, added: draft.added.filter((a) => a.key !== key) });
  },
  discard() {
    set(EMPTY);
  },
};

// ---- apply ------------------------------------------------------------------

/**
 * What the draft changes, as changes to the live state: room tone, the
 * shaders it takes out, the sketches it adds (each with its pool: what it
 * declares, as its preview said, and the values set on it), each other
 * shader's mute, mask and params, and the stack's order. vibes makes them in
 * the order that keeps the room right (updates.ts). What it changes that's
 * the same as what's there already is left out.
 */
export function opsOf(scene: Scene, d: Draft): Op[] {
  const ops: Op[] = [];
  for (const [id, ch] of Object.entries(roomtoneChanges(scene, d))) {
    for (const [name, v] of Object.entries(ch)) ops.push([pathOf("roomtone", id, name), v]);
  }
  const byKey = new Map(scene.shaders.map((s) => [s.key, s]));
  // The whole stack as you'd have it, top first, sketches you're adding included.
  const order = layersOf(scene, d).map((l) => l.key);

  for (const key of d.removed) if (byKey.has(key)) ops.push([pathOf("shaders", key)]);

  // In, each on its home, from its branch: as the build previewed (or
  // building), or the branch's head if none was asked for yet; switched as
  // you have it, and where you put it (just above the one under it), or on
  // top. The lowest first, so one is in before another goes above it (by its
  // edit's key). vibes builds each, and puts it in once built.
  for (const key of [...order].reverse()) {
    const a = d.added.find((x) => x.key === key);
    if (!a) continue;
    const layer = layerOfAdding(a, d);
    const under = order[order.indexOf(a.key) + 1];
    const add: AddSpec = {
      sketch: a.sketchId,
      branch: a.branch,
      ...(a.build && a.build.state !== "failed" ? { build: a.build.id } : {}),
      home: d.edits[a.key]?.home ?? a.home,
      muted: layer.muted,
      mask: layer.mask,
      ...(d.order ? { above: under ?? "" } : {}),
      pool: a.pool,
    };
    ops.push([pathOf("shaders", a.key), add]);
    if (a.declared) ops.push([pathOf("pools", a.pool, "declared"), a.declared]);
    ops.push(...paramOps(a.pool, a.declared, undefined, d.edits[a.key]?.params));
  }

  // On its way in, vibes keeps the change for when it goes in; gone since, or
  // being taken out, there's nothing left to change.
  for (const [key, patch] of Object.entries(d.edits)) {
    const shader = byKey.get(key);
    if (!shader || !changeable(shader) || d.removed.includes(key)) continue;
    if (homeDiffers(shader, patch.home)) ops.push([pathOf("shaders", key, "instance", "home"), patch.home!]);
    if (patch.muted !== undefined && patch.muted !== shader.muted) ops.push([pathOf("shaders", key, "muted"), patch.muted]);
    if (patch.mask !== undefined && !sameMask(patch.mask, shader.mask)) ops.push([pathOf("shaders", key, "mask"), patch.mask]);
    if (shader.pool) {
      const pool = scene.pools[shader.pool];
      ops.push(...paramOps(shader.pool, pool?.declared ?? null, pool?.values, patch.params));
    }
  }

  // The stack in your order, top first: vibes moves those in the room, places
  // those on their way in (and passes over any gone meanwhile, and leaves any
  // come since on top).
  if (d.order !== null && order.filter((k) => byKey.has(k)).join() !== sceneKeys(scene, d).join()) ops.push(["stack", order]);
  return ops;
}

/**
 * Make the room match the draft, in one update over the room socket.
 * Answered, the draft's done with, unless it's been edited since it was sent
 * (live mode sends again each time it changes, without waiting: the newest
 * send's answer, with nothing edited since, clears it). Refused, it stays
 * pending, to try again or discard, and why's thrown; whatever it does that's
 * the same as the room by then (made before it stopped) isn't pending any more.
 */
export async function applyDraft(scene: Scene): Promise<void> {
  const start = draft;
  const ops = opsOf(scene, start);
  let error: Error | null = null;
  let made: Record<string, ShaderKey> = {};
  if (ops.length > 0) {
    try {
      made = await sendUpdate(ops, start.roomtoneCode ?? undefined);
    } catch (err) {
      error = err as Error;
      if (err instanceof UpdateError) made = err.made;
    }
  }
  for (const [key, id] of Object.entries(made)) madeAs.set(key, id);
  // The tree showing what was made comes before the answer; with no answer
  // (the connection lost), it's looked at again. A sketch added is added
  // once: whatever went in comes out of the draft, however the draft changed
  // meanwhile (left in, live mode would put it in again, and again).
  if (error && !(error instanceof UpdateError)) await invalidateScene().catch(() => {});
  const added = new Set(Object.keys(made));
  if (!error && draft === start) set(EMPTY);
  else if (draft.added.some((a) => added.has(a.key))) set({ ...draft, added: draft.added.filter((a) => !added.has(a.key)) });
  if (error) throw error;
}
