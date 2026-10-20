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
import type { Instance, ShaderKey, ShaderSketch } from "../shared/vibes.ts";
import { request } from "./api.ts";
import { invalidateScene, type Scene, type SceneShader } from "./scene.ts";

/** A shader in the stack: vibes' key, for one in the room or on its way; "+…" for a sketch you're adding. */
export type LayerKey = ShaderKey;

export interface ShaderPatch {
  muted?: boolean;
  /** The lights it may not change: its whole mask. */
  mask?: number[];
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
  };
  const sketch: ShaderSketch = { id: a.sketchId, name: a.sketchName, commit, edited: false, deleted: false };
  const patch = d.edits[a.key] ?? {};
  return { key: a.key, stage: "adding", shader: null, name: a.sketchName, sketch, script, muted: patch.muted ?? false, mask: patch.mask ?? a.mask, by: "", instance, footprint: [], adding: a };
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
    if (l.muted !== l.shader!.muted || !sameMask(l.mask, l.shader!.mask)) n++;
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

const ignoreMissing = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    // Gone already (deleted by someone else): nothing left to do.
    if ((err as { status?: number }).status !== 404) throw err;
  }
};

/**
 * Make the room match the draft: room tone, then the shaders it takes out,
 * then each other shader's mute and mask, then the stack's order. A failure
 * part way leaves just the rest pending, and is thrown.
 */
export async function applyDraft(scene: Scene): Promise<void> {
  const start = draft;
  let d = draft;
  // What's left, kept here until the end: the preview holds steady meanwhile.
  const step = (next: Draft) => {
    d = next;
  };
  try {
    await sendDraft(scene, d, step);
  } finally {
    // Catch the scene up first, so the preview never drops a change before
    // the live room shows it. Edits made while the draft was being sent are
    // kept: they only count where they still differ from the room. But a
    // sketch added is added once: whatever went in comes out of the draft,
    // however the draft changed meanwhile (left in, live mode would put it
    // in again, and again).
    await invalidateScene().catch(() => {});
    const added = new Set(start.added.filter((a) => !d.added.some((x) => x.key === a.key)).map((a) => a.key));
    set(draft === start ? d : { ...draft, added: draft.added.filter((a) => !added.has(a.key)) });
  }
}

async function sendDraft(scene: Scene, d: Draft, onStep: (next: Draft) => void) {
  const step = (next: Draft) => {
    d = next;
    onStep(next);
  };

  const tone = roomtoneChanges(scene, d);
  if (Object.keys(tone).length > 0) {
    await request("PUT", "/api/roomtone", { lights: tone, ...(d.roomtoneCode ? { code: d.roomtoneCode } : {}) });
  }
  step({ ...d, roomtone: {}, roomtoneCode: null });

  const byKey = new Map(scene.shaders.map((s) => [s.key, s]));
  // The whole stack as you'd have it, top first, sketches you're adding included.
  const order = layersOf(scene, d).map((l) => l.key);
  const reordered = d.order !== null && order.filter((k) => byKey.has(k)).join() !== sceneKeys(scene, d).join();

  // Out, with whatever else was pending for them.
  for (const key of d.removed) {
    if (byKey.has(key)) await ignoreMissing(request("DELETE", `/api/shaders/${key}`));
    step({ ...d, removed: d.removed.filter((k) => k !== key), edits: omit(d.edits, key) });
  }

  // In, each on its home, from its branch: as the build previewed (or
  // building), or the branch's head if none was asked for yet; switched as
  // you have it, and where you put it (just above the one under it), or on
  // top. The lowest first, so one is put in before another goes above it.
  // vibes builds each, and puts it in once built.
  const made = new Map<LayerKey, string>();
  const keyFor = (key: LayerKey) => (byKey.has(key) ? key : made.get(key));
  for (const key of [...order].reverse()) {
    const a = d.added.find((x) => x.key === key);
    if (!a) continue;
    const layer = layerOfAdding(a, d);
    const under = order.slice(order.indexOf(key) + 1).find((k) => keyFor(k) !== undefined);
    const instance = await request<Instance>("POST", "/api/instances", {
      sketch: a.sketchId,
      branch: a.branch,
      ...(a.build && a.build.state !== "failed" ? { build: a.build.id } : {}),
      home: a.home,
      key: a.key,
      muted: layer.muted,
      mask: layer.mask,
      ...(d.order ? { above: under ? keyFor(under) : "" } : {}),
    });
    made.set(a.key, instance.id);
    madeAs.set(a.key, instance.id);
    step({ ...d, added: d.added.filter((x) => x.key !== a.key), edits: omit(d.edits, a.key) });
  }

  // On its way in, vibes keeps the change for when it goes in; gone since,
  // there's nothing left to change.
  for (const [key, patch] of Object.entries(d.edits)) {
    const shader = byKey.get(key);
    const live = shader && changeable(shader) ? shader : null;
    const mute =
      live && patch.muted !== undefined && patch.muted !== live.muted
        ? () => ignoreMissing(request("POST", `/api/shaders/${key}/muted`, { muted: patch.muted }))
        : null;
    const mask =
      live && patch.mask !== undefined && !sameMask(patch.mask, live.mask)
        ? () => ignoreMissing(request("POST", `/api/shaders/${key}/mask`, { mask: patch.mask }))
        : null;
    // Unmuting, the mask goes first, so the shader never runs on lights it's
    // meant to stay off; muting, the mute does.
    for (const send of patch.muted === false ? [mask, mute] : [mute, mask]) if (send) await send();
    step({ ...d, edits: omit(d.edits, key) });
  }

  // The stack in your order, top first: vibes moves those in the room, places
  // those on their way in (and passes over any gone meanwhile, and leaves any
  // come since on top).
  if (reordered) await request("PUT", "/api/stack", { order: order.flatMap((k) => keyFor(k) ?? []) });
  step(EMPTY);
}
