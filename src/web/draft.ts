// Pending edits: changes made in vibes that haven't been applied to the room.
// While there are any, vibes is in simulated mode: the map shows what the room
// would do with them (sim.ts), Apply sends them to arclamp, and Discard throws
// them away. Each browser has its own; others keep seeing the live room.
//
// A draft records only what you changed, on top of whatever is live, so
// changes others make meanwhile still show through: room tone, each shader's
// mute, mask and place in the stack, and the shaders taken out of it.

import { useSyncExternalStore } from "react";
import type { Channels } from "../shared/arclamp.ts";
import type { Instance, SceneNode } from "../shared/vibes.ts";
import { request } from "./api.ts";
import { invalidateScene } from "./scene.ts";

/** A shader in the stack: "#12" for arclamp's shader 12. */
export type LayerKey = string;

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
  /** Shaders to take out of the room (only vibes' own can be). */
  removed: LayerKey[];
}

export const EMPTY: Draft = { roomtone: {}, roomtoneCode: null, edits: {}, order: null, removed: [] };

export const keyOf = (id: number): LayerKey => `#${id}`;
export const idOf = (key: LayerKey): number => Number(key.slice(1));

/** A shader as the stack shows it: live, with the draft's edits. */
export interface Layer {
  key: LayerKey;
  /** arclamp's id. */
  id: number;
  /** The live shader, for its state and errors. */
  node: SceneNode;
  name: string;
  script: string;
  muted: boolean;
  /** The lights it may not change (there its output is its input), sorted. */
  mask: number[];
  /** Who made it, as arclamp has it (the name of the key it was made with). */
  by: string;
  /** The instance it is, if it was put in from a sketch in vibes: its home is all it can light. */
  instance: Instance | null;
  /** Where its code has lit: every light it's changed, before its mask or mute. */
  footprint: number[];
}

/**
 * The lights a shader is about: its instance's home, or, with none (put in
 * some other way), where its code has lit. A selection lists the shaders it
 * shares a light with.
 */
export const reachOf = (layer: Layer): readonly number[] => layer.instance?.home ?? layer.footprint;

