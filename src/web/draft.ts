// Pending edits: changes made in vibes that haven't been applied to the room.
// While there are any, vibes is in simulated mode: the map shows what the room
// would do with them (sim.ts), Apply sends them to arclamp, and Discard throws
// them away. Each browser has its own; others keep seeing the live room.
//
// A draft records only what you changed, on top of whatever is live, so
// changes others make meanwhile still show through: room tone, each shader's
// mute, mask and place in the stack, the shaders taken out of it, and the
// sketches being put in (each on its home, previewed once built). A shader
// on its way in, or one you're adding, is switched and moved like any other:
// vibes puts it in that way.
// It knows shaders by vibes' keys; which shader in arclamp each is, only
// vibes' server knows.

import { useSyncExternalStore } from "react";
import type { Channels } from "../shared/arclamp.ts";
import { cleanValues, patchValues, type ParamPatch, type ShaderParams } from "../shared/params.ts";
import type { Change, Instance, ShaderKey, ShaderSketch } from "../shared/vibes.ts";
import { ApplyError, applyChanges, invalidateScene, type Scene, type SceneShader } from "./scene.ts";

/** A shader in the stack: vibes' key, for one in the room or on its way; "+…" for a sketch you're adding. */
export type LayerKey = ShaderKey;

export interface ShaderPatch {
  muted?: boolean;
  /** The lights it may not change: its whole mask. */
  mask?: number[];
  /** Its params' values, by name: each a patch over the live values (for everywhere, or for some lights). */
  params?: Record<string, ParamPatch>;
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
  /** Its params, if it was put in from a sketch: what the sketch declares, and the instance's values (live, not pending edits). */
  params: ShaderParams | null;
}

/** A sketch being added, as a layer on top of the stack: for the preview (once built), and the list. */
function layerOfAdding(a: Adding, d: Draft): Layer {
  const script = a.build ? (addedScripts.get(a.build.id) ?? "") : "";
  const commit = a.build?.commit ?? "";
  const instance: Instance = {
    id: a.key,
    sketchId: a.sketchId,
    sketchName: a.sketchName,
    commit,
    buildId: a.build?.id ?? "",
    branch: a.branch,
    head: null,
    home: a.home,
    state: a.build?.state === "failed" ? "failed" : "building",
    error: a.build?.error ?? null,
    next: null,
    by: { id: "", name: "" },
    at: 0,
    params: {},
  };
  const sketch: ShaderSketch = { id: a.sketchId, name: a.sketchName, commit, edited: false, deleted: false };
  const patch = d.edits[a.key] ?? {};
  return { key: a.key, stage: "adding", shader: null, name: a.sketchName, sketch, script, muted: patch.muted ?? false, mask: patch.mask ?? a.mask, by: "", instance, footprint: [], adding: a, params: null };
}

/** Whether a shader can be switched and moved: any but one that couldn't go in. */
export const changeable = (layer: Pick<Layer, "stage">) => layer.stage !== "failed";

/**
 * The lights a shader is about: its instance's home, or, with none (put in
 * some other way), where its code has lit. A selection lists the shaders it
 * shares a light with.
 */
export const reachOf = (layer: Layer): readonly number[] => layer.instance?.home ?? layer.footprint;

/** What's become of a shader, if anything has: failing, restarting, updating, or couldn't update. */
export function statusOf(layer: Layer): string | null {
  const { shader, instance } = layer;
  if (shader?.state === "error") return "failing";
  if (shader?.state === "restarting") return "restarting";
  if (instance?.next?.state === "building") return `updating to ${instance.next.commit.slice(0, 7)}`;
  if (instance?.next?.state === "failed") return "couldn't update";
  return null;
}

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

/** The room tone template with the draft's values over the live one. */
export function templateOf(scene: Scene, d: Draft): Record<string, Channels> {
  const base = scene.roomtone?.lights ?? {};
  const out: Record<string, Channels> = { ...base };
  for (const [id, ch] of Object.entries(d.roomtone)) out[id] = { ...out[id], ...ch };
  return out;
}

/** A shader's params with the draft's patches over its live values. */
function paramsWith(params: ShaderParams | null, patches: Record<string, ParamPatch> | undefined): ShaderParams | null {
  if (!params || !patches) return params;
  const values = { ...params.values };
  for (const spec of params.specs) {
    const p = patches[spec.name];
    if (p) values[spec.name] = patchValues(spec, values[spec.name], p);
  }
  return { specs: params.specs, values };
}

/** Whether the draft's patches change a shader's params at all. */
function paramsDiffer(shader: SceneShader, patches: Record<string, ParamPatch> | undefined): boolean {
  return paramChanges(shader, patches).length > 0;
}

