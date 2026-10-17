// Pending edits: changes made in vibes that haven't been applied to the room.
// While there are any, vibes is in simulated mode: the map shows what the room
// would do with them (sim.ts), Apply sends them to arclamp, and Discard throws
// them away. Each browser has its own; others keep seeing the live room.
//
// A draft records only what you changed, on top of whatever is live, so
// changes others make meanwhile still show through.

import { useSyncExternalStore } from "react";
import type { Channels } from "../shared/arclamp.ts";
import type { SceneNode } from "../shared/vibes.ts";
import { invalidateScene, request } from "./api.ts";

/** A shader in the stack: "#12" for arclamp's shader 12, "new-…" for one not applied yet. */
export type LayerKey = string;

export interface ShaderPatch {
  name?: string;
  script?: string;
  muted?: boolean;
}

export interface NewShader {
  key: LayerKey;
  name: string;
  script: string;
  muted: boolean;
  /** Who wrote it, for the stack row. */
  by: string;
}

export interface Draft {
  /** Room tone channel values, by light id, over the live template. */
  roomtone: Record<string, Channels>;
  /** The last room tone choice's code, for the history. */
  roomtoneCode: string | null;
  edits: Record<LayerKey, ShaderPatch>;
  created: NewShader[];
  deleted: LayerKey[];
  /** The stack's order, top first, once you've reordered it. */
  order: LayerKey[] | null;
}

export const EMPTY: Draft = { roomtone: {}, roomtoneCode: null, edits: {}, created: [], deleted: [], order: null };

export const keyOf = (id: number): LayerKey => `#${id}`;
export const idOf = (key: LayerKey): number | null => (key.startsWith("#") ? Number(key.slice(1)) : null);

/** A shader as the stack shows it: live, or changed by the draft. */
export interface Layer {
  key: LayerKey;
  /** arclamp's id; null until a new shader is applied. */
  id: number | null;
  /** The live shader, for its author, state and errors; null for a new one. */
  node: SceneNode | null;
  name: string;
  script: string;
  muted: boolean;
  status: "live" | "new" | "edited" | "deleted";
  /** Who wrote it. */
  by: string;
}

const liveShaders = (live: SceneNode[]) => live.filter((n) => n.type === "js").sort((a, b) => b.position - a.position);

/** The room tone template with the draft's values over the live one. */
export function templateOf(live: SceneNode[], d: Draft): Record<string, Channels> {
  const base = live.find((n) => n.type === "roomtone")?.template?.lights ?? {};
  const out: Record<string, Channels> = { ...base };
  for (const [id, ch] of Object.entries(d.roomtone)) out[id] = { ...out[id], ...ch };
  return out;
}

/** The stack with the draft applied, top first. Deleted shaders stay in place, marked. */
export function layersOf(live: SceneNode[], d: Draft): Layer[] {
  const layers = new Map<LayerKey, Layer>();
  for (const node of liveShaders(live)) {
    const key = keyOf(node.id);
    const patch = d.edits[key] ?? {};
    const name = patch.name ?? node.meta?.name ?? `Shader #${node.id}`;
    const script = patch.script ?? node.script ?? "";
    const changed = (patch.name !== undefined && patch.name !== (node.meta?.name ?? `Shader #${node.id}`)) ||
      (patch.script !== undefined && patch.script !== node.script);
    layers.set(key, {
      key,
      id: node.id,
      node,
      name,
      script,
      muted: patch.muted ?? node.muted,
      status: d.deleted.includes(key) ? "deleted" : changed ? "edited" : "live",
      by: node.meta?.createdBy.name ?? node.created_by,
    });
  }
  for (const s of d.created) {
    layers.set(s.key, { key: s.key, id: null, node: null, name: s.name, script: s.script, muted: s.muted, status: "new", by: s.by });
  }
  // Your order where you set one; new shaders on top otherwise; anything that
  // turned up live since keeps its live place relative to the top.
  const live0 = liveShaders(live).map((n) => keyOf(n.id));
  const base = d.order ?? [...d.created.map((s) => s.key).reverse(), ...live0];
  const ordered = base.filter((k) => layers.has(k));
  const missing = [...layers.keys()].filter((k) => !ordered.includes(k));
  return [...missing, ...ordered].map((k) => layers.get(k)!);
}