/** What's become of a shader, if anything has: failing, restarting, updating, or couldn't update. */
export function statusOf(layer: Layer): string | null {
  const { node, instance } = layer;
  if (node.state === "error") return "failing";
  if (node.state === "restarting") return "restarting";
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

const liveShaders = (live: SceneNode[]) => live.filter((n) => n.type === "js").sort((a, b) => b.position - a.position);

/** The room tone template with the draft's values over the live one. */
export function templateOf(live: SceneNode[], d: Draft): Record<string, Channels> {
  const base = live.find((n) => n.type === "roomtone")?.template?.lights ?? {};
  const out: Record<string, Channels> = { ...base };
  for (const [id, ch] of Object.entries(d.roomtone)) out[id] = { ...out[id], ...ch };
  return out;
}

function layerOfNode(node: SceneNode, d: Draft): Layer {
  const key = keyOf(node.id);
  const patch = d.edits[key] ?? {};
  return {
    key,
    id: node.id,
    node,
    // Built from a sketch: the sketch's name (by the shader's stamp).
    name: node.sketch ? (node.sketch.name ?? "Unknown sketch") : `Shader #${node.id}`,
    script: node.script ?? "",
    muted: patch.muted ?? node.muted,
    mask: patch.mask ?? node.mask ?? [],
    by: node.created_by,
    instance: node.instance ?? null,
    footprint: node.footprint ?? [],
  };
}

/** One live shader with the draft's edits, even one the draft takes out; null if it isn't live. */
export function layerOf(live: SceneNode[], d: Draft, key: LayerKey): Layer | null {
  const node = liveShaders(live).find((n) => keyOf(n.id) === key);
  return node ? layerOfNode(node, d) : null;
}

/** The stack with the draft applied, top first: without the shaders it takes out. */
export function layersOf(live: SceneNode[], d: Draft): Layer[] {
  const layers = new Map<LayerKey, Layer>();
  const removed = new Set(d.removed);
  for (const node of liveShaders(live)) {
    const key = keyOf(node.id);
    if (!removed.has(key)) layers.set(key, layerOfNode(node, d));
  }
  // Your order where you set one; anything that turned up live since keeps
  // its live place relative to the top.
  const live0 = [...layers.keys()];
  const ordered = (d.order ?? live0).filter((k) => layers.has(k));
  const missing = live0.filter((k) => !ordered.includes(k));
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
export function pendingCount(live: SceneNode[], d: Draft): number {
  const layers = layersOf(live, d);
  let n = Object.keys(roomtoneChanges(live, d)).length > 0 ? 1 : 0;
  n += removedOf(live, d).length;
  for (const l of layers) {
    if (l.muted !== l.node.muted || !sameMask(l.mask, l.node.mask ?? [])) n++;
  }
  const liveOrder = liveShaders(live)
    .map((n) => keyOf(n.id))
    .filter((k) => !d.removed.includes(k));
  if (layers.map((l) => l.key).join() !== liveOrder.join()) n++;
  return n;
}

/** The shaders the draft takes out that are still in the room. */
export function removedOf(live: SceneNode[], d: Draft): LayerKey[] {
  const here = new Set(liveShaders(live).map((n) => keyOf(n.id)));
  return d.removed.filter((k) => here.has(k));
}

// arclamp keeps channels as float32, so that's as close as a value can match.
const same = (a: number | undefined, b: number) => a !== undefined && Math.fround(a) === Math.fround(b);

/** The room tone values the draft actually changes. */
export function roomtoneChanges(live: SceneNode[], d: Draft): Record<string, Channels> {
  const base = live.find((n) => n.type === "roomtone")?.template?.lights ?? {};
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
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as Partial<Draft>) } : EMPTY;
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
export async function applyDraft(live: SceneNode[]): Promise<void> {
  const start = draft;
  let d = draft;
  // What's left, kept here until the end: the preview holds steady meanwhile.
  const step = (next: Draft) => {
    d = next;
  };
  try {
    await sendDraft(live, d, step);
  } finally {
    // Catch the scene up first, so the preview never drops a change before
    // the live room shows it. Edits made while the draft was being sent are
    // kept: they only count where they still differ from the room.
    await invalidateScene().catch(() => {});
    set(draft === start ? d : draft);
  }
}

async function sendDraft(live: SceneNode[], d: Draft, onStep: (next: Draft) => void) {
  const step = (next: Draft) => {
    d = next;
    onStep(next);
  };

  const tone = roomtoneChanges(live, d);
  if (Object.keys(tone).length > 0) {
    await request("PUT", "/api/roomtone", { lights: tone, ...(d.roomtoneCode ? { code: d.roomtoneCode } : {}) });
  }
  step({ ...d, roomtone: {}, roomtoneCode: null });

  const order = layersOf(live, d).map((l) => l.key);

  // Out, with whatever else was pending for them.
  for (const key of d.removed) {
    if (live.some((n) => keyOf(n.id) === key)) await ignoreMissing(request("DELETE", `/api/shaders/${idOf(key)}`));
    step({ ...d, removed: d.removed.filter((k) => k !== key), edits: omit(d.edits, key) });
  }

  for (const [key, patch] of Object.entries(d.edits)) {
    const id = idOf(key);
    const node = live.find((n) => n.id === id);
    const mute =
      patch.muted !== undefined && patch.muted !== node?.muted
        ? () => ignoreMissing(request("POST", `/api/shaders/${id}/muted`, { muted: patch.muted }))
        : null;
    const mask =
      patch.mask !== undefined && !sameMask(patch.mask, node?.mask ?? [])
        ? () => ignoreMissing(request("POST", `/api/shaders/${id}/mask`, { mask: patch.mask }))
        : null;
    // Unmuting, the mask goes first, so the shader never runs on lights it's
    // meant to stay off; muting, the mute does.
    for (const send of patch.muted === false ? [mask, mute] : [mute, mask]) if (send) await send();
    step({ ...d, edits: omit(d.edits, key) });
  }

  // Positions count up from the bottom (the room tone is 0); placing them
  // bottom first leaves each one where it belongs.
  const want = order.map(idOf);
  const now = (await request<SceneNode[]>("GET", "/api/scene")).filter((n) => n.type === "js");
  const exists = new Set(now.map((n) => n.id));
  const final = want.filter((id) => exists.has(id));
  const current = now.sort((a, b) => b.position - a.position).map((n) => n.id);
  if (final.join() !== current.filter((id) => final.includes(id)).join()) {
    for (let i = final.length - 1; i >= 0; i--) {
      await request("POST", `/api/shaders/${final[i]}/position`, { position: final.length - i });
    }
  }
  step(EMPTY);
}