/** The params the draft's patches actually change, as changes to send. */
function paramChanges(shader: SceneShader, patches: Record<string, ParamPatch> | undefined): Change[] {
  const params = shader.params;
  if (!params || !patches) return [];
  return Object.entries(patches).flatMap(([name, patch]) => {
    const spec = params.specs.find((s) => s.name === name);
    if (!spec) return [];
    const was = cleanValues(spec, params.values[name] ?? {});
    return JSON.stringify(patchValues(spec, was, patch)) === JSON.stringify(was) ? [] : [{ op: "params", key: shader.key, name, patch } as Change];
  });
}

function layerOfShader(shader: SceneShader, d: Draft): Layer {
  const patch = changeable(shader) ? (d.edits[shader.key] ?? {}) : {};
  return {
    key: shader.key,
    stage: shader.stage,
    shader,
    name: shader.name,
    sketch: shader.sketch,
    script: shader.script ?? "",
    muted: patch.muted ?? shader.muted,
    mask: patch.mask ?? shader.mask,
    by: shader.by,
    instance: shader.instance,
    footprint: shader.footprint,
    adding: null,
    params: paramsWith(shader.params, patch.params),
  };
}

/** One shader with the draft's edits (even one the draft takes out), or one you're adding; null if there's no such shader. */
export function layerOf(scene: Scene, d: Draft, key: LayerKey): Layer | null {
  const shader = scene.shaders.find((s) => s.key === key);
  if (shader) return layerOfShader(shader, d);
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
  for (const s of scene.shaders) if (!removed.has(s.key)) layers.set(s.key, layerOfShader(s, d));
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
    if (l.muted !== l.shader!.muted || !sameMask(l.mask, l.shader!.mask) || paramsDiffer(l.shader!, d.edits[l.key]?.params)) n++;
  }
  if (layers.map((l) => l.key).join() !== sceneKeys(scene, d).join()) n++;
  return n;
}

/** The shaders the draft takes out that are still there. */
export function removedOf(scene: Scene, d: Draft): LayerKey[] {
  const here = new Set(scene.shaders.map((s) => s.key));
  return d.removed.filter((k) => here.has(k));
}

// arclamp keeps channels as float32, so that's as close as a value can match.
const same = (a: number | undefined, b: number) => a !== undefined && Math.fround(a) === Math.fround(b);

