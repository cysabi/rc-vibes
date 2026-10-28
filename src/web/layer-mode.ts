// The map about one layer: in focus (just its lights, everywhere) or its
// domain being edited (the map a shader selector, its lights picked in and
// out). One state, its two variants: entering one leaves the other, and
// they look alike (the layer's name in the focus blue, the map's window
// ringed and tinted in it, a pill in the HUD saying whose).
//
// In focus: the map shows only the layer's lights, and the panels, the
// groups and the selection only know of them (App.tsx). Its Domain's Focus
// button (the layers panel) starts it; pressed again, or Exit, it ends.
//
// Editing: the map shows the lights in the domain as edited as selected, and
// picking lights picks them in and out of it just as they're selected
// otherwise (a click, shift, a box: the same rules, RoomMap's
// selectionWith). Nothing changes until it's saved (from the pill), which
// makes the change a pending edit like any other. Discard, or Escape, lets
// it go: back to focus, if that's where it came from.

import { useSyncExternalStore } from "react";
import type { LayerKey } from "./draft.ts";

export type LayerMode =
  | { kind: "focus"; key: LayerKey }
  | {
      kind: "edit";
      key: LayerKey;
      /** The lights in the domain as edited so far (on every floor). */
      ids: ReadonlySet<number>;
      /** The lights it started with, to tell whether anything's changed. */
      was: ReadonlySet<number>;
      /** It was in focus first: done editing, back to that. */
      fromFocus: boolean;
    };

/** A domain being edited. */
export type DomainEdit = Extract<LayerMode, { kind: "edit" }>;

let mode: LayerMode | null = null;
const listeners = new Set<() => void>();

function set(next: LayerMode | null) {
  if (next === mode) return;
  mode = next;
  for (const l of listeners) l();
}

export const layerMode = {
  get: () => mode,

  /** Just this layer's lights, everywhere; null, every light again. */
  focus(key: LayerKey | null) {
    set(key === null ? null : { kind: "focus", key });
  },

  /** Start editing this layer's domain, from the lights it's on now (from focus, it goes back there after). */
  edit(key: LayerKey, ids: readonly number[]) {
    const was = new Set(ids);
    set({ kind: "edit", key, ids: was, was, fromFocus: mode?.kind === "focus" && mode.key === key });
  },

  /** The domain being edited, as it's to be now (a change to it, as a selection's: App.tsx). */
  update(ids: ReadonlySet<number>) {
    if (mode?.kind === "edit") set({ ...mode, ids });
  },

  /** Done editing (saved or not): back to focus if that's where it came from, else out. */
  endEdit() {
    if (mode?.kind !== "edit") return;
    set(mode.fromFocus ? { kind: "focus", key: mode.key } : null);
  },

  /** Out of either, for every light again. */
  exit() {
    set(null);
  },
};

export function useLayerMode(): LayerMode | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => mode,
  );
}

/** Whether a domain as edited isn't what it started as. */
export function domainChanged(edit: DomainEdit): boolean {
  return edit.ids.size !== edit.was.size || [...edit.ids].some((id) => !edit.was.has(id));
}