/** How many separate changes the draft makes to what's live. */
export function pendingCount(live: SceneNode[], d: Draft): number {
  const layers = layersOf(live, d);
  let n = Object.keys(roomtoneChanges(live, d)).length > 0 ? 1 : 0;
  for (const l of layers) {
    if (l.status !== "live") n++;
    else if (l.node && l.muted !== l.node.muted) n++;
  }
  const liveOrder = liveShaders(live).map((n) => keyOf(n.id));
  const shown = layers.filter((l) => l.status !== "deleted" && l.status !== "new").map((l) => l.key);
  if (shown.join() !== liveOrder.filter((k) => shown.includes(k)).join()) n++;
  return n;
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

let nextNew = 0;

export const drafts = {
  setRoomtone(lights: Record<string, Channels>, code: string | null) {
    const roomtone = { ...draft.roomtone };
    for (const [id, ch] of Object.entries(lights)) roomtone[id] = { ...roomtone[id], ...ch };
    set({ ...draft, roomtone, roomtoneCode: code });
  },
  /** Change a shader's name, script or mute; new shaders change in place. */
  patchShader(key: LayerKey, patch: ShaderPatch) {
    if (draft.created.some((s) => s.key === key)) {
      set({ ...draft, created: draft.created.map((s) => (s.key === key ? { ...s, ...patch } : s)) });
    } else {
      set({ ...draft, edits: { ...draft.edits, [key]: { ...draft.edits[key], ...patch } } });
    }
  },
  createShader(name: string, script: string, by: string): LayerKey {
    const key = `new-${Date.now().toString(36)}-${nextNew++}`;
    set({ ...draft, created: [...draft.created, { key, name, script, muted: false, by }], order: draft.order && [key, ...draft.order] });
    return key;
  },
  deleteShader(key: LayerKey) {
    if (draft.created.some((s) => s.key === key)) {
      set({ ...draft, created: draft.created.filter((s) => s.key !== key), order: draft.order && draft.order.filter((k) => k !== key) });
    } else if (!draft.deleted.includes(key)) {
      set({ ...draft, deleted: [...draft.deleted, key] });
    }
  },
  restoreShader(key: LayerKey) {
    set({ ...draft, deleted: draft.deleted.filter((k) => k !== key) });
  },
  reorder(keysTopFirst: LayerKey[]) {
    set({ ...draft, order: keysTopFirst });
  },
  /** Delete every shader (admin's "clear all"). */
  clearAll(live: SceneNode[]) {
    const keys = liveShaders(live).map((n) => keyOf(n.id));
    set({ ...draft, created: [], deleted: [...new Set([...draft.deleted, ...keys])], order: null });
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
 * Make the room match the draft: room tone, then deletions, edits, new
 * shaders and the stack's order. A failure part way leaves just the rest
 * pending, and is thrown.
 */
export async function applyDraft(live: SceneNode[]): Promise<void> {
  let d = draft;
  // What's left, kept here until the end: the preview holds steady meanwhile.
  const step = (next: Draft) => {
    d = next;
  };
  try {
    await sendDraft(live, d, step);
  } finally {
    // Catch the scene up first, so the preview never drops a change before
    // the live room shows it.
    await invalidateScene().catch(() => {});
    set(d);
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

  // Fix the order now, so new shaders keep their place once they get ids.
  const order = layersOf(live, d)
    .filter((l) => l.status !== "deleted")
    .map((l) => l.key);

  for (const key of d.deleted) {
    await ignoreMissing(request("DELETE", `/api/shaders/${idOf(key)}`));
    step({ ...d, deleted: d.deleted.filter((k) => k !== key), edits: omit(d.edits, key) });
  }

  for (const [key, patch] of Object.entries(d.edits)) {
    const node = live.find((n) => n.id === idOf(key));
    const id = idOf(key)!;
    const body: { name?: string; script?: string } = {};
    if (patch.name !== undefined && patch.name !== (node?.meta?.name ?? `Shader #${id}`)) body.name = patch.name;
    if (patch.script !== undefined && patch.script !== node?.script) body.script = patch.script;
    if (Object.keys(body).length > 0) await ignoreMissing(request("PUT", `/api/shaders/${id}`, body));
    if (patch.muted !== undefined && patch.muted !== node?.muted) {
      await ignoreMissing(request("POST", `/api/shaders/${id}/muted`, { muted: patch.muted }));
    }
    step({ ...d, edits: omit(d.edits, key) });
  }

  const ids = new Map<LayerKey, number>();
  for (const s of d.created) {
    const node = await request<SceneNode>("POST", "/api/shaders", { name: s.name, script: s.script });
    if (s.muted) await request("POST", `/api/shaders/${node.id}/muted`, { muted: true });
    ids.set(s.key, node.id);
    step({ ...d, created: d.created.filter((c) => c.key !== s.key) });
  }

  // Positions count up from the bottom (the room tone is 0); placing them
  // bottom first leaves each one where it belongs.
  const want = order.map((k) => ids.get(k) ?? idOf(k)).filter((id): id is number => id !== null);
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