/** The room tone values the draft actually changes. */
export function roomtoneChanges(scene: Scene, d: Draft): Record<string, Channels> {
  const base = scene.roomtone?.lights ?? {};
  const out: Record<string, Channels> = {};
  for (const [id, ch] of Object.entries(d.roomtone)) {
    const diff = Object.fromEntries(Object.entries(ch).filter(([name, v]) => !same(base[id]?.[name], v)));
    if (Object.keys(diff).length > 0) out[id] = diff;
  }
  return out;
}

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
      // Saved before sketches being added had a branch: all of them were main.
      added: saved.added.map((a) => ({ ...a, branch: a.branch ?? "main" })),
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
  /** Change a param of a shader: for everywhere (all), or for some lights, over whatever's pending for it already. */
  setParam(key: LayerKey, name: string, patch: ParamPatch) {
    const was = draft.edits[key]?.params?.[name] ?? {};
    const lights = patch.lights === null ? null : patch.lights ? { ...(was.lights ?? {}), ...patch.lights } : was.lights;
    const merged: ParamPatch = { ...was, ...patch, ...(lights !== undefined ? { lights } : {}) };
    set({ ...draft, edits: { ...draft.edits, [key]: { ...draft.edits[key], params: { ...draft.edits[key]?.params, [name]: merged } } } });
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
   * key, which vibes is sent with it, to put it in once however often it's sent.
   */
  add(a: Pick<Adding, "sketchId" | "sketchName" | "branch" | "home" | "mask">): LayerKey {
    const key = `+${crypto.randomUUID()}`;
    set({ ...draft, added: [...draft.added, { ...a, key, build: null }] });
    return key;
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

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const out = { ...record };
  delete out[key];
  return out;
}

/**
 * Make the room match the draft, in one apply over the room socket: room
 * tone, then the shaders it takes out, then the sketches it adds, then each
 * other shader's mute and mask, then the stack's order. Refused part way,
 * just the rest stays pending, and it's thrown.
 */
export async function applyDraft(scene: Scene): Promise<void> {
  const start = draft;
  const { rest: d, error } = await sendDraft(scene, start);
  // The scene showing what was made comes before the answer; with no answer
  // (the connection lost), it's looked at again. Edits made while the draft
  // was being sent are kept: they only count where they still differ from
  // the room. But a sketch added is added once: whatever went in comes out
  // of the draft, however the draft changed meanwhile (left in, live mode
  // would put it in again, and again).
  if (error && !(error instanceof ApplyError)) await invalidateScene().catch(() => {});
  const added = new Set(start.added.filter((a) => !d.added.some((x) => x.key === a.key)).map((a) => a.key));
  set(draft === start ? d : { ...draft, added: draft.added.filter((a) => !added.has(a.key)) });
  if (error) throw error;
}

/**
 * The draft's changes, sent as one apply; what's left of the draft after
 * (nothing, unless the apply was refused part way, or not answered), and why.
 */
async function sendDraft(scene: Scene, d: Draft): Promise<{ rest: Draft; error: Error | null }> {
  // Each change, with what's left of the draft once it's made.
  const changes: Change[] = [];
  const rests: Draft[] = [];
  let rest = d;
  const then = (next: Draft, change?: Change) => {
    rest = next;
    if (!change) return;
    changes.push(change);
    rests.push(next);
  };

  const tone = roomtoneChanges(scene, d);
  then({ ...rest, roomtone: {}, roomtoneCode: null }, Object.keys(tone).length > 0 ? { op: "roomtone", lights: tone, ...(d.roomtoneCode ? { code: d.roomtoneCode } : {}) } : undefined);

  const byKey = new Map(scene.shaders.map((s) => [s.key, s]));
  // The whole stack as you'd have it, top first, sketches you're adding included.
  const order = layersOf(scene, d).map((l) => l.key);

  // Out, with whatever else was pending for them.
  for (const key of d.removed) {
    then({ ...rest, removed: rest.removed.filter((k) => k !== key), edits: omit(rest.edits, key) }, byKey.has(key) ? { op: "remove", key } : undefined);
  }

  // In, each on its home, from its branch: as the build previewed (or
  // building), or the branch's head if none was asked for yet; switched as
  // you have it, and where you put it (just above the one under it), or on
  // top. The lowest first, so one is in before another goes above it (by its
  // edit's key). vibes builds each, and puts it in once built.
  for (const key of [...order].reverse()) {
    const a = d.added.find((x) => x.key === key);
    if (!a) continue;
    const layer = layerOfAdding(a, d);
    const under = order[order.indexOf(key) + 1];
    then(
      { ...rest, added: rest.added.filter((x) => x.key !== a.key), edits: omit(rest.edits, a.key) },
      {
        op: "add",
        key: a.key,
        sketch: a.sketchId,
        branch: a.branch,
        ...(a.build && a.build.state !== "failed" ? { build: a.build.id } : {}),
        home: a.home,
        muted: layer.muted,
        mask: layer.mask,
        ...(d.order ? { above: under ?? "" } : {}),
      },
    );
  }

  // On its way in, vibes keeps the change for when it goes in; gone since,
  // there's nothing left to change.
  for (const [key, patch] of Object.entries(rest.edits)) {
    const shader = byKey.get(key);
    const target = shader && changeable(shader) ? shader : null;
    const mute: Change | null = target && patch.muted !== undefined && patch.muted !== target.muted ? { op: "muted", key, muted: patch.muted } : null;
    const mask: Change | null = target && patch.mask !== undefined && !sameMask(patch.mask, target.mask) ? { op: "mask", key, mask: patch.mask } : null;
    // Unmuting, the mask goes first, so the shader never runs on lights it's
    // meant to stay off; muting, the mute does. Its params after.
    const sends = [...(patch.muted === false ? [mask, mute] : [mute, mask]).filter((c) => c !== null), ...(target ? paramChanges(target, patch.params) : [])];
    for (const [i, change] of sends.entries()) then(i === sends.length - 1 ? { ...rest, edits: omit(rest.edits, key) } : rest, change);
    if (sends.length === 0) then({ ...rest, edits: omit(rest.edits, key) });
  }

  // The stack in your order, top first: vibes moves those in the room, places
  // those on their way in (and passes over any gone meanwhile, and leaves any
  // come since on top).
  if (d.order !== null && order.filter((k) => byKey.has(k)).join() !== sceneKeys(scene, d).join()) then(EMPTY, { op: "stack", order });

  if (changes.length === 0) return { rest: EMPTY, error: null };
  try {
    for (const [key, id] of Object.entries(await applyChanges(changes))) madeAs.set(key, id);
    return { rest: EMPTY, error: null };
  } catch (err) {
    if (!(err instanceof ApplyError)) return { rest: d, error: err as Error };
    for (const [key, id] of Object.entries(err.made)) madeAs.set(key, id);
    return { rest: err.at > 0 ? rests[err.at - 1]! : d, error: err };
  }
}
